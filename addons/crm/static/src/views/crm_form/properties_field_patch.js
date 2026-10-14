import { ConnectionLostError } from "@web/core/network/rpc";
import { patch } from "@web/core/utils/patch";
import { PropertiesField } from "@web/views/fields/properties/properties_field";

/**
 * A lead's properties (lead_properties, defined on the lead's team): the field
 * asks the server whether the definition can be edited each time it turns
 * editable, so each time the connection comes back (offline it is read-only).
 * For a lead, a probe lost with the connection counts as no access: web's user
 * cache keeps the failed answer, and re-throwing it at each reconnection would
 * switch the app offline again, then online, again and again.
 */
patch(PropertiesField.prototype, {
    async checkDefinitionWriteAccess() {
        try {
            return await super.checkDefinitionWriteAccess(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError && this.props.record.resModel === "crm.lead") {
                return false;
            }
            throw error;
        }
    },
});
