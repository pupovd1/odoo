import { patch } from "@web/core/utils/patch";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";

/**
 * On a small screen, a relational field opens the search dialog, which can't
 * search offline (it only lists what was loaded online, with no free-text
 * search). Offline, the relational fields of the lead form (the contact, tags,
 * salesperson...) use the framework's autocomplete instead, as on desktop: it
 * answers from the framework's relational-field cache and offers no Create.
 * Online, and on desktop, nothing changes.
 */
patch(Many2XAutocomplete.prototype, {
    get crmSearchesCacheOffline() {
        return Boolean(this.env.crmLeadForm) && this.offlinePlugin.isOffline();
    },
});
