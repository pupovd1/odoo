import { defineMailModels } from "@mail/../tests/mail_test_helpers";
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

    // back online, the queued write replays; the form isn't reloaded, so its flags are
    // still stale: the next online save doesn't force-save them either
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`server: ${Object.keys(args[1]).sort().join(",")}`);
    });
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_save", "server: name,partner_id"]);
    await contains(".o_field_widget[name=name] input").edit("Office chairs (x14)");
    await contains(".o_form_button_save").click();
    await expect.waitForSteps(["crm.lead/web_save", "server: name"]);
});

test.tags("desktop");
test("[Offline] after a partner change made online, an offline save keeps the force-saved values", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    CrmLead._views = { form: stageForm, search: `<search/>` };
    const desksId = await openLeadWithCachedContacts();

    // online: the onchange runs and refreshes the sync flags (Desks has no phone)
    await contains(".o_field_widget[name=partner_id] input").edit("Desks", { confirm: false });
    await runAllTimers();
    await contains(".dropdown .dropdown-item:contains(Desks Contact)").click();
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

const wonForm = `
    <form js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object" data-available-offline="1"
                invisible="won_status == 'won' or type == 'lead' or not active or not id"/>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                invisible="won_status == 'won' or type == 'lead' or not active or id"/>
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
    await setOffline(true);
    await contains(".o_field_widget[name=name] input").edit("Created offline");
    // the Won button of a record without id carries no offline attribute: disabled
    expect("button[name=action_set_won_rainbowman]").toHaveCount(1);
    expect("button[name=action_set_won_rainbowman]").not.toBeEnabled();
    await contains(".o_form_button_save").click();
    expect("button[name=action_set_won_rainbowman]").not.toBeEnabled();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
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
