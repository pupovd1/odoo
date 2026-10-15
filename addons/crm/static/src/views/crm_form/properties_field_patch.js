import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { ConnectionLostError } from "@web/core/network/rpc";
import { patch } from "@web/core/utils/patch";
import { PropertiesField } from "@web/views/fields/properties/properties_field";

/**
 * A lead's properties (lead_properties, defined on the lead's team): the field
 * asks the server whether the definition can be edited each time it turns
 * editable, so each time the connection comes back (offline it is read-only).
 * web's user cache keeps a probe lost with the connection, rejected, for the
 * rest of the session: for a lead, once the connection is back the server is
 * asked again without that cache (useCrmOffline().checkAccessRight), so that
 * editing the definition isn't disabled until the page is reloaded. While the
 * connection is lost, the probe counts as no access: no uncaught error, which
 * would switch the app offline again at each reconnection.
 */
patch(PropertiesField.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },

    async checkDefinitionWriteAccess() {
        if (this.props.record.resModel !== "crm.lead" || !this.definitionRecordId || !this.definitionRecordModel) {
            return super.checkDefinitionWriteAccess(...arguments);
        }
        try {
            return await this.crmOffline.checkAccessRight(
                this.definitionRecordModel,
                "write",
                this.definitionRecordId
            );
        } catch (error) {
            if (error instanceof ConnectionLostError) {
                return false;
            }
            throw error;
        }
    },
});
