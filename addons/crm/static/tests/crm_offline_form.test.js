import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { ResPartner } from "@mail/../tests/mock_server/mock_models/res_partner";
import { expect, test } from "@odoo/hoot";
import { animationFrame, click, queryFirst, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    editSelectMenu,
    getService,
    makeMockServer,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
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
onRpc("crm.lead", "action_set_won", function ({ args }) {
    this.env["crm.lead"].write(args[0], { stage_id: 3, won_status: "won", probability: 100 });
    return true;
});
onRpc("crm.lead", "action_set_won_rainbowman", function ({ args }) {
    this.env["crm.lead"].write(args[0], { stage_id: 3, won_status: "won", probability: 100 });
    // as call_button cleans it: a closing action carrying the effect
    return {
        type: "ir.actions.act_window_close",
        effect: { message: "Go, go, go! Congrats for your first deal.", type: "rainbow_man" },
    };
});
onRpc("crm.lead", "action_restore", function ({ args }) {
    this.env["crm.lead"].write(args[0], { active: true, won_status: "pending", probability: 30 });
    return true;
});

defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

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
    // the flags are the server's: nothing left for the server to sort out
    expect(queuedCalls()[0].kwargs.context.crm_partner_sync_force_saved).toBe(undefined);

    // replayed as is once back online
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_save"]);
    expect(queuedCalls()).toEqual([]);
});

/** Whether the lead form's contact field opens the search dialog (small screen, online). */
function partnerFieldOpensDialog() {
    return Boolean(queryFirst(".o_field_widget[name=partner_id] input[readonly]"));
}

/**
 * Lead 1 ("Office chairs", partner sync flags set) gets a partner, and the
 * contacts are in the framework's relational-field cache: on a large screen,
 * because the partner field's results were searched once online; on a small
 * screen (where the field opens a search dialog online), as when the leads of
 * these contacts were loaded online.
 */
async function openLeadWithCachedContacts() {
    // what the contact field's search dialog shows on small screens
    ResPartner._views = {
        kanban: `<kanban><templates><t t-name="card"><field name="display_name"/></t></templates></kanban>`,
        search: `<search><field name="display_name"/></search>`,
    };
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
    if (partnerFieldOpensDialog()) {
        await getService(OfflinePlugin).cacheMany2XSearch("res.partner", [
            { id: chairsId, display_name: "Chairs Contact" },
            { id: desksId, display_name: "Desks Contact" },
        ]);
    } else {
        await contains(".o_field_widget[name=partner_id] input").edit("Contact", { confirm: false });
        await runAllTimers();
        await contains(".o_form_renderer").click();
    }
    await openLead(); // a fresh field, without the memorized search
    return desksId;
}

/** Picks a contact in the lead form's contact field, as at this screen size. */
async function pickPartner(name) {
    if (partnerFieldOpensDialog()) {
        await contains(".o_field_widget[name=partner_id] input").click();
        await contains(`.o_dialog .o_kanban_record:contains(${name})`).click();
    } else {
        await contains(".o_field_widget[name=partner_id] input").edit(name.split(" ")[0], {
            confirm: false,
        });
        await runAllTimers();
        await contains(`.dropdown .dropdown-item:contains(${name})`).click();
    }
}

test("[Offline] after a partner change offline, the lead's email and phone are force-saved, named for the server", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    CrmLead._views = { form: stageForm, search: `<search/>` };
    const desksId = await openLeadWithCachedContacts();

    await setOffline(true);
    // the onchange can't run offline: partner_email_update / partner_phone_update
    // still describe the previous partner
    await pickPartner("Desks Contact");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    // the lead's email and phone are in the queued write, named in the context:
    // the server keeps each only if the new partner has none of its own (as the
    // onchange would have), and then propagates it to the partner
    const forceSaved = { email_from: "chairs@example.com", phone: "+32 470 11 11 11" };
    expect(queuedCalls()[0].args).toEqual([[1], { partner_id: desksId, ...forceSaved }]);
    expect(queuedCalls()[0].kwargs.context.crm_partner_sync_force_saved).toEqual(["email_from", "phone"]);

    // a later offline edit of the same lead: still one queued write, still named
    await contains(".o_field_widget[name=name] input").edit("Office chairs (x12)");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([
        [1],
        { partner_id: desksId, ...forceSaved, name: "Office chairs (x12)" },
    ]);
    expect(queuedCalls()[0].kwargs.context.crm_partner_sync_force_saved).toEqual(["email_from", "phone"]);

    // back online, the queued write replays as is; the form isn't reloaded, so its
    // flags are still stale: the next online save names them too
    onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
        const forced = kwargs.context.crm_partner_sync_force_saved;
        expect.step(`server: ${Object.keys(args[1]).sort().join(",")} (forced: ${forced})`);
    });
    await setOffline(false);
    await expect.waitForSteps([
        "crm.lead/web_save",
        "server: email_from,name,partner_id,phone (forced: email_from,phone)",
    ]);
    await contains(".o_field_widget[name=name] input").edit("Office chairs (x14)");
    await contains(".o_form_button_save").click();
    await expect.waitForSteps([
        "crm.lead/web_save",
        "server: email_from,name,phone (forced: email_from,phone)",
    ]);
});

test("[Offline] after a partner change made online, an offline save keeps the force-saved values", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    CrmLead._views = { form: stageForm, search: `<search/>` };
    const desksId = await openLeadWithCachedContacts();

    // online: the onchange runs and refreshes the sync flags (Desks has no phone)
    await pickPartner("Desks Contact");
    expect(".o_field_widget[name=email_from] input").toHaveValue("buyer@desks.example");

    // the connection drops before the save: the copy follows the fresh flags
    await setOffline(true);
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedCalls()[0].args).toEqual([
        [1],
        { partner_id: desksId, email_from: "buyer@desks.example", phone: "+32 470 11 11 11" },
    ]);
    // fresh flags: nothing left for the server to sort out
    expect(queuedCalls()[0].kwargs.context.crm_partner_sync_force_saved).toBe(undefined);
});

test("[Online] after a partner change online, the sync flags still force-save", async () => {
    mockCrmOffline(["crm.lead/web_save"]);
    onRpc("crm.lead", "web_save", ({ args, kwargs }) => {
        expect.step(Object.keys(args[1]).sort().join(","));
        expect.step(`forced: ${kwargs.context.crm_partner_sync_force_saved}`);
    });
    CrmLead._views = { form: stageForm, search: `<search/>` };
    await openLeadWithCachedContacts();

    await pickPartner("Desks Contact");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps(["crm.lead/web_save", "email_from,partner_id,phone", "forced: undefined"]);
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
    // opened online, the tooltip closes when the connection drops
    await contains(".o_crm_pls_tooltip_button").click();
    await expect.waitForSteps(["crm.lead/prepare_pls_tooltip_data"]);
    expect(".o_crm_pls_tooltip").toHaveCount(1);

    await setOffline(true);
    expect(".o_crm_pls_tooltip").toHaveCount(0);
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

/**
 * Checks the lead form's buttons, opening the menus small screens fold the
 * header and button box buttons into (the header's menu toggler is a button of
 * its own, disabled offline: its buttons are then unreachable).
 */
async function expectFormButtons(names, enabled) {
    const check = (selector) =>
        enabled ? expect(selector).toBeEnabled() : expect(selector).not.toBeEnabled();
    const headerMenu = ".o_statusbar_buttons button[title='More']";
    const boxMenu = ".o_button_more";
    const folded = [];
    if (queryFirst(headerMenu)) {
        check(headerMenu);
        if (enabled) {
            await contains(headerMenu).click();
            folded.push(...names.filter((name) => queryFirst(`.o-dropdown--menu button[name='${name}']`)));
            for (const name of folded) {
                check(`.o-dropdown--menu button[name='${name}']`);
            }
            await contains(headerMenu).click();
        } else {
            folded.push(...names.filter((name) => !queryFirst(`button[name='${name}']`)));
        }
    }
    if (queryFirst(boxMenu)) {
        await contains(boxMenu).click();
    }
    for (const name of names.filter((name) => !folded.includes(name))) {
        check(`button[name='${name}']`);
    }
    if (queryFirst(`${boxMenu}[aria-expanded=true]`)) {
        await contains(boxMenu).click();
    }
}

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
    await expectFormButtons(names, true);
    await setOffline(true);
    await expectFormButtons(names, false);
    await setOffline(false);
    await expectFormButtons(names, true);
});

const wonForm = `
    <form js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                data-available-offline="1" data-crm-offline-needs-id="1"
                invisible="won_status == 'won' or type == 'lead' or not active"/>
            <button name="action_restore" string="Restore" type="object" data-available-offline="1"
                invisible="won_status != 'lost'"/>
            <field name="stage_id" widget="crm_statusbar" options="{'clickable': '1'}"/>
        </header>
        <sheet>
            <widget name="web_ribbon" title="Won" invisible="won_status != 'won'"/>
            <widget name="web_ribbon" title="Lost" bg_color="text-bg-danger" invisible="won_status != 'lost'"/>
            <field name="name"/>
            <field name="probability"/>
            <field name="automated_probability" invisible="1"/>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="type" invisible="1"/>
        </sheet>
    </form>`;

test("[Offline] mark won queues action_set_won and shows the lead as won at once, without the rainbowman", async () => {
    const setOffline = mockCrmOffline([
        "crm.lead/action_set_won",
        "crm.lead/action_set_won_rainbowman",
        "crm.lead/get_rainbowman_message",
    ]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: wonForm });
    expect(".ribbon:contains(Won)").toHaveCount(0);

    await setOffline(true);
    expect("button[name=action_set_won_rainbowman]").toBeEnabled();
    await contains("button[name=action_set_won_rainbowman]").click();
    // won at once; the button's server call and the rainbowman are never attempted
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect("button[name=action_set_won_rainbowman]").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("100.00");
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.action_set_won"]);
    expect(queuedCalls()[0].args).toEqual([[3]]);
    expect(".o_reward").toHaveCount(0);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/action_set_won"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(3)[0].won_status).toBe("won");
    expect(".o_reward").toHaveCount(0);
});

test("[Online] mark won still calls the server button and shows the rainbowman", async () => {
    mockCrmOffline(["crm.lead/action_set_won", "crm.lead/action_set_won_rainbowman"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: wonForm });
    await contains("button[name=action_set_won_rainbowman]").click();
    await expect.waitForSteps(["crm.lead/action_set_won_rainbowman"]);
    await animationFrame();
    expect(".o_reward").toHaveCount(1);
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(queuedCalls()).toEqual([]);
});

test("[Offline] a lead created offline (no id yet) can't be marked won offline", async () => {
    const setOffline = mockCrmOffline(["crm.lead/action_set_won", "crm.lead/action_set_won_rainbowman"]);
    await mountView({ type: "form", resModel: "crm.lead", arch: wonForm });
    // online, a new lead's Won button is usable (it saves, then marks won)
    expect("button[name=action_set_won_rainbowman]").toBeEnabled();
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Created offline");
    // a lead without id can't be marked won offline (no id remapping): disabled
    expect("button[name=action_set_won_rainbowman]").toHaveCount(1);
    expect("button[name=action_set_won_rainbowman]").not.toBeEnabled();
    await contains(".o_form_button_save").click();
    expect("button[name=action_set_won_rainbowman]").not.toBeEnabled();
    // the framework's re-enabling of offline-available buttons doesn't undo it
    await animationFrame();
    expect("button[name=action_set_won_rainbowman]").not.toBeEnabled();
    // a programmatic click does nothing either
    queryFirst("button[name=action_set_won_rainbowman]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await animationFrame();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);

    // online again: enabled
    await setOffline(false);
    await expect.waitForSteps([]);
    expect("button[name=action_set_won_rainbowman]").toBeEnabled();
});

test("[Offline] restore a lost lead: action_restore queued, shown as not lost at once", async () => {
    const setOffline = mockCrmOffline(["crm.lead/action_restore"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 5, arch: wonForm });
    expect(".ribbon:contains(Lost)").toHaveCount(1);

    await setOffline(true);
    expect("button[name=action_restore]").toBeEnabled();
    await contains("button[name=action_restore]").click();
    expect(".ribbon:contains(Lost)").toHaveCount(0);
    expect("button[name=action_restore]").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("30.00");
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.action_restore"]);
    expect(queuedCalls()[0].args).toEqual([[5]]);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/action_restore"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(5)[0].active).toBe(true);
});

test("[Offline] a lead marked won or restored offline still shows it when opened again offline", async () => {
    // (without the stage bar, whose stages the framework also refreshes in the background)
    CrmLead._views = { form: wonForm.replace(/<field name="stage_id"[^>]*\/>/, ""), search: `<search/>` };
    defineActions(
        [3, 5].map((resId) => ({
            id: 10 + resId,
            name: "Lead",
            res_model: "crm.lead",
            res_id: resId,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        }))
    );
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    // both leads visited online: available offline
    await getService("action").doAction(15);
    await getService("action").doAction(13);
    await runAllTimers();

    await setOffline(true);
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    await getService("action").doAction(15);
    await contains("button[name=action_restore]").click();
    expect(".ribbon:contains(Lost)").toHaveCount(0);

    // opened again offline: the cached data predates the queued calls, which still show
    await getService("action").doAction(13);
    expect(".ribbon:contains(Won)").toHaveCount(1);
    expect(".o_field_widget[name=probability] input").toHaveValue("100.00");
    expect("button[name=action_set_won_rainbowman]").toHaveCount(0);
    await getService("action").doAction(15);
    expect(".ribbon:contains(Lost)").toHaveCount(0);
    expect("button[name=action_restore]").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("30.00");
    // nothing queued twice; the form isn't dirty
    expect(queuedMethods()).toEqual(["crm.lead.action_set_won", "crm.lead.action_restore"]);
    expect(".o_form_status_indicator_buttons:not(.invisible)").toHaveCount(0);
    // (each lead opened offline is still refreshed from the network in the background)
    const refresh = /Connection to "\/web\/dataset\/call_kw\/crm\.lead\/web_read"/;
    await expect.waitForErrors([refresh, refresh, refresh]);
});

/** Moves the lead (wonForm) to the Proposition stage from its stage bar, as at this screen size. */
async function moveToProposition() {
    if (getService("ui").isSmall) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        await contains(".o-dropdown--menu .dropdown-item:contains(Proposition)").click();
    } else {
        await click(".o_statusbar_status button[data-value='2']");
        await animationFrame();
    }
}

/** Steps each lead call that reaches the server, in replay order. */
function stepReplayedLeadCalls() {
    for (const method of ["web_save", "action_set_won", "action_restore"]) {
        onRpc("crm.lead", method, ({ args }) => {
            expect.step(`server: ${method} ${JSON.stringify(args.slice(1)[0] || {})}`);
        });
    }
}

test("[Offline] an edit made after a queued Won is replayed after it: the last action wins", async () => {
    const setOffline = mockCrmOffline();
    // (stepped before the mock implementations: the test's handlers run first)
    stepReplayedLeadCalls();
    await mountView({ type: "form", resModel: "crm.lead", resId: 2, arch: wonForm });

    await setOffline(true);
    // an edit, then Won: the edit is saved (queued) first, then Won is queued
    await contains(".o_field_widget[name=name] input").edit("Desks (x20)");
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(".ribbon:contains(Won)").toHaveCount(1);
    // the user changes their mind: back to Proposition from the stage bar
    await moveToProposition();
    await contains(".o_form_button_save").click();
    await animationFrame();

    // three queued calls, in the order the user made them: the last save is a
    // new call, after Won, not merged into the first one
    expect(queuedMethods()).toEqual(["crm.lead.web_save", "crm.lead.action_set_won", "crm.lead.web_save"]);
    const [edit, won, move] = queuedCalls();
    expect(edit.args).toEqual([[2], { name: "Desks (x20)" }]);
    expect(move.args).toEqual([[2], { stage_id: 2 }]);
    expect(edit.extras.timeStamp < won.extras.timeStamp).toBe(true);
    expect(won.extras.timeStamp < move.extras.timeStamp).toBe(true);

    await setOffline(false);
    await expect.waitForSteps([
        'server: web_save {"name":"Desks (x20)"}',
        "server: action_set_won {}",
        'server: web_save {"stage_id":2}',
    ]);
    await animationFrame();
    expect(queuedCalls()).toEqual([]);
    // the lead ends where the user left it
    expect(MockServer.env["crm.lead"].browse(2)[0].stage_id).toBe(2);
});

test("[Offline] Won queued in the same millisecond as the save before it is still replayed after it", async () => {
    const setOffline = mockCrmOffline();
    await mountView({ type: "form", resModel: "crm.lead", resId: 3, arch: wonForm });
    await setOffline(true);
    // the clock doesn't move between the save and Won
    const now = Date.now();
    patchWithCleanup(Date, { now: () => now });
    await contains(".o_field_widget[name=name] input").edit("Meeting room (2)");
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(queuedMethods()).toEqual(["crm.lead.web_save", "crm.lead.action_set_won"]);
    const [save, won] = queuedCalls();
    expect(won.extras.timeStamp > save.extras.timeStamp).toBe(true);
});

test("[Offline] opened again after a queued Restore, the lead's next edit is replayed after it", async () => {
    CrmLead._views = { form: wonForm.replace(/<field name="stage_id"[^>]*\/>/, ""), search: `<search/>` };
    defineActions([
        {
            id: 15,
            name: "Lead",
            res_model: "crm.lead",
            res_id: 5,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        },
    ]);
    const setOffline = mockCrmOffline();
    stepReplayedLeadCalls();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(15); // lead 5, lost: visited online
    await runAllTimers();

    await setOffline(true);
    // an edit, then Restore (the edit is saved first)
    await contains(".o_field_widget[name=name] input").edit("Lost bid (retry)");
    await contains("button[name=action_restore]").click();
    expect(queuedMethods()).toEqual(["crm.lead.web_save", "crm.lead.action_restore"]);

    // opened again offline: the framework shows the queued edit again, then
    // crm the Restore; the next edit is a new call, queued after Restore
    await getService("action").doAction(15);
    expect(".o_field_widget[name=name] input").toHaveValue("Lost bid (retry)");
    expect(".ribbon:contains(Lost)").toHaveCount(0);
    expect(".o_field_widget[name=probability] input").toHaveValue("30.00");
    await contains(".o_field_widget[name=probability] input").edit("10");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect(queuedMethods()).toEqual(["crm.lead.web_save", "crm.lead.action_restore", "crm.lead.web_save"]);
    const [edit, restore, probability] = queuedCalls();
    expect(edit.args).toEqual([[5], { name: "Lost bid (retry)" }]);
    expect(probability.args).toEqual([[5], { probability: 10 }]);
    expect(restore.extras.timeStamp < probability.extras.timeStamp).toBe(true);

    await setOffline(false);
    await expect.waitForSteps([
        'server: web_save {"name":"Lost bid (retry)"}',
        "server: action_restore {}",
        'server: web_save {"probability":10}',
    ]);
    // the probability the user set last is kept, not the one Restore sets
    expect(MockServer.env["crm.lead"].browse(5)[0].probability).toBe(10);
    // (the lead opened offline is still refreshed from the network in the background)
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm\.lead\/web_read"/]);
});

test("[Offline] a stage move from the stage bar is saved offline (queued web_save)", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: wonForm });

    await setOffline(true);
    if (getService("ui").isSmall) {
        // small screens show the stages in a dropdown, whose toggler is available offline
        expect(".o_statusbar_status button.dropdown-toggle:not(.d-none)").toBeEnabled();
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        await contains(".o-dropdown--menu .dropdown-item:contains(Proposition)").click();
    } else {
        expect(".o_statusbar_status button[data-value='2']").toBeEnabled();
        await click(".o_statusbar_status button[data-value='2']");
        await animationFrame();
    }
    await contains(".o_form_button_save").click();
    expect.verifySteps(["crm.lead/web_save"]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args[0]).toEqual([1]);
    expect(queuedCalls()[0].args[1].stage_id).toBe(2);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_save"]);
    expect(MockServer.env["crm.lead"].browse(1)[0].stage_id).toBe(2);
});

test("[Online] the lead stage bar keeps the layout of mail's stage bar", async () => {
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: wonForm });
    // mail's stage bar styles are keyed on its field class: without them the stages
    // wrap, and the stage bar folds some of them away
    expect(".o_field_widget[name=stage_id]").toHaveClass("o_field_rotting_statusbar_duration");
    expect(".o_field_widget[name=stage_id] > .o_statusbar_status").toHaveStyle({
        flexDirection: "row-reverse",
    });
});

test("[Offline] a lead never opened online shows the offline action helper, then opens once online", async () => {
    CrmLead._views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <templates><t t-name="card"><field name="name"/></t></templates>
            </kanban>`,
        form: wonForm,
        search: `<search/>`,
    };
    const setOffline = mockCrmOffline(["crm.lead/web_read"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await setOffline(true);

    await contains(".o_kanban_record:contains(Desks for the new office)").click();
    expect.verifySteps(["crm.lead/web_read"]); // tried, nothing cached
    // the helper, not an empty form nor the pipeline it came from
    expect(".o_form_view .o_crm_offline_form_helper").toHaveCount(1);
    expect(".o_form_view .o_form_renderer").toHaveCount(0);
    expect(".o_kanban_view").toHaveCount(0);
    expect(".o_breadcrumb .active").toHaveText("Not available offline");
    // nothing to save or act on: no save / discard, no action menu
    expect(".o_form_status_indicator").toHaveCount(0);
    expect(".o_cp_action_menus").toHaveCount(0);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_read"]);
    await animationFrame();
    expect(".o_crm_offline_form_helper").toHaveCount(0);
    expect(".o_field_widget[name=name] input").toHaveValue("Desks for the new office");
    expect(".o_breadcrumb .active").toHaveText("Desks for the new office");
    expect(".o_form_status_indicator").toHaveCount(1);
    expect(".o_cp_action_menus").toHaveCount(1);
});

test("[Offline] the pager skips the leads never opened online", async () => {
    CrmLead._views = {
        list: `<list><field name="name"/></list>`,
        form: wonForm,
        search: `<search/>`,
    };
    defineActions([
        {
            id: 2,
            name: "Leads",
            res_model: "crm.lead",
            views: [
                [false, "list"],
                [false, "form"],
            ],
            search_view_id: [false, "search"],
        },
    ]);
    const setOffline = mockCrmOffline(["crm.lead/web_read"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    // "Meeting room" (3), then "Office chairs" (1), opened online; "Desks..." (2) never
    await contains(".o_data_row .o_data_cell:contains(Meeting room)").click();
    await contains(".o_back_button").click();
    await contains(".o_data_row .o_data_cell:contains(Office chairs)").click();
    expect.verifySteps(["crm.lead/web_read", "crm.lead/web_read"]);
    const isSmall = getService("ui").isSmall; // small screens show no record count
    if (!isSmall) {
        expect(".o_pager_limit").toHaveText("4");
    }

    await setOffline(true);
    // the framework's pager only steps through the leads available offline
    if (!isSmall) {
        expect(".o_pager_limit").toHaveText("2");
    }
    await contains(".o_pager_next").click();
    expect(".o_field_widget[name=name] input").toHaveValue("Meeting room");
    expect(".o_crm_offline_form_helper").toHaveCount(0);
    // (the cached lead is still refreshed from the network in the background: that fails)
    expect.verifySteps(["crm.lead/web_read"]);
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.lead\/web_read"/]);
});
