import { patch } from "@web/core/utils/patch";
import { RelationalModel } from "@web/model/relational_model/relational_model";

/**
 * Screens reached from the CRM menus that write models the offline queue must
 * not take (only crm.lead, crm.stage, crm.team and a lead's mail.activity can
 * be queued), or that need the server (reports, the teams dashboard). Online
 * they keep the framework's disk cache (cache-first rendering, as before);
 * offline they are unavailable: never marked available offline (so their menus
 * are disabled), and their views don't render from the disk cache (the offline
 * action helper shows instead), so that nothing on them can be edited and
 * queued offline.
 */
export const CRM_ONLINE_ONLY_ACTIONS = [
    "crm.crm_activity_report_action",
    "crm.crm_activity_report_action_team",
    "crm.crm_lost_reason_action",
    "crm.crm_recurring_plan_action",
    "crm.mail_activity_plan_action_lead",
    "sales_team.crm_team_action_pipeline",
    "sales_team.crm_team_member_action",
    "sales_team.mail_activity_type_action_config_sales",
    "sales_team.sales_team_crm_tag_action",
];

patch(RelationalModel.prototype, {
    get isCrmOnlineOnly() {
        return CRM_ONLINE_ONLY_ACTIONS.includes(this.env.config?.actionXmlId);
    },

    /** @override */
    _getCacheParams() {
        if (this.isCrmOnlineOnly && this.offlinePlugin.isOffline()) {
            return;
        }
        return super._getCacheParams(...arguments);
    },

    /** @override */
    _setAvailableOffline() {
        if (this.isCrmOnlineOnly) {
            return;
        }
        return super._setAvailableOffline(...arguments);
    },
});
