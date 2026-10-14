import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { patch } from "@web/core/utils/patch";
import { ActionMenus } from "@web/search/action_menus/action_menus";
import { CogMenu } from "@web/search/cog_menu/cog_menu";

const CRM_OFFLINE_MODELS = ["crm.lead", "crm.stage", "crm.team"];

/**
 * Offline, the framework greys out the action and cog menu items that aren't
 * available offline (pointer events off), but they can still be selected with
 * the keyboard or by program. On the CRM models, selecting one offline does
 * nothing.
 */
patch(ActionMenus.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },

    isCrmItemUnavailableOffline(item) {
        const resModel = this.props.resModel || this.env.model?.root?.resModel;
        return (
            CRM_OFFLINE_MODELS.includes(resModel) &&
            this.crmOffline.isOffline() &&
            !item.availableOffline
        );
    },

    async onItemSelected(item) {
        if (this.isCrmItemUnavailableOffline(item)) {
            return;
        }
        return super.onItemSelected(...arguments);
    },
});

patch(CogMenu.prototype, {
    /** The cog menu also greys out the items of a record that isn't saved yet. */
    isCrmItemUnavailableOffline(item) {
        const availableOffline = item.availableOffline && !this.env.model?.root?.isNew;
        return super.isCrmItemUnavailableOffline({ ...item, availableOffline });
    },
});
