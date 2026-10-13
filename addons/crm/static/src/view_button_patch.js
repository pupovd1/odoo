import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { patch } from "@web/core/utils/patch";
import { ViewButton } from "@web/views/view_button/view_button";

/**
 * The framework disables `<button>` elements offline, not `<a>` view buttons.
 * crm views mark the `<a type="object">` links that need a server with
 * `data-crm-offline-disable`: offline they are disabled and unreachable (no
 * pointer events, out of the tab order, click handler short-circuited).
 */
patch(ViewButton.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },

    get isCrmDisabledOffline() {
        return this.props.attrs?.["data-crm-offline-disable"] !== undefined && this.crmOffline.isOffline();
    },

    get disabled() {
        return super.disabled || this.isCrmDisabledOffline;
    },

    getClassName() {
        const className = super.getClassName();
        return this.isCrmDisabledOffline ? `${className} disabled o_disabled_offline pe-none` : className;
    },

    onClick(ev) {
        if (this.isCrmDisabledOffline) {
            ev?.preventDefault();
            return;
        }
        return super.onClick(...arguments);
    },
});
