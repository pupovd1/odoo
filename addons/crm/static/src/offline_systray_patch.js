import { computed } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { patch } from "@web/core/utils/patch";
import "@web/webclient/offline_systray/offline_systray"; // registers the "offline" systray item

/**
 * Status of the CRM calls that crm queues itself (the framework only labels
 * the saves, deletions and (un)archivings it queues). Same shape as the
 * framework's statuses: a label and a tag color.
 */
export const CRM_QUEUED_CALL_STATUS = {
    "crm.lead/action_set_won": { label: _t("Won"), color: 10 },
    "crm.lead/action_restore": { label: _t("Restored"), color: 10 },
    "crm.lead/action_log_call": { label: _t("Call logged"), color: 4 },
    "crm.lead/create": { label: _t("Created"), color: 10 },
    "mail.activity/create": { label: _t("Activity scheduled"), color: 4 },
    "mail.activity/action_done": { label: _t("Activity done"), color: 10 },
};

/**
 * Any other queued call the framework's systray has no status for (it can't
 * render one without): a neutral one.
 */
const PENDING_STATUS = { label: _t("Pending"), color: 0 };

const { Component: OfflineSystray } = registry.category("systray").get("offline");

patch(OfflineSystray.prototype, {
    setup() {
        super.setup(...arguments);
        // groupEntries is a class field (computed): wrap it to label the CRM calls,
        // which the framework's systray leaves without a status (and can't render)
        const groupEntries = this.groupEntries;
        this.groupEntries = computed(() => {
            const queued = this.offlinePlugin._ormToSync();
            return groupEntries().map(([section, items]) => [
                section,
                items.map((item) => {
                    if (item.status) {
                        return item;
                    }
                    const call = queued[item.id]?.value;
                    const status = (call && CRM_QUEUED_CALL_STATUS[`${call.model}/${call.method}`]) || PENDING_STATUS;
                    return { ...item, status };
                }),
            ]);
        });
    },
});
