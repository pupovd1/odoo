import { usePlugin } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { UIPlugin } from "@web/core/ui/ui_plugin";
import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { CrmKanbanArchParser } from "@crm/views/crm_kanban/crm_kanban_arch_parser";
import { CrmKanbanRenderer } from "@crm/views/crm_kanban/crm_kanban_renderer";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { rottingKanbanView } from "@mail/js/rotting_mixin/rotting_kanban_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";

export const crmKanbanView = {
    ...rottingKanbanView,
    ArchParser: CrmKanbanArchParser,
    // Makes it easier to patch
    Controller: class extends rottingKanbanView.Controller {
        static components = {
            ...rottingKanbanView.Controller.components,
            LeadGenerationDropdown,
        }

        setup() {
            super.setup(...arguments);
            this.uiPlugin = usePlugin(UIPlugin);
        }

        /** Small screens show the pipeline one stage at a time (CrmKanbanRenderer). */
        get isMobilePipeline() {
            const root = this.model.root;
            return (
                this.props.archInfo.mobilePipeline &&
                this.uiPlugin.isSmall() &&
                this.model.isReady() &&
                root.isGrouped &&
                root.groupByField.name === "stage_id"
            );
        }

        /**
         * On the small-screen pipeline, New opens its quick create (a bottom
         * sheet, CrmMobilePipeline), which needs no server onchange: available
         * offline.
         */
        get isNewButtonAvailableOffline() {
            return this.isMobilePipeline || super.isNewButtonAvailableOffline;
        }

        async createRecord() {
            if (this.isMobilePipeline) {
                // as the kanban's own quick create: the sample data goes
                if (this.model.useSampleModel) {
                    this.model.removeSampleDataInGroups();
                    this.model.useSampleModel = false;
                }
                this.model.bus.trigger("CRM:MOBILE_QUICK_CREATE");
                return;
            }
            // offline, the quick create or new-lead form needs the onchange the
            // framework cached online: without it, New is disabled (framework),
            // and unreachable by program too
            if (this.offlinePlugin.isOffline() && !this.isNewButtonAvailableOffline) {
                return;
            }
            return super.createRecord(...arguments);
        }

        get progressBarAggregateFields() {
            const res = super.progressBarAggregateFields;
            const progressAttributes = this.props.archInfo.progressAttributes;
            if (progressAttributes && progressAttributes.recurring_revenue_sum_field) {
                res.push(progressAttributes.recurring_revenue_sum_field);
            }
            return res;
        }
    },
    ControlPanel: CrmControlPanel,
    Model: CrmKanbanModel,
    Renderer: CrmKanbanRenderer,
    SearchModel: CrmSearchModel,
    buttonTemplate: "crm.Kanban.Buttons",
};

registry.category("views").add("crm_kanban", crmKanbanView);
