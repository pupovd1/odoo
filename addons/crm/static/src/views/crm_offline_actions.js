import { ConnectionLostError } from "@web/core/network/rpc";
import { isOfflineTempId } from "@web/core/offline/offline_plugin";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
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
 * Wrap doActionButton so CRM offline-capable object buttons queue via scheduleORM.
 */
patch(ActionPlugin.prototype, {
    setup() {
        super.setup(...arguments);
        const originalDoActionButton = this.doActionButton.bind(this);
        this.doActionButton = async (params, options = {}) => {
            const isCrmOfflineMethod =
                params.type === "object" &&
                params.resModel === "crm.lead" &&
                CRM_OFFLINE_METHODS.has(params.name);

            if (isCrmOfflineMethod && this.env.services.offline?.offline) {
                scheduleCrmButton(this.env, params);
                if (params.onClose) {
                    await params.onClose();
                }
                return;
            }
            try {
                return await originalDoActionButton(params, options);
            } catch (e) {
                if (e instanceof ConnectionLostError && isCrmOfflineMethod) {
                    scheduleCrmButton(this.env, params);
                    if (params.onClose) {
                        await params.onClose();
                    }
                    return;
                }
                throw e;
            }
        };
    },
});
