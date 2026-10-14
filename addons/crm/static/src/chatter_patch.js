import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { useOnChange } from "@odoo/owl";
import { patch } from "@web/core/utils/patch";

/**
 * Offline, the chatter of a lead is read-only: its data comes from mail routes
 * that are never cached, and posting, following, uploading and scheduling need
 * the server. The chatter shows what it already has, issues no request (so no
 * uncaught connection error) and reloads once connectivity is back.
 */
patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // files dropped on a lead's chatter offline aren't uploaded
        const uploader = this.attachmentUploader;
        if (uploader) {
            const uploadFile = uploader.uploadFile;
            uploader.uploadFile = (...args) =>
                this.isCrmLeadReadonlyOffline ? Promise.resolve() : uploadFile.call(uploader, ...args);
        }
        useOnChange(
            () => [this.isCrmLeadReadonlyOffline],
            (readonly) => {
                if (readonly) {
                    this.state.composerType = false;
                } else if (this.state.thread?.model === "crm.lead") {
                    this.load(this.state.thread, this.initialRequestList);
                }
            },
            { initialRun: false }
        );
    },

    /** Whether this is a lead's chatter while offline. */
    get isCrmLeadReadonlyOffline() {
        return this.threadModel() === "crm.lead" && this.crmOffline.isOffline();
    },

    /** @override */
    async load(thread, requestList) {
        if (thread?.model === "crm.lead" && this.crmOffline.isOffline()) {
            return;
        }
        return super.load(...arguments);
    },

    /** @override */
    toggleComposer() {
        if (this.isCrmLeadReadonlyOffline) {
            return;
        }
        return super.toggleComposer(...arguments);
    },

    /** @override */
    async scheduleActivity() {
        if (this.isCrmLeadReadonlyOffline) {
            return;
        }
        return super.scheduleActivity(...arguments);
    },

    /** @override */
    async onClickAttachFile() {
        if (this.isCrmLeadReadonlyOffline) {
            return false;
        }
        return super.onClickAttachFile(...arguments);
    },
});
