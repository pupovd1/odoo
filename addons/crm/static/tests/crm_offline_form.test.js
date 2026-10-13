import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, click, queryFirst, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    editSelectMenu,
    getService,
    makeMockServer,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
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

onRpc("crm.lead", "get_rainbowman_message", () => "Go, go, go! Congrats for your first deal.");
// the tooltip's props declare objects for the top / low criteria
onRpc("crm.lead", "prepare_pls_tooltip_data", () => ({
    probability: 40,
    team_name: "Sales",
    top_3_data: {},
    low_3_data: {},
}));
onRpc("crm.lead", "action_set_automated_probability", () => false);

const stageForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="stage_id" widget="selection"/>
            <field name="name"/>
            <field name="partner_id"/>
            <field name="email_from"/>
            <field name="phone"/>
            <field name="partner_email_update" invisible="1"/>
            <field name="partner_phone_update" invisible="1"/>
        </sheet>
    </form>`;

async function selectStage(stageName) {
    await editSelectMenu(".o_field_widget[name=stage_id] input", { value: stageName });
}

test("[Offline] a stage change saved offline completes without the rainbowman lookup", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: stageForm });

    await setOffline(true);
    await selectStage("Won");
    await contains(".o_form_button_save").click();
    await animationFrame();

    // the save was attempted and queued; the rainbowman lookup was never sent
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([[3], { stage_id: 3 }]);
    expect(".o_field_widget[name=stage_id] input").toHaveValue("Won");
    expect(".o_form_status_indicator_buttons:not(.invisible)").toHaveCount(0); // saved
    expect(".o_reward").toHaveCount(0);

    // replayed as is once back online, still without the lookup
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_save"]);
    expect(queuedCalls()).toEqual([]);
    expect(".o_reward").toHaveCount(0);
});

test("[Online] a stage change saved online still looks up the rainbowman", async () => {
    mockCrmOffline(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: stageForm });

    await selectStage("Won");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save", "crm.lead/get_rainbowman_message"]);
    expect(".o_reward").toHaveCount(1);
});

test("[Offline] the queued save carries the email and phone force-saved for partner sync", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: stageForm });

    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Office chairs (x12)");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([
        [1],
        { name: "Office chairs (x12)", email_from: "chairs@example.com", phone: "+32 470 11 11 11" },
    ]);

    // replayed as is once back online
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_save"]);
    expect(queuedCalls()).toEqual([]);
});

/**
 * Lead 1 ("Office chairs", partner sync flags set) gets a partner, and the
 * partner field's results are searched once online, so that they are in the
 * framework's relational-field cache.
 */
async function openLeadWithCachedContacts() {
    await makeMockServer();
    const [chairsId, desksId] = MockServer.env["res.partner"].create([
        { name: "Chairs Contact", email: "buyer@chairs.example" },
        { name: "Desks Contact", email: "buyer@desks.example" },
    ]);
    MockServer.env["crm.lead"].write([1], { partner_id: chairsId });
    await mountWithCleanup(WebClient);
    const openLead = () =>
        getService("action").doAction({
            res_model: "crm.lead",
            res_id: 1,
            type: "ir.actions.act_window",
            views: [[false, "form"]],
        });
    await openLead();
    await contains(".o_field_widget[name=partner_id] input").edit("Contact", { confirm: false });
    await runAllTimers();
    await contains(".o_form_renderer").click();
    await openLead(); // a fresh field, without the memorized search
    return desksId;
}

test.tags("desktop");
test("[Offline] after a partner change offline, the stale sync flags force-save nothing", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    CrmLead._views = { form: stageForm, search: `<search/>` };
    const desksId = await openLeadWithCachedContacts();

    await setOffline(true);
    // the onchange can't run offline: partner_email_update / partner_phone_update
    // still describe the previous partner
    await contains(".o_field_widget[name=partner_id] input").edit("Desks", { confirm: false });
    await runAllTimers();
    await contains(".dropdown .dropdown-item:contains(Desks Contact)").click();
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    // only the partner: the server computes the email and phone from it at replay
    expect(queuedCalls()[0].args).toEqual([[1], { partner_id: desksId }]);

    // a later offline edit of the same lead doesn't add them either
    await contains(".o_field_widget[name=name] input").edit("Office chairs (x12)");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([
        [1],
        { partner_id: desksId, name: "Office chairs (x12)" },
    ]);
});

test.tags("desktop");
test("[Online] after a partner change online, the sync flags still force-save", async () => {
    mockCrmOffline(["crm.lead/web_save"]);
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(Object.keys(args[1]).sort().join(","));
    });
    CrmLead._views = { form: stageForm, search: `<search/>` };
    await openLeadWithCachedContacts();

    await contains(".o_field_widget[name=partner_id] input").edit("Desks", { confirm: false });
    await runAllTimers();
    await contains(".dropdown .dropdown-item:contains(Desks Contact)").click();
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save", "email_from,partner_id,phone"]);
});

const plsForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="probability"/>
            <field name="is_automated_probability" invisible="1"/>
            <a class="o_crm_ai_link btn btn-link" name="action_set_automated_probability" type="object"
               data-crm-offline-disable="1" role="button">AI</a>
            <widget name="pls_tooltip_button"/>
        </sheet>
    </form>`;

test("[Offline] the predictive-scoring tooltip button is disabled offline, with no lookup", async () => {
    const setOffline = mockCrmOffline([
        "crm.lead/prepare_pls_tooltip_data",
        "crm.lead/action_set_automated_probability",
    ]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: plsForm });
    expect(".o_crm_pls_tooltip_button").toBeEnabled();

    await setOffline(true);
    expect(".o_crm_pls_tooltip_button").not.toBeEnabled();
    // even a programmatic click doesn't reach the server
    queryFirst(".o_crm_pls_tooltip_button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_crm_pls_tooltip").toHaveCount(0);

    await setOffline(false);
    expect(".o_crm_pls_tooltip_button").toBeEnabled();
    await contains(".o_crm_pls_tooltip_button").click();
    await expect.waitForSteps(["crm.lead/prepare_pls_tooltip_data"]);
    expect(".o_crm_pls_tooltip").toHaveCount(1);
});

test("[Offline] <a> view buttons marked data-crm-offline-disable are disabled and unreachable", async () => {
    const setOffline = mockCrmOffline(["crm.lead/action_set_automated_probability"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: plsForm });
    expect("a.o_crm_ai_link").not.toHaveClass("o_disabled_offline");

    await setOffline(true);
    expect("a.o_crm_ai_link").toHaveClass(["o_disabled_offline", "disabled", "pe-none"]);
    expect("a.o_crm_ai_link").toHaveAttribute("tabindex", "-1");
    expect("a.o_crm_ai_link").toHaveAttribute("aria-disabled", "true");
    await click("a.o_crm_ai_link"); // programmatic: hoot dispatches the click anyway
    await animationFrame();
    expect.verifySteps([]);

    await setOffline(false);
    expect("a.o_crm_ai_link").not.toHaveClass("o_disabled_offline");
    expect("a.o_crm_ai_link").not.toHaveAttribute("aria-disabled");
    await contains("a.o_crm_ai_link").click();
    await expect.waitForSteps(["crm.lead/action_set_automated_probability"]);
});

// small screens fold the header and button box buttons into menus
test.tags("desktop");
test("[Offline] lead form buttons that need the server are disabled offline, enabled online", async () => {
    const setOffline = mockCrmOffline();
    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        arch: `
            <form js_class="crm_form">
                <header>
                    <button name="action_convert_to_opportunity" string="Convert" type="object"/>
                    <button name="1" string="Lost" type="action"/>
                </header>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_schedule_meeting" type="object" class="oe_stat_button" string="Meeting"/>
                        <button name="action_show_potential_duplicates" type="object" class="oe_stat_button" string="Similar Leads"/>
                    </div>
                    <field name="name"/>
                    <button name="mail_action_blacklist_remove" type="object" string="Unblacklist email"/>
                    <button name="phone_action_blacklist_remove" type="object" string="Unblacklist phone"/>
                </sheet>
            </form>`,
    });
    const names = [
        "action_convert_to_opportunity",
        "1",
        "action_schedule_meeting",
        "action_show_potential_duplicates",
        "mail_action_blacklist_remove",
        "phone_action_blacklist_remove",
    ];
    for (const name of names) {
        expect(`button[name='${name}']`).toBeEnabled();
    }
    await setOffline(true);
    for (const name of names) {
        expect(`button[name='${name}']`).not.toBeEnabled();
    }
    await setOffline(false);
    for (const name of names) {
        expect(`button[name='${name}']`).toBeEnabled();
    }
});
