import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { listView } from "@web/views/list/list_view";

export class CrmStageListRenderer extends listView.Renderer {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    }

    /**
     * Stages can't be reordered offline: the framework doesn't queue a resequence.
     */
    get canResequenceRows() {
        return super.canResequenceRows && !this.crmOffline.isOffline();
    }
}
