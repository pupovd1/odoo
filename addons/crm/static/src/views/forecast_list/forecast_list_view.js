import { CrmControlPanel } from "@crm/views/crm_control_panel";
import { CrmListModel } from "@crm/views/crm_list/crm_list_model";
import { registry } from "@web/core/registry";
import { listView } from "@web/views/list/list_view";
import { ForecastSearchModel } from "@crm/views/forecast_search_model";

export const forecastListView = {
    ...listView,
    ControlPanel: CrmControlPanel,
    Model: CrmListModel,
    SearchModel: ForecastSearchModel,
};

registry.category("views").add("forecast_list", forecastListView);
