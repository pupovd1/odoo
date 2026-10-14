import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { queryAllTexts, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    getService,
    makeMockServer,
    MockServer,
    mountWithCleanup,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import {
    CrmLead,
    crmOfflineModels,
    mockCrmOffline,
    queuedCalls,
    queuedMethods,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

defineModels(crmOfflineModels);
defineMailModels();

const leadForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="partner_id"/>
        </sheet>
    </form>`;

/**
 * Lead 2 has "Chairs Contact" as contact; "Chairs Supplier" is on no lead. Lead 2,
 * then lead 1, are opened online: the framework keeps the contacts it loaded in
 * its relational-field cache.
 */
async function openLeadsOnline() {
    await makeMockServer();
    const [contactId] = MockServer.env["res.partner"].create([
        { name: "Chairs Contact" },
        { name: "Chairs Supplier" },
    ]);
    MockServer.env["crm.lead"].write([2], { partner_id: contactId });
    CrmLead._views = { form: leadForm, search: `<search/>` };
    defineActions(
        [2, 1].map((resId) => ({
            id: resId,
            name: "Leads",
            res_model: "crm.lead",
            res_id: resId,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        }))
    );
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    await getService("action").doAction(1);
    await runAllTimers();
    return contactId;
}

test("[Offline] the lead's contact search answers from the relational-field cache, without Create", async () => {
    const setOffline = mockCrmOffline(["res.partner/web_name_search"]);
    const contactId = await openLeadsOnline();

    await setOffline(true);
    await contains(".o_field_widget[name=partner_id] input").edit("Chairs", { confirm: false });
    await runAllTimers();
    // no search is sent (it can't be answered offline): the contacts loaded online
    // answer. No Create / Create and edit / Search more.
    expect.verifySteps([]);
    expect(queryAllTexts(".o-autocomplete--dropdown-menu .dropdown-item")).toEqual(["Chairs Contact"]);
    expect(".o_m2o_dropdown_option_create, .o_m2o_dropdown_option_create_edit").toHaveCount(0);
    expect(".o_m2o_dropdown_option_search_more").toHaveCount(0);

    await contains(".o-autocomplete--dropdown-menu .dropdown-item:contains(Chairs Contact)").click();
    expect(".o_field_widget[name=partner_id] input").toHaveValue("Chairs Contact");
    await contains(".o_form_button_save").click();
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([[1], { partner_id: contactId }]);
});

test("[Online] the lead's contact search offers Create and Search more online", async () => {
    mockCrmOffline();
    await openLeadsOnline();
    if (getService("ui").isSmall) {
        // small screens open the search dialog online, as before
        expect(".o_field_widget[name=partner_id] input").toHaveAttribute("readonly");
        return;
    }
    await contains(".o_field_widget[name=partner_id] input").edit("Chairs", { confirm: false });
    await runAllTimers();
    expect(queryAllTexts(".o-autocomplete--dropdown-menu .dropdown-item")).toEqual([
        "Chairs Contact",
        "Chairs Supplier",
        'Create "Chairs"',
        "Create and edit...",
        "Search more...",
    ]);
});

test.tags("mobile");
test("[Offline] on a small screen, the lead's relational fields search the cache only while offline", async () => {
    const setOffline = mockCrmOffline();
    await openLeadsOnline();
    // online: the search dialog opener, unchanged
    expect(".o_field_widget[name=partner_id] input").toHaveAttribute("readonly");

    await setOffline(true);
    // offline: the autocomplete, answered from the relational-field cache
    expect(".o_field_widget[name=partner_id] input").not.toHaveAttribute("readonly");
    await contains(".o_field_widget[name=partner_id] input").edit("Chairs", { confirm: false });
    await runAllTimers();
    expect(queryAllTexts(".o-autocomplete--dropdown-menu .dropdown-item")).toEqual(["Chairs Contact"]);

    await setOffline(false);
    expect(".o_field_widget[name=partner_id] input").toHaveAttribute("readonly");
});
