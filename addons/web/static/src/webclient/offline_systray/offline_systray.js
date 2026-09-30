import { Component, computed, usePlugin } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useService } from "@web/core/utils/hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "../../core/l10n/translation";
import { formatDateTime } from "@web/core/l10n/dates";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

const { DateTime } = luxon;

const STATUS = {
    CREATED: { label: _t("Created"), color: 10 },
    EDITED: { label: _t("Edited"), color: 3 },
    ARCHIVED: { label: _t("Archived"), color: 2 },
    UNARCHIVED: { label: _t("Unarchived"), color: 4 },
    DELETED: { label: _t("Deleted"), color: 1 },
    WON: { label: _t("Won"), color: 10 },
    LOST: { label: _t("Lost"), color: 1 },
    RESTORED: { label: _t("Restored"), color: 4 },
    CONVERTED: { label: _t("Converted"), color: 3 },
    DUPLICATED: { label: _t("Duplicated"), color: 5 },
    MESSAGE: { label: _t("Message"), color: 8 },
    ACTIVITY: { label: _t("Activity"), color: 6 },
    ATTACHMENT: { label: _t("Attachment"), color: 7 },
    NAME_CREATE: { label: _t("Created related"), color: 9 },
    PENDING: { label: _t("Pending"), color: 3 },
};

function queueExtras(value) {
    return value.extras || {};
}

const METHOD_STATUS = {
    web_save: null, // handled specially
    unlink: STATUS.DELETED,
    web_unlink: STATUS.DELETED,
    action_archive: STATUS.ARCHIVED,
    action_unarchive: STATUS.UNARCHIVED,
    action_set_won: STATUS.WON,
    action_set_won_rainbowman: STATUS.WON,
    action_set_lost: STATUS.LOST,
    action_restore: STATUS.RESTORED,
    action_convert_to_opportunity: STATUS.CONVERTED,
    copy: STATUS.DUPLICATED,
    message_post: STATUS.MESSAGE,
    activity_schedule: STATUS.ACTIVITY,
    action_feedback: STATUS.ACTIVITY,
    name_create: STATUS.NAME_CREATE,
};

class OfflineSystray extends Component {
    static template = "web.OfflineSystray";
    static components = { Dropdown, DropdownItem };

    setup() {
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.notification = useService("notification");
        this.uiService = useService("ui");
    }

    groupEntries = computed(() => {
        const items = [];
        for (const { key, value } of Object.values(this.offlinePlugin._ormToSync())) {
            items.push(this._buildOrmItem(key, value));
        }
        for (const { key, value } of Object.values(this.offlinePlugin._httpToSync())) {
            items.push(this._buildHttpItem(key, value));
        }
        const sections = Object.entries(Object.groupBy(items, (item) => item.actionName || ""));
        sections.forEach(([_name, sectionItems]) => {
            sectionItems.sort(
                (itemA, itemB) => (itemA.timeStamp || 0) - (itemB.timeStamp || 0)
            );
        });
        return sections;
    });

    _buildOrmItem(key, value) {
        const extras = queueExtras(value);
        const timeStamp = extras.timeStamp
            ? formatDateTime(DateTime.fromMillis(extras.timeStamp))
            : "";
        const item = {
            id: key,
            kind: "orm",
            timeStamp: extras.timeStamp,
            actionName: extras.actionName,
            displayName: extras.displayName || value.model,
            clickable: this.isClickable(value),
            error: extras.error,
            canRetry: !!extras.error,
            tooltip: {
                timeStamp,
                records: extras.displayNames || [],
            },
            status: METHOD_STATUS[value.method] || STATUS.PENDING,
        };
        if (value.method === "web_save") {
            item.status = value.args[0].length ? STATUS.EDITED : STATUS.CREATED;
            item.tooltip.changes = Object.entries(extras.changes || {}).map(([k, v]) => [
                k,
                v?.display_name ?? v,
            ]);
            if (value.args[0].length && extras.originalValues) {
                item.tooltip.changes = item.tooltip.changes.map((c) => [
                    c[0],
                    extras.originalValues[c[0]]?.display_name ??
                        JSON.stringify(extras.originalValues[c[0]]),
                    c[1],
                ]);
            }
        }
        item.tooltip = JSON.stringify(item.tooltip);
        return item;
    }

    _buildHttpItem(key, value) {
        const extras = queueExtras(value);
        const timeStamp = extras.timeStamp
            ? formatDateTime(DateTime.fromMillis(extras.timeStamp))
            : "";
        let status = STATUS.PENDING;
        if (value.route.includes("message/post")) {
            status = STATUS.MESSAGE;
        } else if (value.route.includes("attachment")) {
            status = STATUS.ATTACHMENT;
        }
        return {
            id: key,
            kind: "http",
            timeStamp: extras.timeStamp,
            actionName: extras.actionName || _t("Messages"),
            displayName: extras.displayName || value.route,
            clickable: false,
            error: extras.error,
            canRetry: !!extras.error,
            status,
            tooltip: JSON.stringify({
                timeStamp,
                records: extras.displayNames || [],
            }),
        };
    }

    isClickable(value) {
        const extras = queueExtras(value);
        const resId = value.args[0]?.length ? value.args[0][0] : false;
        return (
            value.method === "web_save" &&
            extras.viewType === "form" &&
            (!this.offlinePlugin.isOffline() ||
                this.offlinePlugin.isAvailableOffline(extras.actionId, "form", resId))
        );
    }

    inError = computed(
        () =>
            Object.values(this.offlinePlugin._ormToSync()).find(
                ({ value }) => queueExtras(value).error
            ) ||
            Object.values(this.offlinePlugin._httpToSync()).find(
                ({ value }) => queueExtras(value).error
            )
    );

    get labelColor() {
        if (this.inError()) {
            if (this.uiService.isSmall) {
                return "text-danger";
            }
            return "text-bg-danger";
        }
        if (this.offlinePlugin.isOffline()) {
            if (this.uiService.isSmall) {
                return "text-warning";
            }
            return "text-bg-warning";
        }
        if (this.offlinePlugin.syncingORM()) {
            if (this.uiService.isSmall) {
                return "";
            }
            return "text-bg-300";
        }
        return "text-bg-300";
    }

    get labelIcon() {
        if (this.offlinePlugin.syncingORM()) {
            return "spinner-border";
        }
        if (this.inError()) {
            return "error";
        }
        if (this.offlinePlugin.isOffline()) {
            return "link_off";
        }
        return "spinner-border";
    }

    get labelText() {
        if (this.offlinePlugin.syncingORM()) {
            return _t("Syncing");
        }
        if (this.offlinePlugin.isOffline()) {
            return _t("Working offline");
        }
        if (this.inError()) {
            return _t("Sync issues");
        }
        return _t("Syncing");
    }

    discard(id, kind = "orm") {
        this.dialogService.add(ConfirmationDialog, {
            title: _t("Discard offline change"),
            body: _t("Are you sure that you want to discard the changes you made offline?"),
            confirmLabel: _t("Discard"),
            cancelLabel: _t("No, keep it"),
            confirm: () => {
                if (kind === "http") {
                    this.offlinePlugin.removeScheduledHTTP(id);
                } else {
                    this.offlinePlugin.removeScheduledORM(id);
                }
            },
            cancel: () => {},
        });
    }

    retry(id, kind = "orm") {
        if (kind === "http") {
            this.offlinePlugin.retryScheduledHTTP(id);
        } else {
            this.offlinePlugin.retryScheduledORM(id);
        }
        if (!this.offlinePlugin.isOffline()) {
            this.offlinePlugin._syncAll();
        }
        this.notification.add(_t("Queued for retry"), { type: "info" });
    }

    async openView(id) {
        const { value } = this.offlinePlugin._ormToSync()[id];
        const extras = queueExtras(value);
        const resId = value.args[0]?.[0];
        await this.actionService.doAction(extras.actionId, {
            viewType: "form",
            props: { offlineId: id, resId },
            clearBreadcrumbs: true,
        });
        if (!this.offlinePlugin.isOffline()) {
            this.offlinePlugin.removeScheduledORM(id);
        }
    }
}

const offlineSystrayItem = {
    Component: OfflineSystray,
};

registry.category("systray").add("offline", offlineSystrayItem, { sequence: 1000 });
