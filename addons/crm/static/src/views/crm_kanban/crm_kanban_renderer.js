import { CrmColumnProgress } from "./crm_column_progress";
import { RottingKanbanHeader } from "@mail/js/rotting_mixin/rotting_kanban_header";
import { RottingKanbanRenderer } from "@mail/js/rotting_mixin/rotting_kanban_renderer";
import { useCrmOffline } from "@crm/mobile/offline_hooks";

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
    static components = {
        ...RottingKanbanRenderer.components,
        KanbanHeader: CrmKanbanHeader,
    };

    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
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
