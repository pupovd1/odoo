import { listView } from "@web/views/list/list_view";

/**
 * Model of the CRM lists (leads, opportunities, forecast, stages). Offline they
 * are read-only: the framework doesn't queue multi-record edits. A record still
 * opens in its form, which queues its saves.
 */
export class CrmListModel extends listView.Model {
    get multiEdit() {
        return this._multiEdit && !this.offlinePlugin.isOffline();
    }

    set multiEdit(multiEdit) {
        this._multiEdit = multiEdit;
    }
}
