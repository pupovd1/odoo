import { Component, onWillStart, proxy, status, useOnChange, usePlugin, useProps } from "@odoo/owl";
import { getQueuedResIds, useCrmOffline } from "@crm/mobile/offline_hooks";
import { serializeDate, today } from "@web/core/l10n/dates";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { UIPlugin } from "@web/core/ui/ui_plugin";
import { useService } from "@web/core/utils/hooks";
import { getOfflineDisplayName, getScheduleORMExtras } from "@web/model/relational_model/utils";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

const ACTIVITY_FIELDS = ["activity_type_id", "summary", "date_deadline", "user_id", "state", "can_write"];
const ACTIVITY_TYPE_FIELDS = ["name", "summary", "category", "icon"];

/**
 * The activities of a lead, offline. The chatter is read-only offline (its data
 * is never cached), so the lead form gets this panel, rendered only while
 * offline: online it renders nothing; on a small screen, it also keeps the
 * lead's activities and the activity types in the framework's RPC disk cache
 * (on a large screen it issues no request online: the lead form loads as
 * before). Offline it reads them from there and lets the user schedule an
 * activity, log a call or mark an activity done. Each of these is one call
 * queued in the framework's queue; queued calls show here at once, marked
 * "Pending sync". Meetings are not offered: they create a calendar event,
 * unreachable offline. With nothing cached (a large screen, or a lead whose
 * panel never loaded online), no activity is listed and Schedule is disabled;
 * Log a call needs nothing cached.
 */
export class CrmOfflineActivities extends Component {
    static template = "crm.OfflineActivities";
    props = useProps(standardWidgetProps);

    setup() {
        this.orm = useService("orm");
        this.crmOffline = useCrmOffline();
        this.uiPlugin = usePlugin(UIPlugin);
        this.state = proxy({
            activities: [],
            activityTypes: [],
            typeId: false,
            summary: "",
            deadline: serializeDate(today()),
            assigneeId: user.userId,
            callSummary: "",
        });
        onWillStart(() => {
            const loaded = this.load();
            // online, the form doesn't wait for this pre-loading
            return this.crmOffline.isOffline() ? loaded : undefined;
        });
        useOnChange(
            () => [this.crmOffline.isOffline(), this.props.record.resId, this.uiPlugin.isSmall()],
            () => this.load(),
            { initialRun: false }
        );
        // once the queue has replayed this panel's pending calls, read the result
        useOnChange(
            () => [this.crmOffline.isSyncing()],
            (isSyncing) => {
                if (isSyncing) {
                    this.hadPendingCalls = this.hasPendingCalls;
                } else if (this.hadPendingCalls) {
                    this.hadPendingCalls = false;
                    this.load();
                }
            },
            { initialRun: false }
        );
    }

    get record() {
        return this.props.record;
    }

    get isShown() {
        return this.crmOffline.isOffline() && Boolean(this.record.resId);
    }

    get assignees() {
        const assignees = [{ id: user.userId, name: user.name }];
        const salesperson = this.record.data.user_id;
        if (salesperson && salesperson.id !== user.userId) {
            assignees.push({ id: salesperson.id, name: salesperson.display_name });
        }
        return assignees;
    }

    get selectedType() {
        return this.state.activityTypes.find((type) => type.id === this.state.typeId);
    }

    get canSchedule() {
        return Boolean(this.selectedType && this.state.deadline);
    }

    get hasPendingCalls() {
        return Boolean(this.pendingDoneIds.size || this.pendingActivities.length || this.pendingCalls.length);
    }

    /** Ids of the cached activities marked done offline. */
    get pendingDoneIds() {
        return new Set(
            this.crmOffline
                .queuedCalls("mail.activity")
                .filter((call) => call.method === "action_done")
                .flatMap((call) => getQueuedResIds(call))
        );
    }

    /** Activities scheduled offline on this lead. */
    get pendingActivities() {
        return this.crmOffline
            .queuedCalls("mail.activity")
            .filter(
                (call) =>
                    call.method === "create" &&
                    call.kwargs?.context?.default_res_model === "crm.lead"
            )
            .map((call) => ({ key: call.key, values: call.args?.[0]?.[0] || {} }))
            .filter(({ values }) => values.res_id === this.record.resId)
            .map(({ key, values }) => ({
                key,
                summary: values.summary,
                deadline: values.date_deadline,
                typeName: this.state.activityTypes.find((type) => type.id === values.activity_type_id)
                    ?.name,
            }));
    }

    /** Calls logged offline on this lead. */
    get pendingCalls() {
        return this.crmOffline
            .queuedCalls("crm.lead")
            .filter(
                (call) =>
                    call.method === "action_log_call" &&
                    getQueuedResIds(call).includes(this.record.resId)
            )
            .map((call) => ({ key: call.key, summary: call.kwargs?.summary }));
    }

    async load() {
        const resId = this.record.resId;
        const isOffline = this.crmOffline.isOffline();
        // online, only small screens keep the panel's data cached: on a large
        // screen the lead form issues no request it didn't before
        if (!resId || (!isOffline && !this.uiPlugin.isSmall())) {
            return;
        }
        // online the cached copy is refreshed every time; offline what is already
        // in memory is used as is (no doomed request)
        const update = isOffline ? "once" : "always";
        const disk = this.orm.cache({ type: "disk", update });
        // offline and never read online: nothing (a connection error); a failing
        // read never breaks the form either: the panel is a side prefetch
        const read = (model, domain, fields) => disk.searchRead(model, domain, fields).catch(() => null);
        const [activities, activityTypes] = await Promise.all([
            read("mail.activity", [["res_model", "=", "crm.lead"], ["res_id", "=", resId]], ACTIVITY_FIELDS),
            read(
                "mail.activity.type",
                ["|", ["res_model", "=", false], ["res_model", "=", "crm.lead"]],
                ACTIVITY_TYPE_FIELDS
            ),
        ]);
        if (status(this) === "destroyed" || resId !== this.record.resId) {
            return;
        }
        this.state.activities = activities || [];
        this.state.activityTypes = (activityTypes || []).filter((type) => type.category !== "meeting");
        if (!this.selectedType) {
            this.state.typeId = this.state.activityTypes[0]?.id || false;
        }
    }

    onTypeChange(ev) {
        this.state.typeId = Number(ev.target.value);
    }

    onAssigneeChange(ev) {
        this.state.assigneeId = Number(ev.target.value);
    }

    queueExtras(label) {
        return {
            ...getScheduleORMExtras(this.record.model, [this.record]),
            displayName: `${getOfflineDisplayName(this.record)}: ${label}`,
        };
    }

    schedule() {
        if (!this.isShown || !this.canSchedule) {
            return;
        }
        const type = this.selectedType;
        // the lead's model goes in the context: mail.activity's default_get
        // resolves it to res_model_id, as when the chatter schedules one
        const values = {
            res_id: this.record.resId,
            activity_type_id: type.id,
            summary: this.state.summary.trim() || type.summary || false,
            date_deadline: this.state.deadline,
            user_id: this.state.assigneeId,
        };
        this.crmOffline.scheduleCall(
            "mail.activity",
            "create",
            [[values]],
            { context: { default_res_model: "crm.lead" } },
            this.queueExtras(values.summary || type.name)
        );
        this.state.summary = "";
    }

    logCall() {
        if (!this.isShown) {
            return;
        }
        const summary = this.state.callSummary.trim();
        this.crmOffline.scheduleCall(
            "crm.lead",
            "action_log_call",
            [[this.record.resId]],
            summary ? { summary } : {},
            this.queueExtras(summary || _t("Call"))
        );
        this.state.callSummary = "";
    }

    markDone(activity) {
        if (!this.isShown || !activity.can_write || this.pendingDoneIds.has(activity.id)) {
            return;
        }
        this.crmOffline.scheduleCall(
            "mail.activity",
            "action_done",
            [[activity.id]],
            {},
            this.queueExtras(activity.summary || activity.activity_type_id[1])
        );
    }
}

registry.category("view_widgets").add("crm_offline_activities", {
    component: CrmOfflineActivities,
});
