import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ListController } from "@web/views/list/list_controller";

/**
 * Deleting a stage or a sales team is a destructive admin action: offline the
 * framework would queue it, crm makes it unavailable instead (KICKOFF DISABLE,
 * ANSWERS "group deletes").
 */
const NO_OFFLINE_DELETE_MODELS = ["crm.stage", "crm.team"];

// A factory: each patched class needs its own object (`super` is bound to it).
const offlineDeletePatch = () => ({
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },

    getStaticActionMenuItems() {
        const items = super.getStaticActionMenuItems(...arguments);
        if (items.delete && NO_OFFLINE_DELETE_MODELS.includes(this.props.resModel)) {
            const { callback } = items.delete;
            items.delete = {
                ...items.delete,
                availableOffline: false,
                callback: (...args) => !this.crmOffline.isOffline() && callback(...args),
            };
        }
        return items;
    },
});

patch(FormController.prototype, offlineDeletePatch());
patch(ListController.prototype, offlineDeletePatch());
