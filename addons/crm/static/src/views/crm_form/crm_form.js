import { getQueuedCalls, getQueuedResIds } from "@crm/mobile/offline_hooks";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { useOnChange } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { useSubEnv } from "@web/owl2/utils";
import { formView } from "@web/views/form/form_view";
import { OfflineActionHelper } from "@web/views/offline_action_helper";

/** What mark won gives the lead at once, offline (the won stage comes at replay). */
const WON_VALUES = { won_status: "won", probability: 100, active: true };

class CrmFormRecord extends formView.Model.Record {
     /**
     * override of record _save mechanism intended to affect the main form record
     * We check if the stage_id field was altered and if we need to display a rainbowman
     * message.
     *
     * This method will also simulate a real "force_save" on the email and phone
     * when needed. The "force_save" attribute only works on readonly field. For our
     * use case, we need to write the email and the phone even if the user didn't
     * change them, to synchronize those values with the partner (so the email / phone
     * inverse method can be called).
     *
     * We base this synchronization on the value of "partner_phone_update"
     * and "partner_email_update", which are computed fields that hold a value
     * whenever we need to synch.
     *
     * Offline, the save is queued with the same force-saved values. Onchanges
     * don't run offline though: once the partner was changed without its
     * onchange, the flags describe the previous partner (see _getOnchangeValues),
     * so nothing is force-saved and the server computes the email and phone from
     * the new partner, as the onchange would have. The rainbowman lookup is
     * skipped offline: it would fail, and a queued one would show detached from
     * the stage change.
     *
     * @override
     */
    async _save() {
        if (this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        let changeStage = false;
        const needsSynchronizationEmail =
            this._changes.partner_email_update === undefined
                ? this._values.partner_email_update // original value
                : this._changes.partner_email_update; // new value

        const needsSynchronizationPhone =
            this._changes.partner_phone_update === undefined
                ? this._values.partner_phone_update // original value
                : this._changes.partner_phone_update; // new value

        if (!this._partnerSyncFlagsStale) {
            if (needsSynchronizationEmail && this._changes.email_from === undefined && this._values.email_from) {
                this._changes.email_from = this._values.email_from;
            }
            if (needsSynchronizationPhone && this._changes.phone === undefined && this._values.phone) {
                this._changes.phone = this._values.phone;
            }
        }

        if ("stage_id" in this._changes) {
            changeStage = this._values.stage_id !== this.data.stage_id;
        }

        const res = await super._save(...arguments);
        if (res && changeStage && !this.model.offlinePlugin.isOffline()) {
            await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);
        }
        return res;
    }

    /**
     * Onchanges fail offline (the framework applies the change without them). If
     * the partner changes without its onchange, the partner sync flags keep the
     * previous partner's values until an onchange runs again or the record is
     * reloaded.
     *
     * @override
     */
    async _getOnchangeValues(changes) {
        const values = await super._getOnchangeValues(...arguments);
        if (values === undefined) {
            if ("partner_id" in changes) {
                this._partnerSyncFlagsStale = true;
            }
        } else if (Object.keys(changes).some((fieldName) => this.activeFields[fieldName]?.onChange)) {
            this._partnerSyncFlagsStale = false; // an onchange ran: the server's flags
        }
        return values;
    }

    /** @override */
    _setData() {
        this._partnerSyncFlagsStale = false;
        return super._setData(...arguments);
    }

    /**
     * Mark won, offline: queue the server method (it picks the won stage of the
     * lead's team at replay) and show the lead as won at once. No rainbowman: it
     * would show detached from the action once replayed.
     */
    markWonOffline() {
        this._scheduleOffline("action_set_won");
        this._applyLocalValues(WON_VALUES);
    }

    /**
     * Restore a lost lead, offline: queue the server method and show the lead as
     * not lost at once (its probability goes back to the automated one).
     */
    restoreOffline() {
        this._scheduleOffline("action_restore");
        this._applyLocalValues(this._restoredValues());
    }

    _restoredValues() {
        return {
            won_status: "pending",
            active: true,
            lost_reason_id: false,
            probability: this.data.automated_probability,
        };
    }

    /**
     * The lead opened again before its queued Won / Restore replayed (the data
     * read online predates them): show what they make of it, as when clicked.
     * Calls parked with an error are left out.
     */
    applyQueuedCalls() {
        const calls = getQueuedCalls(this.model.offlinePlugin).filter(
            (call) =>
                call.model === "crm.lead" &&
                !call.extras?.error &&
                getQueuedResIds(call).includes(this.resId)
        );
        for (const call of calls) {
            if (call.method === "action_set_won") {
                this._applyLocalValues(WON_VALUES);
            } else if (call.method === "action_restore") {
                this._applyLocalValues(this._restoredValues());
            }
        }
    }

    /** Show values the queued call will give the lead, for the fields of this form. */
    _applyLocalValues(values) {
        this._applyValues(
            Object.fromEntries(
                Object.entries(values).filter(
                    ([fieldName, value]) => fieldName in this.activeFields && value !== undefined
                )
            )
        );
    }

    _scheduleOffline(method) {
        this.model.offlinePlugin.scheduleORM(this.resModel, method, [[this.resId]], {}, {
            extras: getScheduleORMExtras(this.model, [this]),
        });
    }
}

class CrmFormModel extends formView.Model {
    static Record = CrmFormRecord;
    static services = [...formView.Model.services, "effect"];

    setup(params, services) {
        super.setup(...arguments);
        this.effect = services.effect;
    }

    /**
     * A lead never loaded online can't be opened offline (from its card, by the
     * pager...): instead of failing to open (the framework leaves the form
     * unmounted, or on the previous lead), keep an empty placeholder record of
     * that lead so that the form shows the offline action helper.
     *
     * @override
     */
    async load(params = {}) {
        try {
            await super.load(...arguments);
            this.unavailableResId = false;
        } catch (error) {
            const resId = "resId" in params ? params.resId : this.config.resId;
            if (error instanceof ConnectionLostError && this.couldNotLoadRootOffline && resId) {
                if (resId === this.root?.resId && !this.unavailableResId) {
                    // the lead shown, reloaded offline: keep showing it
                    this.couldNotLoadRootOffline = false;
                    return;
                }
                this.unavailableResId = resId;
                this.config = { ...this.config, resId };
                this.root = this._createRoot(this.config, {});
                await this.hooks.onRootLoaded(this.root);
                return;
            }
            throw error;
        }
    }
}

/**
 * The framework's offline action helper, for one lead: no "Reset Filters" (a
 * form has none to reset).
 */
export class CrmOfflineFormHelper extends OfflineActionHelper {
    static template = "crm.OfflineFormHelper";
}

/** Server buttons of the lead form that crm queues offline, and how. */
const OFFLINE_BUTTONS = {
    action_set_won_rainbowman: "markWonOffline",
    action_restore: "restoreOffline",
};

export class CrmFormController extends formView.Controller {
    static template = "crm.FormView";
    static components = { ...formView.Controller.components, CrmOfflineFormHelper };

    setup() {
        super.setup();
        // offline on a small screen, the lead's relational fields search the
        // relational-field cache (see many2x_autocomplete_patch.js)
        useSubEnv({ crmLeadForm: true });
        // a lead not available offline opens once the connection is back
        useOnChange(
            () => [this.offlinePlugin.isOffline()],
            (isOffline) => {
                if (!isOffline && this.model.unavailableResId) {
                    this.model.load({ resId: this.model.unavailableResId });
                }
            },
            { initialRun: false }
        );
    }

    /** @override */
    async onRootLoaded() {
        await super.onRootLoaded(...arguments);
        const root = this.model.root;
        if (root.resModel === "crm.lead" && root.resId && !this.model.unavailableResId) {
            root.applyQueuedCalls();
        }
    }

    displayName() {
        if (this.model.couldNotLoadRootOffline && this.model.unavailableResId) {
            return _t("Not available offline");
        }
        return super.displayName();
    }

    /**
     * Offline, Won and Restore don't reach the server (the framework would save,
     * then drop the button's call): the record saves (queued), then crm queues the
     * button's method and shows its result. A lead created offline has no id yet:
     * its Won button isn't available offline (see the lead form).
     *
     * @override
     */
    async beforeExecuteActionButton(clickParams) {
        const record = this.model.root;
        const offlineMethod = OFFLINE_BUTTONS[clickParams.name];
        if (
            !this.offlinePlugin.isOffline() ||
            clickParams.type !== "object" ||
            !offlineMethod ||
            record.resModel !== "crm.lead"
        ) {
            return super.beforeExecuteActionButton(...arguments);
        }
        if ((await record.save()) === false || !record.resId) {
            return false;
        }
        record[offlineMethod]();
        return false;
    }
}

registry.category("views").add("crm_form", {
    ...formView,
    Controller: CrmFormController,
    Model: CrmFormModel,
});
