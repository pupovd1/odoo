import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { patch } from "@web/core/utils/patch";
import { ViewButton } from "@web/views/view_button/view_button";

/**
 * The framework disables `<button>` elements offline, not `<a>` view buttons.
 * crm views mark the `<a type="object">` links that need a server with
 * `data-crm-offline-disable`, and the buttons available offline only on a
 * record that already has an id (the queue does no id remapping) with
 * `data-crm-offline-needs-id`: offline they are disabled and unreachable (no
 * pointer events, out of the tab order, click handler short-circuited).
 */
patch(ViewButton.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },

    get isCrmDisabledOffline() {
        if (!this.crmOffline.isOffline()) {
            return false;
        }
        const attrs = this.props.attrs || {};
        return (
            attrs["data-crm-offline-disable"] !== undefined ||
            (attrs["data-crm-offline-needs-id"] !== undefined && !this.props.record?.resId)
        );
    },

    get disabled() {
        return super.disabled || this.isCrmDisabledOffline;
    },

    getClassName() {
        const className = super.getClassName();
        if (!this.isCrmDisabledOffline) {
            return className;
        }
        // the framework re-enables `.o_disabled_offline[data-available-offline]` elements
        const marker = this.props.attrs?.["data-available-offline"] !== undefined ? "" : " o_disabled_offline";
        return `${className} disabled pe-none${marker}`;
    },

    onClick(ev) {
        if (this.isCrmDisabledOffline) {
            ev?.preventDefault();
            return;
        }
        return super.onClick(...arguments);
    },
});
