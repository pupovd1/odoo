import { setSelection } from "@html_editor/../tests/_helpers/selection";
import { insertText } from "@html_editor/../tests/_helpers/user_actions";
import { HtmlField } from "@html_editor/fields/html_field";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame, click, queryAllTexts, queryOne, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    getService,
    makeMockServer,
    makeServerError,
    MockServer,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
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
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                data-available-offline="1" data-crm-offline-needs-id="1"
                invisible="won_status == 'won' or type == 'lead' or not active"/>
            <field name="stage_id" widget="crm_statusbar" options="{'clickable': '1'}"/>
        </header>
        <sheet>
            <field name="name"/>
            <field name="won_status" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="type" invisible="1"/>
            <widget name="crm_offline_activities"/>
        </sheet>
    </form>`;

/**
 * Opens lead 3 ("Meeting room", stage Proposition) in the web client, online,
 * and lets the framework's startup sync (3 s after start) run, as it does long
 * before a user goes offline. hoot's mock of the browser's lock API doesn't
 * serialize the "db-sync" lock: a startup sync still pending at reconnect
 * would replay the queue a second time, which the browser's lock prevents.
 */
async function openLead() {
    CrmLead._views = { form: leadForm, search: `<search/>` };
    await mountWithCleanup(WebClient);
    await getService("action").doAction({
        name: "Leads",
        res_model: "crm.lead",
        res_id: 3,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    });
    await runAllTimers();
    await animationFrame();
}

/** Moves the lead to `stageName` with the stage bar and saves (both presets). */
async function moveToStage(stageName) {
    if (getService("ui").isSmall) {
        await contains(".o_statusbar_status button.dropdown-toggle").click();
        await contains(`.o-dropdown--menu .dropdown-item:contains(${stageName})`).click();
    } else {
        await click(`.o_statusbar_status button[role=radio]:contains(${stageName})`);
        await animationFrame();
    }
    await contains(".o_form_button_save").click();
}

test("[Offline] two offline writes to one lead replay in order, the later one wins, no conflict dialog", async () => {
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save stage ${args[1].stage_id}`);
    });
    onRpc("crm.lead", "action_set_won", function ({ args }) {
        expect.step("action_set_won");
        this.env["crm.lead"].write(args[0], { stage_id: 3, won_status: "won", probability: 100 });
        return true;
    });
    const setOffline = mockCrmOffline();
    await openLead();

    await setOffline(true);
    // first: back to New, then: mark won (another queued call, later)
    await moveToStage("New");
    await advanceTime(1000);
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(queuedMethods()).toEqual(["crm.lead.web_save", "crm.lead.action_set_won"]);
    const [first, second] = queuedCalls();
    expect(first.extras.timeStamp).toBeLessThan(second.extras.timeStamp);

    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps(["web_save stage 1", "action_set_won"]);
    expect(queuedCalls()).toEqual([]);
    // the later write won: the lead is won, in the won stage
    const [lead] = MockServer.env["crm.lead"].browse(3);
    expect(lead.stage_id).toBe(3);
    expect(lead.won_status).toBe("won");
    expect(".modal").toHaveCount(0);
});

test("[Offline] a rejected replay is parked in the offline systray with its error, no CRM error UI", async () => {
    onRpc("crm.lead", "action_set_won", () => {
        throw makeServerError({ message: "This lead can't be won" });
    });
    const setOffline = mockCrmOffline(["crm.lead/action_set_won"]);
    await openLead();

    await setOffline(true);
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(queuedMethods()).toEqual(["crm.lead.action_set_won"]);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/action_set_won"]);
    await runAllTimers();
    await animationFrame();
    // parked: still queued, with the server's error, never replayed on its own
    expect(queuedMethods()).toEqual(["crm.lead.action_set_won"]);
    expect(queuedCalls()[0].extras.error).toMatch(/This lead can't be won/);
    // shown by the framework's systray only
    expect(".o_menu_systray .o_offline_systray").toHaveCount(1);
    await contains(".o_menu_systray .o_offline_systray").click();
    expect(".o_offline_systray_content .text-danger:contains(Meeting room)").toHaveCount(1);
    expect(".o_dialog").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
});

// the offline activity panel has the activities and types to act on once they
// were cached online: on a small screen
test.tags("mobile");
test("[Offline] the offline systray labels the calls crm queues", async () => {
    onRpc("mail.activity.type", "search_read", () => [{ id: 2, name: "Call", category: "phonecall" }]);
    onRpc("mail.activity", "search_read", () => [
        {
            id: 7,
            activity_type_id: [2, "Call"],
            summary: "Discuss the quote",
            date_deadline: "2030-01-10",
            user_id: false,
            state: "planned",
            can_write: true,
        },
    ]);
    const setOffline = mockCrmOffline();
    await openLead();

    await setOffline(true);
    await contains(".o_crm_offline_schedule_button").click();
    await contains(".o_crm_offline_log_call_button").click();
    await contains(".o_crm_offline_mark_done").click();
    await contains("button[name=action_set_won_rainbowman]").click();
    expect(queuedMethods()).toEqual([
        "mail.activity.create",
        "crm.lead.action_log_call",
        "mail.activity.action_done",
        "crm.lead.action_set_won",
    ]);

    await contains(".o_menu_systray .o_offline_systray").click();
    const labels = [...document.querySelectorAll(".o_offline_systray_content .o_badge")].map(
        (badge) => badge.textContent.trim()
    );
    expect(labels).toEqual(["Activity scheduled", "Call logged", "Activity done", "Won"]);
});

test("[Offline] the offline systray labels a queued Restore, and any call it has no status for", async () => {
    CrmLead._views = {
        form: `
            <form js_class="crm_form">
                <header>
                    <button name="action_restore" string="Restore" type="object" data-available-offline="1"
                        invisible="won_status != 'lost'"/>
                </header>
                <sheet>
                    <field name="name"/>
                    <field name="probability"/>
                    <field name="automated_probability" invisible="1"/>
                    <field name="won_status" invisible="1"/>
                    <field name="active" invisible="1"/>
                </sheet>
            </form>`,
        search: `<search/>`,
    };
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction({
        name: "Leads",
        res_model: "crm.lead",
        res_id: 5,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    });
    await runAllTimers();

    await setOffline(true);
    await contains("button[name=action_restore]").click();
    // a call of another addon, which no one labels
    getService(OfflinePlugin).scheduleORM("crm.lead", "action_other_addon", [[5]], {}, {
        extras: { timeStamp: Date.now() + 1000, actionName: "Leads", displayName: "Lost bid" },
    });
    await animationFrame();
    expect(queuedMethods()).toEqual(["crm.lead.action_restore", "crm.lead.action_other_addon"]);
    await contains(".o_menu_systray .o_offline_systray").click();
    expect(queryAllTexts(".o_offline_systray_content .o_badge")).toEqual(["Restored", "Pending"]);
    expect(".o_offline_systray_content").toHaveText(/Lost bid/);
});

// Lead writes the framework queues by itself (inventory QUEUE rows B16, B17, B20, B22,
// B23, B24, C1, C2, C4, C5): crm only has to keep them reachable offline.

const editForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="priority" widget="priority"/>
            <field name="partner_id"/>
            <field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'no_create_edit': True}"/>
            <field name="description"/>
        </sheet>
    </form>`;

/** Steps the calls that reach the server (offline, the framework answers 502 first). */
function stepServerCalls(method) {
    onRpc("crm.lead", method, ({ args }) => {
        expect.step(`server: ${method} ${JSON.stringify(args[0])}`);
    });
}

test("[Offline] lead edits (priority, contact, tags, description) are queued as one web_save and replayed", async () => {
    stepServerCalls("web_save");
    let htmlEditor;
    patchWithCleanup(HtmlField.prototype, {
        onEditorLoad(editor) {
            htmlEditor = editor;
            return super.onEditorLoad(...arguments);
        },
    });
    await makeMockServer();
    const [partnerId] = MockServer.env["res.partner"].create([{ name: "Chairs Contact" }]);
    MockServer.env["crm.lead"].write([2], { partner_id: partnerId, tag_ids: [2] });
    MockServer.env["crm.lead"].write([1], { description: "<p>Asked for a quote</p>" });
    CrmLead._views = { form: editForm, search: `<search/>` };
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
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    // online, lead 2 shows its contact and tag: the framework keeps them in its
    // relational-field cache (as for every record loaded online)
    await getService("action").doAction(2);
    await getService("action").doAction(1);
    await runAllTimers();

    await setOffline(true);
    await click(".o_field_widget[name=priority] .o_priority_star:last");
    await animationFrame();
    await contains(".o_field_widget[name=partner_id] input").edit("Chairs", { confirm: false });
    await runAllTimers();
    await contains(".dropdown .dropdown-item:contains(Chairs Contact)").click();
    await contains(".o_field_widget[name=tag_ids] input").edit("Priority", { confirm: false });
    await runAllTimers();
    await contains(".dropdown .dropdown-item:contains(Priority customer)").click();
    const description = queryOne(".o_field_widget[name=description] .odoo-editor-editable p").firstChild;
    setSelection({ anchorNode: description, anchorOffset: description.length });
    await insertText(htmlEditor, " and a demo");
    await contains(".o_form_button_save").click();
    await animationFrame();
    expect.verifySteps([]); // nothing reached the server
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    const [ids, values] = queuedCalls()[0].args;
    expect(ids).toEqual([1]);
    expect(Object.keys(values).sort()).toEqual(["description", "partner_id", "priority", "tag_ids"]);
    expect(values.priority).toBe("3");
    expect(values.partner_id).toBe(partnerId);
    expect(values.description).toMatch(/Asked for a quote and a demo/);

    await setOffline(false);
    await expect.waitForSteps(["server: web_save [1]"]);
    expect(queuedCalls()).toEqual([]);
    const [lead] = MockServer.env["crm.lead"].browse(1);
    expect(lead.priority).toBe("3");
    expect(lead.partner_id).toBe(partnerId);
    expect(lead.tag_ids).toEqual([2]);
    expect(lead.description).toMatch(/Asked for a quote and a demo/);
});

const newLeadForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="expected_revenue"/>
            <field name="active" invisible="1"/>
        </sheet>
    </form>`;

test("[Offline] New needs the new-lead onchange: never loaded online, New is disabled offline", async () => {
    defineActions([
        {
            id: 1,
            name: "Leads",
            res_model: "crm.lead",
            res_id: 3,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        },
    ]);
    CrmLead._views = { form: newLeadForm, search: `<search/>` };
    const setOffline = mockCrmOffline(["crm.lead/onchange", "crm.lead/web_save"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();
    // online, New is there; the new-lead form (its server onchange) was never loaded
    expect(".o_form_button_create").toBeEnabled();

    await setOffline(true);
    // offline, nothing can answer that onchange: disabled, and unreachable
    expect(".o_form_button_create").not.toBeEnabled();
    queryOne(".o_form_button_create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await animationFrame();
    expect(".o_field_widget[name=name] input").toHaveValue("Meeting room");
    expect.verifySteps([]);
    expect(queuedCalls()).toEqual([]);

    await setOffline(false);
    expect(".o_form_button_create").toBeEnabled();
});

test("[Offline] a lead created with New offline is queued without an id and created on replay", async () => {
    stepServerCalls("web_save");
    defineActions([
        {
            id: 1,
            name: "Leads",
            res_model: "crm.lead",
            res_id: 3,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        },
    ]);
    CrmLead._views = { form: newLeadForm, search: `<search/>` };
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // online, New once: the framework keeps the new-lead form and its defaults
    await contains(".o_form_button_create").click();
    await contains(".o_form_button_cancel").click();
    await runAllTimers();

    await setOffline(true);
    expect(".o_form_button_create").toBeEnabled();
    await contains(".o_form_button_create").click();
    await contains(".o_field_widget[name=name] input").edit("Lead created offline");
    await contains(".o_field_widget[name=expected_revenue] input").edit("1500");
    await contains(".o_form_button_save").click();
    await animationFrame();
    // the cached defaults are refreshed from the network in the background: that fails
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.lead\/onchange"/]);
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    const [ids, values] = queuedCalls()[0].args;
    expect(ids).toEqual([]);
    expect(values.name).toBe("Lead created offline");
    expect(values.expected_revenue).toBe(1500);

    await setOffline(false);
    await expect.waitForSteps(["server: web_save []"]);
    expect(queuedCalls()).toEqual([]);
    expect(
        MockServer.env["crm.lead"].search_read([["name", "=", "Lead created offline"]], ["expected_revenue"])
    ).toEqual([{ id: 6, expected_revenue: 1500 }]);
});

/** Opens lead `resId` from a DB action (available offline once loaded), online. */
async function openLeadAction(resId) {
    defineActions([
        {
            id: 1,
            name: "Leads",
            res_model: "crm.lead",
            res_id: resId,
            views: [[false, "form"]],
            search_view_id: [false, "search"],
        },
    ]);
    CrmLead._views = { form: newLeadForm, search: `<search/>` };
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();
}

test("[Offline] Archive from the lead form's action menu is queued and replayed", async () => {
    stepServerCalls("action_archive");
    const setOffline = mockCrmOffline();
    await openLeadAction(1);

    await setOffline(true);
    await toggleActionMenu();
    await toggleMenuItem("Archive");
    await contains(".modal-footer .btn-primary").click();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.action_archive"]);
    expect(queuedCalls()[0].args).toEqual([[1]]);

    await setOffline(false);
    await expect.waitForSteps(["server: action_archive [1]"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].active).toBe(false);
});

test("[Offline] Unarchive of a lost lead from the action menu is queued and replayed", async () => {
    stepServerCalls("action_unarchive");
    const setOffline = mockCrmOffline();
    await openLeadAction(5); // "Lost bid": archived when lost

    await setOffline(true);
    await toggleActionMenu();
    await toggleMenuItem("Unarchive");
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.action_unarchive"]);
    expect(queuedCalls()[0].args).toEqual([[5]]);

    await setOffline(false);
    await expect.waitForSteps(["server: action_unarchive [5]"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(5)[0].active).toBe(true);
});

test("[Offline] Delete from the lead form's action menu is queued and replayed", async () => {
    stepServerCalls("web_unlink");
    const setOffline = mockCrmOffline();
    await openLeadAction(2);

    await setOffline(true);
    await toggleActionMenu();
    await toggleMenuItem("Delete");
    await contains(".modal-footer button.btn-danger").click();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_unlink"]);
    expect(queuedCalls()[0].args).toEqual([[2]]);

    await setOffline(false);
    await expect.waitForSteps(["server: web_unlink [2]"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].search([["id", "=", 2]])).toEqual([]);
});
