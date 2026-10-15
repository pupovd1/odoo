import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmListModel } from "@crm/views/crm_list/crm_list_model";
import { CrmSearchModel } from "@crm/views/crm_search_model";
import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { LeadGenerationDropdown } from "../../components/lead_generation_dropdown/lead_generation_dropdown";

export const crmListView = {
    ...listView,
    Controller: class extends listView.Controller {
        static components = {
            ...listView.Controller.components,
            LeadGenerationDropdown,
        }

        /**
         * Offline, a new lead needs the onchange the framework cached online:
         * without it, New is disabled (framework), and unreachable by program too.
         *
         * @override
         */
        async onClickCreate() {
            if (this.offlinePlugin.isOffline() && !this.isNewButtonAvailableOffline) {
                return;
            }
            return super.onClickCreate(...arguments);
        }
    },
    ControlPanel: CrmControlPanel,
    Model: CrmListModel,
    SearchModel: CrmSearchModel,
    buttonTemplate: "crm.List.Buttons",
};

registry.category("views").add("crm_list", crmListView);
