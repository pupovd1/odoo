import { CrmListModel } from "@crm/views/crm_list/crm_list_model";
import { CrmStageListRenderer } from "@crm/views/crm_stage_list/crm_stage_list_renderer";
import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";

export const crmStageListView = {
    ...listView,
    Model: CrmListModel,
    Renderer: CrmStageListRenderer,
};

registry.category("views").add("crm_stage_list", crmStageListView);
