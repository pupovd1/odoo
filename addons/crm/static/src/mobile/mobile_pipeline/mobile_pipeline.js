import { Component, onWillStart, proxy, t, useOnChange, useProps } from "@odoo/owl";
import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { CrmMobileLeadCard, formatRevenue } from "@crm/mobile/mobile_lead_card/mobile_lead_card";
import { CrmMobileQuickCreate } from "@crm/mobile/mobile_quick_create/mobile_quick_create";
import { ConnectionLostError } from "@web/core/network/rpc";
import { usePopover } from "@web/core/popover/popover_hook";
import { useBus, useService } from "@web/core/utils/hooks";
import { OfflineActionHelper } from "@web/views/offline_action_helper";

/** Horizontal distance (px) a touch must travel, mostly sideways, to change stage. */
const SWIPE_DISTANCE = 60;

/**
 * The pipeline on small screens (CrmKanbanRenderer's small-screen branch): one
 * stage at a time, the full width of the screen, under a fixed header with the
 * stage's name, lead count and revenue, and navigation to the adjacent stages
 * (buttons and horizontal swipes). It renders the groups of the pipeline's
 * kanban model: no second model.
 *
 * Offline, a stage whose leads were loaded online renders from the framework's
 * cache; a stage never loaded (folded) shows the offline action helper, and
 * loads once the connection is back. Leads quick-created offline show at once
 * in their stage, as pending sync; once replayed, the stage reloads.
 */
export class CrmMobilePipeline extends Component {
    static template = "crm.MobilePipeline";
    static components = { CrmMobileLeadCard, OfflineActionHelper };
    props = useProps({
        list: t.any(),
        openRecord: t.function(),
        sumField: t.string().optional(),
    });

    setup() {
        this.orm = useService("orm");
        this.crmOffline = useCrmOffline();
        // the stage shown, by value: the kanban model keeps it when the user comes
        // back to the pipeline (CrmKanbanModel.exportState)
        this.state = proxy({ stageValue: this.props.list.model.mobileStage, unavailableGroupIds: [] });
        this.loadingGroupIds = new Set();
        this.swipeStart = null;
        this.suppressClick = false;
        this.quickCreate = usePopover(CrmMobileQuickCreate, { useBottomSheet: true });
        // the control panel's New button (see the crm_kanban controller)
        useBus(this.props.list.model.bus, "CRM:MOBILE_QUICK_CREATE", () => this.openQuickCreate());
        onWillStart(() => this.loadStage());
        // another stage shown, or the same one after the pipeline reloaded (search,
        // Reset Filters): load it if it's folded
        useOnChange(
            () => [this.group],
            () => this.loadStage(),
            { initialRun: false }
        );
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => {
                if (!isOffline && this.isUnavailable) {
                    this.loadStage();
                }
            },
            { initialRun: false }
        );
        // a lead created offline leaves the queue once replayed: show the real one
        this.pendingCreateKeys = this.pendingCreateKeysOf();
        useOnChange(
            () => [this.pendingCreateKeysOf().join(",")],
            () => {
                const keys = this.pendingCreateKeysOf();
                const replayed = this.pendingCreateKeys.some((key) => !keys.includes(key));
                this.pendingCreateKeys = keys;
                if (replayed && !this.crmOffline.isOffline()) {
                    this.props.list.load();
                }
            },
            { initialRun: false }
        );
    }

    get groups() {
        return this.props.list.groups;
    }

    get stageIndex() {
        return Math.max(
            this.groups.findIndex((group) => group.value === this.state.stageValue),
            0
        );
    }

    get group() {
        return this.groups[this.stageIndex];
    }

    get isFirst() {
        return this.stageIndex === 0;
    }

    get isLast() {
        return this.stageIndex >= this.groups.length - 1;
    }

    get isUnavailable() {
        return Boolean(this.group) && this.state.unavailableGroupIds.includes(this.group.id);
    }

    get revenue() {
        const { sumField } = this.props;
        const records = this.group?.list.records || [];
        return sumField
            ? formatRevenue(this.group.aggregates?.[sumField] || 0, records[0]?.data.company_currency?.id)
            : "";
    }

    get unloadedCount() {
        return this.group ? this.group.count - this.group.list.records.length : 0;
    }

    /** Leads created offline (queued creates) in the shown stage. */
    get pendingLeads() {
        const stageId = this.group?.value;
        return this.crmOffline
            .pendingCreates("crm.lead")
            .map((call) => ({
                key: call.key,
                values: (call.method === "create" ? call.args?.[0]?.[0] : call.args?.[1]) || {},
            }))
            .filter(({ values }) => values.stage_id === stageId);
    }

    get stages() {
        return this.groups
            .filter((group) => group.value)
            .map((group) => ({ id: group.value, name: group.displayName }));
    }

    formatPendingRevenue(values) {
        const records = this.group?.list.records || [];
        return formatRevenue(values.expected_revenue, records[0]?.data.company_currency?.id);
    }

    pendingCreateKeysOf() {
        return this.crmOffline.pendingCreates("crm.lead").map((call) => call.key);
    }

    /**
     * Loads the leads of the shown stage when they aren't (a folded stage).
     * Offline and never loaded online: the stage is unavailable.
     */
    async loadStage() {
        const group = this.group;
        // a group being unfolded is still folded until loaded: toggling it again
        // would fold it back
        if (!group || !group.isFolded || this.loadingGroupIds.has(group.id)) {
            return;
        }
        this.loadingGroupIds.add(group.id);
        try {
            await group.toggle();
            this.state.unavailableGroupIds = this.state.unavailableGroupIds.filter((id) => id !== group.id);
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
            if (!this.state.unavailableGroupIds.includes(group.id)) {
                this.state.unavailableGroupIds = [...this.state.unavailableGroupIds, group.id];
            }
        } finally {
            this.loadingGroupIds.delete(group.id);
        }
    }

    goTo(index) {
        const group = this.groups[index];
        if (!group || index === this.stageIndex) {
            return;
        }
        this.state.stageValue = group.value;
        this.props.list.model.mobileStage = group.value;
    }

    loadMore() {
        const list = this.group.list;
        return list.load({ limit: list.records.length + this.props.list.model.initialLimit });
    }

    openQuickCreate() {
        this.quickCreate.open(document.body, {
            stages: this.stages,
            stageId: this.group?.value,
            onAdd: (values) => this.addLead(values),
        });
    }

    /**
     * Creates the lead online; offline (or when the connection drops), queues
     * the create in the framework's queue, with the pipeline's defaults (type,
     * team...) as the server applies them online.
     */
    async addLead(values) {
        const list = this.props.list;
        const context = Object.fromEntries(
            Object.entries(list.context).filter(([key]) => key.startsWith("default_"))
        );
        if (!this.crmOffline.isOffline()) {
            let created = false;
            try {
                await this.orm.create("crm.lead", [values], { context });
                created = true;
            } catch (error) {
                if (!(error instanceof ConnectionLostError)) {
                    throw error;
                }
            }
            if (created) {
                // created: never queued again, even if the reload is lost with the
                // connection (the lead shows when the pipeline next loads)
                await list.load().catch((error) => {
                    if (!(error instanceof ConnectionLostError)) {
                        throw error;
                    }
                });
                return;
            }
        }
        const { actionId, actionName, viewType } = this.env.config;
        this.crmOffline.scheduleCall("crm.lead", "create", [[values]], { context }, {
            actionId,
            actionName,
            viewType,
            displayName: values.name,
        });
    }

    onPointerDown(ev) {
        // The click of a swipe, when the browser sends one, comes before the
        // next pointerdown. A gesture that did not click must not swallow the
        // next tap.
        this.suppressClick = false;
        this.swipeStart = { x: ev.clientX, y: ev.clientY };
    }

    onPointerUp(ev) {
        const start = this.swipeStart;
        this.swipeStart = null;
        if (!start) {
            return;
        }
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > 2 * Math.abs(dy)) {
            this.goTo(this.stageIndex + (dx < 0 ? 1 : -1));
            // touch-action: pan-y leaves this gesture to the page, so the card
            // under the pointer (a button) still receives the click and opens.
            this.suppressClick = true;
        }
    }

    onStageClick(ev) {
        if (!this.suppressClick) {
            return;
        }
        this.suppressClick = false;
        ev.preventDefault();
        ev.stopPropagation();
    }
}
