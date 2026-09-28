import { ScheduledMessage } from "@mail/chatter/web/scheduled_message";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { AttachmentDeleteDialog } from "@mail/core/common/attachment_delete_dialog";
import { AttachmentList } from "@mail/core/common/attachment_list";
import { useAttachmentUploader } from "@mail/core/common/attachment_uploader_hook";
import { usePopoutAttachment } from "@mail/core/common/attachment_view";
import { MailAttachmentDropzone } from "@mail/core/common/mail_attachment_dropzone";
import { MessageCardList } from "@mail/core/common/message_card_list";
import { useMessageSearch } from "@mail/core/common/message_search_hook";
import { SearchMessageInput } from "@mail/core/common/search_message_input";
import { SearchMessageResult } from "@mail/core/common/search_message_result";
import { Activity } from "@mail/core/web/activity";
import { FollowerList } from "@mail/core/web/follower_list";
import { groupAttachments } from "@mail/utils/common/attachments";
import { assignGetter, isDragSourceExternalFile } from "@mail/utils/common/misc";

import { status, t, untrack, useEffect, useOnChange, useProps } from "@odoo/owl";

import { browser } from "@web/core/browser/browser";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { useDropdownState } from "@web/core/dropdown/dropdown_hooks";
import { useCustomDropzone } from "@web/core/dropzone/dropzone_hook";
import { _t } from "@web/core/l10n/translation";
import { rpc, rpcBus } from "@web/core/network/rpc";
import { isOfflineTempId } from "@web/core/offline/offline_plugin";
import { KeepLast } from "@web/core/utils/concurrency";
import { useBus, useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { Record } from "@web/model/relational_model/record";
import { FileUploader } from "@web/views/fields/file_handler";

const CHATTER_PANEL = Object.freeze({
    ATTACHMENT: "ATTACHMENT",
    NONE: "NONE",
    PINNED_MESSAGES: "PINNED_MESSAGES",
    SEARCH: "SEARCH",
});

export const DELAY_FOR_SPINNER = 1000;

Object.assign(Chatter.components, {
    Activity,
    AttachmentList,
    Dropdown,
    FileUploader,
    FollowerList,
    MessageCardList,
    ScheduledMessage,
    SearchMessageInput,
    SearchMessageResult,
});

/**
 * @type {import("@mail/chatter/web_portal_project/chatter").Chatter }
 * @typedef {Object} Props
 * @property {function} [close]
 */
const chatterPatch = {
    setup() {
        super.setup(...arguments);
        // bind once so the references stay stable across renders
        this.onActivityChanged = this.onActivityChanged.bind(this);
        this.reloadParentView = this.reloadParentView.bind(this);
        this.webChatterProps = useProps({
            close: t.function([]).optional(),
            has_activities: t.boolean().optional(true),
            hasAttachmentPreview: t.boolean().optional(false),
            hasParentReloadOnActivityChanged: t.boolean().optional(false),
            hasParentReloadOnAttachmentsChanged: t.boolean().optional(false),
            hasParentReloadOnFollowersUpdate: t.boolean().optional(false),
            hasParentReloadOnMessagePosted: t.boolean().optional(false),
            isAttachmentBoxVisibleInitially: t.boolean().optional(false),
            isChatterAside: t.boolean().optional(false),
            isInFormSheetBg: t.boolean().optional(true),
            record: t.instanceOf(Record).optional(),
            saveRecord: t.function([]).optional(),
        });
        // When there's no highlight in the URL (e.g. the record was opened in a new
        // window from the messaging menu), fall back to the one carried by the action
        // context.
        this.highlightMessage ??= this.webChatterProps.record?.context?.highlight_message_id;
        this.orm = useService("orm");
        this.keepLastSuggestedRecipientsUpdate = new KeepLast();
        useEffect(() => {
            const record = this.webChatterProps.record;
            // Track the record identity + all of its field changes.
            if (record?.data) {
                Object.keys(record.data).forEach((field) => record.data[field]);
            }
            untrack(() => this.updateRecipients(record));
        });
        this.attachmentPopout = usePopoutAttachment({ thread: this.thread });
        this.CHATTER_PANEL = CHATTER_PANEL;
        Object.assign(this.state, {
            activePanel: this.webChatterProps.isAttachmentBoxVisibleInitially
                ? CHATTER_PANEL.ATTACHMENT
                : CHATTER_PANEL.NONE,
            composerType: false,
            isSelectingAttachments: false,
            /** @type {number[]} ids of the attachments standing for the selected groups */
            selectedAttachmentIds: [],
            showActivities: true,
            showAttachmentLoading: false,
            showScheduledMessages: true,
        });
        this.dialog = useService("dialog");
        this._syncedMessagePosts = [];
        useBus(rpcBus, "OFFLINE-SYNC", (ev) => this._onOfflineMessageSynced(ev.detail));
        this.messageSearch = useMessageSearch();
        this.attachmentUploader = useAttachmentUploader(this.thread);
        this.followerListDropdown = useDropdownState();
        /** @type {number|null} */
        this.loadingAttachmentTimeout = null;
        /** @type {Map<string, Function>} */
        this.uploadHandlers = new Map();
        useCustomDropzone(
            this.rootRef,
            MailAttachmentDropzone,
            {
                extraClass: "o-mail-Chatter-dropzone",
                /** @param {Event} ev */
                onDrop: async (ev) => {
                    if (this.state.composerType) {
                        return;
                    }
                    if (isDragSourceExternalFile(ev.dataTransfer)) {
                        const files = [...ev.dataTransfer.files];
                        if (!this.state.thread.id) {
                            const saved = await this.webChatterProps.saveRecord?.();
                            if (!saved) {
                                return;
                            }
                        }
                        Promise.all(
                            files.map((file) => this.attachmentUploader.uploadFile(file))
                        ).then(() => {
                            if (this.hasParentReloadOnAttachmentsChanged) {
                                this.reloadParentView();
                            }
                        });
                        this.state.activePanel = CHATTER_PANEL.ATTACHMENT;
                    }
                },
            },
            () =>
                (!this.store.meetingViewOpened || this.env.inMeetingView) &&
                (this.thread()?.isTransient || this.thread()?.canPostMessage) &&
                !this.thread()?.messageInEdition?.composer?.isEditComposerVisible
        );
        useOnChange(
            () => [this.thread(), this.thread()?.isLoadingAttachments],
            (thread) => {
                if (!thread) {
                    return;
                }
                browser.clearTimeout(this.loadingAttachmentTimeout);
                if (thread.isLoadingAttachments) {
                    this.loadingAttachmentTimeout = browser.setTimeout(
                        () => (this.state.showAttachmentLoading = true),
                        DELAY_FOR_SPINNER
                    );
                } else {
                    this.state.showAttachmentLoading = false;
                    if (
                        this.state.activePanel !== CHATTER_PANEL.ATTACHMENT &&
                        this.webChatterProps.isAttachmentBoxVisibleInitially &&
                        this.attachments.length > 0
                    ) {
                        this.state.activePanel = CHATTER_PANEL.ATTACHMENT;
                    }
                }
                return () => browser.clearTimeout(this.loadingAttachmentTimeout);
            }
        );
        useOnChange(
            () => [this.thread()?.status, this.attachments.length],
            (status, attachmentsLength) => {
                if (
                    !["new", "loading"].includes(status) &&
                    attachmentsLength === 0 &&
                    this.state.activePanel === CHATTER_PANEL.ATTACHMENT
                ) {
                    this.state.activePanel = CHATTER_PANEL.NONE;
                }
            }
        );
    },

    async updateRecipients(record, mode = this.state.composerType) {
        if (!record) {
            return;
        }
        const partnerIds = []; // Ensure that we don't have duplicates
        let email;
        (this.state.thread?.partner_fields ?? []).forEach((field) => {
            const value = record._changes[field];
            if (record.data[field] !== undefined && value) {
                partnerIds.push(value.id);
            }
        });
        const field = this.state.thread?.primary_email_field;
        if (field) {
            const value = record._changes[field];
            if (record.data[field] !== undefined && value) {
                email = value;
            }
        }
        if ((!partnerIds.length && !email) || mode !== "message" || status(this) === "destroyed") {
            return;
        }
        const recipients = await this.keepLastSuggestedRecipientsUpdate.add(
            rpc("/mail/thread/recipients/get_suggested_recipients", {
                thread_model: this.thread().model,
                thread_id: this.thread().id,
                partner_ids: partnerIds,
                main_email: email,
            })
        );
        if (status(this) === "destroyed" && !this.state.thread) {
            return;
        }
        this.state.thread.suggestedRecipients = recipients.map((result) => ({
            display_name: result.display_name,
            email: result.email,
            partner_id: result.partner_id,
            name: result.name || result.email,
            recipient_type: result.recipient_type,
        }));
        this.state.thread.additionalRecipients = this.state.thread.additionalRecipients.filter(
            (additionalRecipient) =>
                this.state.thread.suggestedRecipients.every(
                    (suggestedRecipient) =>
                        suggestedRecipient.partner_id !== additionalRecipient.partner_id
                )
        );
    },

    /**
     * @returns {import("models").Activity[]}
     */
    get activities() {
        return this.state.thread?.sortedActivities ?? [];
    },

    get afterPostRequestList() {
        return [
            ...super.afterPostRequestList,
            "followers",
            "scheduledMessages",
            "suggestedRecipients",
            "suggestedSubject",
        ];
    },

    /**
     * Copies of a same file are grouped in the attachment box, where an image
     * repeated on every message would otherwise bury the relevant files.
     */
    get attachmentGroups() {
        return groupAttachments(this.attachments, { byContent: true });
    },

    get attachments() {
        return this.state.thread?.sortedAttachments ?? [];
    },

    /** Shows the amount of selected files, to confirm the selection at a glance. */
    get deleteSelectedAttachmentsLabel() {
        const count = this.state.selectedAttachmentIds.length;
        if (count === 1) {
            return _t("Delete 1 file");
        }
        return _t("Delete %(count)s files", { count });
    },

    get subEnv() {
        const res = super.subEnv;
        assignGetter(res.inChatter, { aside: () => this.webChatterProps.isChatterAside });
        Object.assign(res.inChatter, { toggleComposer: this.toggleComposer.bind(this) });
        return res;
    },

    get followerButtonLabel() {
        return _t("Show Followers");
    },

    get followingText() {
        return _t("Following");
    },
    get hasPinnedMessages() {
        return (
            this.state.thread?.has_pinned_messages || this.state.thread?.pinnedMessages?.length > 0
        );
    },
    /**
     * @returns {boolean}
     */
    get isDisabled() {
        return !this.state.thread.id || !this.state.thread?.hasReadAccess;
    },

    get requestList() {
        return [
            ...super.requestList,
            "activities",
            "attachments",
            "contact_fields",
            "defaultSubject",
            "followers",
            "has_pinned_messages",
            "scheduledMessages",
            "showSubjectInSmallComposer",
            "suggestedRecipients",
            "suggestedSubject",
        ];
    },

    get scheduledMessages() {
        return this.state.thread?.sortedScheduledMessages ?? [];
    },

    get selectedAttachmentGroups() {
        return this.attachmentGroups.filter((group) =>
            this.state.selectedAttachmentIds.includes(group.attachment.id)
        );
    },

    get selectedAttachments() {
        return this.selectedAttachmentGroups.map((group) => group.attachment);
    },

    changeThread(threadModel, threadId) {
        this._carryOfflineMessages(this.state.thread, threadModel, threadId);
        super.changeThread(...arguments);
        this.discardAttachmentSelection();
        if (threadId === false) {
            this.state.composerType = false;
            // Leaving the unsaved record. Do not open the composer or activity
            // dialog on whatever record is shown next.
            this.onThreadCreated = null;
            this._pendingThreadRecord = undefined;
        } else {
            if (this._shouldOpenPendingThread(threadId)) {
                this.onThreadCreated(this.state.thread);
            }
            this.onThreadCreated = null;
            this._pendingThreadRecord = undefined;
            this.messageSearch.thread = this.state.thread;
            this.closeSearch();
            this._reloadSyncedMessages();
        }
    },

    /**
     * Pending notes live on the placeholder thread. Moving them keeps them
     * visible when the form switches to the server id.
     */
    _carryOfflineMessages(previous, threadModel, threadId) {
        if (
            !previous ||
            !isOfflineTempId(previous.id) ||
            !threadId ||
            threadId === previous.id ||
            previous.model !== threadModel
        ) {
            return;
        }
        const next = this.store["mail.thread"].insert({ model: threadModel, id: threadId });
        const pending = [...previous.messages].filter(
            (message) => message.isPending && !message.is_transient
        );
        for (const message of pending) {
            const index = previous.messages.findIndex((item) => item.eq(message));
            if (index !== -1) {
                previous.messages.splice(index, 1);
            }
            message.res_id = threadId;
            message.thread = next;
            if (next.messages.findIndex((item) => item.eq(message)) === -1) {
                next.messages.push(message);
            }
        }
    },

    _onOfflineMessageSynced(detail) {
        if (detail?.route !== "/mail/message/post") {
            return;
        }
        const params = detail.params || {};
        if (!params.thread_model || !params.thread_id) {
            return;
        }
        this._syncedMessagePosts.push({
            thread_model: params.thread_model,
            thread_id: params.thread_id,
            temporary_id: params.context?.temporary_id,
        });
        this._reloadSyncedMessages();
    },

    _reloadSyncedMessages() {
        const thread = this.state.thread;
        if (!thread || isOfflineTempId(thread.id) || !this._syncedMessagePosts.length) {
            return;
        }
        const matches = this._syncedMessagePosts.filter(
            (entry) => entry.thread_model === thread.model && entry.thread_id === thread.id
        );
        if (!matches.length) {
            return;
        }
        this._syncedMessagePosts = this._syncedMessagePosts.filter(
            (entry) => !matches.includes(entry)
        );
        this._applySyncedMessages(thread, matches);
    },

    async _applySyncedMessages(thread, matches) {
        const known = new Set(thread.persistentMessages.map((message) => message.id));
        if (thread.status === "loading") {
            await thread.isLoadedPromise;
        }
        if (!this.state.thread?.eq(thread)) {
            return;
        }
        await thread.fetchNewMessages();
        if (!this.state.thread?.eq(thread)) {
            return;
        }
        const arrived = [...thread.persistentMessages].some((message) => !known.has(message.id));
        if (!arrived) {
            return;
        }
        for (const { temporary_id } of matches) {
            if (temporary_id === undefined) {
                continue;
            }
            const tmp = this.store["mail.message"].get(temporary_id);
            if (!tmp) {
                continue;
            }
            const index = thread.messages.findIndex((item) => item.eq(tmp));
            if (index !== -1) {
                thread.messages.splice(index, 1);
            }
            tmp.delete();
        }
    },

    /**
     * A failed save keeps the callback for this record only. A later thread
     * whose id is not this record's id belongs to another lead.
     */
    _shouldOpenPendingThread(threadId) {
        if (!this.onThreadCreated) {
            return false;
        }
        if (!this._pendingThreadRecord) {
            return true;
        }
        return this._pendingThreadRecord.resId === threadId;
    },

    closeSearch() {
        if (this.state.activePanel !== CHATTER_PANEL.SEARCH) {
            return;
        }
        this.messageSearch.reset();
        this.state.activePanel = CHATTER_PANEL.NONE;
    },

    discardAttachmentSelection() {
        this.state.isSelectingAttachments = false;
        this.state.selectedAttachmentIds = [];
    },

    /** @override */
    async load(thread, requestList) {
        await super.load(...arguments);
        if (!thread?.id || !this.state.thread?.eq(thread)) {
            return;
        }
        this.updateRecipients(this.webChatterProps.record);
    },

    onActivityChanged(thread) {
        this.load(thread, this.initialRequestList);
        if (this.webChatterProps.hasParentReloadOnActivityChanged) {
            this.reloadParentView();
        }
    },

    onAddFollowers() {
        this.load(this.state.thread, ["followers", "suggestedRecipients"]);
        if (this.webChatterProps.hasParentReloadOnFollowersUpdate) {
            this.reloadParentView();
        }
    },

    onClickAddAttachments() {
        this.closeSearch();
        if (this.attachments.length === 0) {
            return;
        }
        const isOpening = this.state.activePanel !== CHATTER_PANEL.ATTACHMENT;
        this.state.activePanel = isOpening ? CHATTER_PANEL.ATTACHMENT : CHATTER_PANEL.NONE;
        this.discardAttachmentSelection();
        if (isOpening) {
            this.rootRef().scrollTop = 0;
            this.state.thread.scrollTop = "bottom";
        }
    },

    async onClickAttachFile(ev) {
        if (this.state.thread.id) {
            return;
        }
        const saved = await this.webChatterProps.saveRecord?.();
        if (!saved) {
            return false;
        }
    },
    /**
     * Copies usually affect more than a single file, so deleting them one by
     * one is fastidious: this deletes them for every selected group at once.
     */
    onClickDeleteSelectedAttachments() {
        this.dialog.add(AttachmentDeleteDialog, {
            groups: this.selectedAttachmentGroups,
            onDelete: async (attachments) => {
                this.discardAttachmentSelection();
                await this.unlinkAttachments(attachments);
            },
        });
    },
    onClickPinnedMessages() {
        this.closeSearch();
        const isOpening = this.state.activePanel !== CHATTER_PANEL.PINNED_MESSAGES;
        this.state.activePanel = isOpening ? CHATTER_PANEL.PINNED_MESSAGES : CHATTER_PANEL.NONE;
        if (isOpening) {
            this.state.thread?.fetchPinnedMessages();
        }
    },
    onClickSearch() {
        this.state.activePanel =
            this.state.activePanel === CHATTER_PANEL.SEARCH
                ? CHATTER_PANEL.NONE
                : CHATTER_PANEL.SEARCH;
        this.state.composerType = false;
    },
    onClickSelectAttachments() {
        this.state.isSelectingAttachments = true;
        this.state.selectedAttachmentIds = [];
    },

    onCloseFullComposerCallback(isDiscard) {
        this.toggleComposer();
        super.onCloseFullComposerCallback();
        if (!isDiscard) {
            this.reloadParentView();
        }
    },

    /** @param {import("models").Thread} thread */
    onFollowerChanged(thread) {
        document.body.click(); // hack to close dropdown
        if (thread?.eq(this.state.thread)) {
            this.reloadParentView();
        }
    },

    onPostCallback() {
        if (this.hasParentReloadOnMessagePosted) {
            this.reloadParentView();
        }
        this.toggleComposer();
        super.onPostCallback();
    },

    /** @param {import("models").Thread} thread */
    onScheduledMessageChanged(thread) {
        // reload messages as well as a scheduled message could have been sent
        this.load(thread, ["scheduledMessages", "messages"]);
        // sending a message could trigger another action (eg. move so to quotation sent)
        this.reloadParentView();
    },

    onSuggestedRecipientAdded(thread) {
        this.load(thread, ["suggestedRecipients"]);
    },

    /** @param {import("models").Thread} thread */
    onUploaded({ thread } = {}) {
        const threadLocalId = thread.localId;
        if (!this.uploadHandlers.has(threadLocalId)) {
            const self = this;
            this.uploadHandlers.set(threadLocalId, async function handleUpload(data) {
                try {
                    await self.attachmentUploader.uploadData(data, { thread });
                    if (!thread.eq(self.state.thread)) {
                        return;
                    }
                    if (self.hasParentReloadOnAttachmentsChanged) {
                        self.reloadParentView();
                    }
                    self.state.activePanel = CHATTER_PANEL.ATTACHMENT;
                    if (self.rootRef()) {
                        self.rootRef().scrollTop = 0;
                    }
                    self.state.thread.scrollTop = "bottom";
                } finally {
                    self.uploadHandlers.delete(threadLocalId);
                }
            });
        }
        return this.uploadHandlers.get(threadLocalId);
    },

    async reloadParentView() {
        if (status(this) === "destroyed") {
            return;
        }
        await this.webChatterProps.saveRecord?.();
        if (this.webChatterProps.record) {
            await this.webChatterProps.record.load();
        }
    },

    /**
     * Save a new record, then run onReady once it has an id.
     * A failed save keeps the callback for this record. Discarding it or
     * opening another record clears the callback in changeThread.
     */
    async _openAfterRecordExists(onReady) {
        if (this.state.thread.id) {
            return onReady(this.state.thread);
        }
        if (!this.webChatterProps.saveRecord) {
            return;
        }
        const record = this.webChatterProps.record;
        this.onThreadCreated = onReady;
        this._pendingThreadRecord = undefined;
        const saved = await this.webChatterProps.saveRecord();
        if (!saved) {
            this._pendingThreadRecord = record;
            return;
        }
        const resId = this.webChatterProps.record?.resId;
        if (this.onThreadCreated && resId && !this.state.thread?.id) {
            this.changeThread(this.threadModel(), resId);
        } else if (this.onThreadCreated && this.state.thread?.id) {
            const pending = this.onThreadCreated;
            this.onThreadCreated = null;
            await pending(this.state.thread);
        }
    },

    async scheduleActivity() {
        this.closeSearch();
        const schedule = async (thread) => {
            await this.store.scheduleActivity(thread.model, [thread.id]);
            this.load(thread, ["activities", "messages"]);
            if (this.webChatterProps.hasParentReloadOnActivityChanged) {
                await this.reloadParentView();
            }
        };
        await this._openAfterRecordExists(schedule);
    },

    toggleActivities() {
        this.state.showActivities = !this.state.showActivities;
    },

    /** @param {import("models").Attachment} attachment */
    toggleAttachmentSelected(attachment) {
        const { selectedAttachmentIds } = this.state;
        this.state.selectedAttachmentIds = selectedAttachmentIds.includes(attachment.id)
            ? selectedAttachmentIds.filter((id) => id !== attachment.id)
            : [...selectedAttachmentIds, attachment.id];
    },

    toggleComposer(mode = false, { force = false } = {}) {
        this.closeSearch();
        const toggle = async () => {
            if (!force && this.state.composerType === mode) {
                this.state.composerType = false;
            } else {
                if (mode === "message") {
                    await this.updateRecipients(this.webChatterProps.record, mode);
                }
                this.state.composerType = mode;
            }
        };
        await this._openAfterRecordExists(toggle);
    },

    toggleScheduledMessages() {
        this.state.showScheduledMessages = !this.state.showScheduledMessages;
    },

    /** Trimming the attachment list of the record keeps the posted files on their message. */
    async unlinkAttachments(attachments) {
        await this.attachmentUploader.unlink(attachments, { keepOnMessages: true });
        if (this.hasParentReloadOnAttachmentsChanged) {
            this.reloadParentView();
        }
    },

    popoutAttachment() {
        this.attachmentPopout.popout();
    },

    get hasParentReloadOnMessagePosted() {
        return this.webChatterProps.hasParentReloadOnMessagePosted;
    },

    get hasParentReloadOnAttachmentsChanged() {
        return this.webChatterProps.hasParentReloadOnAttachmentsChanged;
    },
};
patch(Chatter.prototype, chatterPatch);
