import { ConnectionLostError } from "@web/core/network/rpc";
import { isOfflineTempId } from "@web/core/offline/offline_plugin";
import { _t } from "@web/core/l10n/translation";
import { useEnv } from "@web/owl2/utils";
import { patch } from "@web/core/utils/patch";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { ActionPlugin } from "@web/webclient/actions/action_plugin";

/** CRM lead object methods that can be queued offline. */
export const CRM_OFFLINE_METHODS = new Set([
    "action_set_won_rainbowman",
    "action_set_won",
    "action_set_lost",
    "action_restore",
    "action_convert_to_opportunity",
    "action_schedule_meeting",
    "copy",
]);

function scheduleCrmButton(env, params) {
    const ids = (params.resIds?.length ? params.resIds : params.resId ? [params.resId] : []).filter(
        (id) => id
    );
    const tempIds = ids.filter((id) => isOfflineTempId(id));
    env.services.offline.scheduleORM(
        params.resModel,
        params.name,
        [ids],
        { context: params.context || {} },
        {
            dependsOn: tempIds.length ? tempIds : undefined,
            extras: {
                timeStamp: Date.now(),
                displayName: params.displayName || params.name,
                actionName: _t("CRM"),
            },
        }
    );
    env.services.notification?.add(_t("Queued for sync when back online"), { type: "info" });
}

/**
 * Object buttons pass the method as params.name. The Lost button is an action
 * that opens the lost-reason wizard; its context names the method to queue.
 */
function offlineMethodName(params) {
    if (
        params.type === "object" &&
        params.resModel === "crm.lead" &&
        CRM_OFFLINE_METHODS.has(params.name)
    ) {
        return params.name;
    }
    const method = params.buttonContext?.offline_method;
    if (params.resModel === "crm.lead" && CRM_OFFLINE_METHODS.has(method)) {
        return method;
    }
    return null;
}

/**
 * Wrap doActionButton so CRM offline-capable object buttons queue via scheduleORM.
 */
patch(ActionPlugin.prototype, {
    setup() {
        super.setup(...arguments);
        // doActionButton is the action manager's function. The plugin has no
        // this.env; the manager closed over its own env when the function was
        // created. useEnv() is the plugin component's env.
        const env = useEnv();
        const originalDoActionButton = this.doActionButton;
        this.doActionButton = async (params, options = {}) => {
            const methodName = offlineMethodName(params);
            if (methodName && env.services.offline?.isOffline()) {
                scheduleCrmButton(env, { ...params, name: methodName });
                // Reloading the form would web_read a server that cannot be reached.
                return;
            }
            try {
                return await originalDoActionButton(params, options);
            } catch (e) {
                if (e instanceof ConnectionLostError && methodName) {
                    scheduleCrmButton(env, { ...params, name: methodName });
                    return;
                }
                throw e;
            }
        };
    },
});

const LOST_WIZARD_MODEL = "crm.lead.lost";

patch(ActionMenus.prototype, {
    async getActionItems(props) {
        const items = await super.getActionItems(...arguments);
        if (props.resModel !== "crm.lead") {
            return items;
        }
        return items.map((item) =>
            item.action?.res_model === LOST_WIZARD_MODEL ? { ...item, availableOffline: true } : item
        );
    },

    async executeAction(action) {
        if (
            this.props.resModel === "crm.lead" &&
            action.res_model === LOST_WIZARD_MODEL &&
            this.offlinePlugin.isOffline()
        ) {
            const ids = this.props.getActiveIds() || [];
            scheduleCrmButton(this.env, {
                resModel: "crm.lead",
                name: "action_set_lost",
                resId: ids[0],
                resIds: ids,
                context: this.props.context,
                displayName: action.name || _t("Lost"),
            });
            return;
        }
        return super.executeAction(...arguments);
    },
});
