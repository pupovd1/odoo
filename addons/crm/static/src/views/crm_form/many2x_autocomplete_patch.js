import { patch } from "@web/core/utils/patch";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";

/**
 * Offline, the relational fields of the lead form (the contact, tags,
 * salesperson...) search the framework's relational-field cache only: no
 * web_name_search is sent (it can't be answered offline; the framework would
 * send it and fall back to the cache once it fails), and no Create is offered.
 * On a small screen, a relational field opens the search dialog, which can't
 * search offline (it only lists what was loaded online, with no free-text
 * search): offline, these fields use the framework's autocomplete there too, as
 * on desktop. Online, and outside the lead form, nothing changes.
 */
patch(Many2XAutocomplete.prototype, {
    get crmSearchesCacheOffline() {
        return Boolean(this.env.crmLeadForm) && this.offlinePlugin.isOffline();
    },

    /** @override */
    async search(name) {
        if (this.crmSearchesCacheOffline) {
            return this.offlinePlugin.searchMany2XRecords(this.props.resModel, name);
        }
        return super.search(...arguments);
    },
});
