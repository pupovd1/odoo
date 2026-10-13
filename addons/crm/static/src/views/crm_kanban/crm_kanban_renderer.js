import { CrmColumnProgress } from "./crm_column_progress";
import { RottingKanbanHeader } from "@mail/js/rotting_mixin/rotting_kanban_header";
import { RottingKanbanRenderer } from "@mail/js/rotting_mixin/rotting_kanban_renderer";
import { usePlugin } from "@odoo/owl";
import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { CrmMobilePipeline } from "@crm/mobile/mobile_pipeline/mobile_pipeline";
import { UIPlugin } from "@web/core/ui/ui_plugin";

class CrmKanbanHeader extends RottingKanbanHeader {
    static components = {
        ...RottingKanbanHeader.components,
        ColumnProgress: CrmColumnProgress,
    };

    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    }

    /**
     * The stage tooltip is read from the server on hover: skipped offline.
     */
    get hasTooltip() {
        return super.hasTooltip && !this.crmOffline.isOffline();
    }
}

export class CrmKanbanRenderer extends RottingKanbanRenderer {
    static template = "crm.KanbanRenderer";
    static components = {
        ...RottingKanbanRenderer.components,
        KanbanHeader: CrmKanbanHeader,
        CrmMobilePipeline,
    };

    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        this.uiPlugin = usePlugin(UIPlugin);
    }

    /**
     * On small screens, the pipeline (its arch says `mobile_pipeline="1"`)
     * grouped by stage shows one stage at a time, in CrmMobilePipeline; any
     * other kanban or grouping keeps the kanban.
     */
    get isMobilePipeline() {
        const { archInfo, list } = this.props;
        return (
            archInfo.mobilePipeline &&
            this.uiPlugin.isSmall() &&
            list.isGrouped &&
            list.groupByField.name === "stage_id"
        );
    }

    /**
     * The small-screen pipeline says itself when a stage has no lead: the
     * kanban's helper only goes over sample data there (it would hide the leads
     * created offline, pending sync).
     *
     * @override
     */
    get showNoContentHelper() {
        if (this.isMobilePipeline) {
            return this.props.list.model.useSampleModel;
        }
        return super.showNoContentHelper;
    }

    /** The field summed in the stage header: the progress bar's sum field. */
    get mobileSumField() {
        return this.props.archInfo.progressAttributes?.sumField?.name;
    }

    /**
     * Arrow keys on the small-screen pipeline (the kanban's navigation expects
     * its columns): up / down through the shown stage's leads.
     *
     * @override
     */
    focusNextCard(area, direction) {
        if (!this.isMobilePipeline) {
            return super.focusNextCard(...arguments);
        }
        const buttons = [...area.querySelectorAll(".o_crm_mobile_card_open")];
        const index = buttons.indexOf(document.activeElement.closest(".o_crm_mobile_card_open"));
        const next = index === -1 ? null : { down: buttons[index + 1], up: buttons[index - 1] }[direction];
        if (next) {
            next.focus();
            return true;
        }
    }

    /**
     * Stages can't be created (name_create) or reordered (resequence) offline:
     * the framework doesn't queue either.
     */
    canCreateGroup() {
        return super.canCreateGroup(...arguments) && !this.crmOffline.isOffline();
    }

    get canResequenceGroups() {
        return super.canResequenceGroups && !this.crmOffline.isOffline();
    }
}
