import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import "@crm/views/crm_offline_actions";
import { registry } from "@web/core/registry";
import { formView } from "@web/views/form/form_view";
import { ConnectionLostError } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";

class CrmFormRecord extends formView.Model.Record {
    /**
     * @override
     */
    async _save() {
        if (this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        let changeStage = false;
        const needsSynchronizationEmail =
            this._changes.partner_email_update === undefined
                ? this._values.partner_email_update
                : this._changes.partner_email_update;

        const needsSynchronizationPhone =
            this._changes.partner_phone_update === undefined
                ? this._values.partner_phone_update
                : this._changes.partner_phone_update;

        if (
            needsSynchronizationEmail &&
            this._changes.email_from === undefined &&
            this._values.email_from
        ) {
            this._changes.email_from = this._values.email_from;
        }
        if (needsSynchronizationPhone && this._changes.phone === undefined && this._values.phone) {
            this._changes.phone = this._values.phone;
        }

        if ("stage_id" in this._changes) {
            changeStage = this._values.stage_id !== this.data.stage_id;
        }

        const res = await super._save(...arguments);
        if (res && changeStage) {
            await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);
        }
        return res;
    }
}

class CrmFormModel extends formView.Model {
    static Record = CrmFormRecord;
    static services = [...formView.Model.services, "effect"];

    setup(params, services) {
        super.setup(...arguments);
        this.effect = services.effect;
    }
}

class CrmFormController extends formView.Controller {
    getStaticActionMenuItems() {
        const items = super.getStaticActionMenuItems();
        if (items.duplicate) {
            items.duplicate.availableOffline = true;
            const originalCallback = items.duplicate.callback;
            items.duplicate.callback = async () => {
                try {
                    await originalCallback();
                } catch (e) {
                    if (e instanceof ConnectionLostError) {
                        const record = this.model.root;
                        this.env.services.offline.scheduleORM(
                            record.resModel,
                            "copy",
                            [[record.resId]],
                            { context: record.context },
                            {
                                extras: {
                                    timeStamp: Date.now(),
                                    displayName: record.data.display_name || _t("Lead"),
                                    actionName: _t("CRM"),
                                },
                            }
                        );
                        this.env.services.notification.add(
                            _t("Duplicate queued for sync when back online"),
                            { type: "info" }
                        );
                        return;
                    }
                    throw e;
                }
            };
        }
        return items;
    }
}

registry.category("views").add("crm_form", {
    ...formView,
    Controller: CrmFormController,
    Model: CrmFormModel,
});
