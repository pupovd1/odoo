import {
    defineMailModels,
    click,
    insertText,
    start,
    startServer,
} from "@mail/../tests/mail_test_helpers";
import {
    advanceTime,
    animationFrame,
    describe,
    expect,
    queryAllTexts,
    runAllTimers,
    test,
    waitFor,
    waitForNone,
} from "@odoo/hoot";
import { mockDate } from "@odoo/hoot-mock";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { shareTargetService } from "@web/webclient/share_target/share_target_service";
import {
    clickFieldDropdownItem,
    contains,
    defineActions,
    defineModels,
    fields,
    getKwArgs,
    getService,
    mockOffline,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";

/**
 * Each test opens the pipeline while the network works, then mockOffline()
 * answers every RPC with 502. Assertions before reconnect check the screen
 * and the local queue. Assertions after reconnect check the mock server.
 */

class Team extends models.Model {
    _name = "crm.team";
    name = fields.Char();
    use_opportunities = fields.Boolean({ default: true });
    company_id = fields.Many2one({ relation: "res.company" });
    _records = [
        { id: 1, name: "Team A", use_opportunities: true, company_id: 1 },
        { id: 2, name: "Team B", use_opportunities: true, company_id: 1 },
    ];

    get_team_switcher_data() {
        return {
            available: true,
            teams: this._filter([["use_opportunities", "=", true]]).map((team) => ({
                id: team.id,
                name: team.name,
                switcher_domain: [["team_id", "=", team.id]],
            })),
        };
    }
}

class Stage extends models.Model {
    _name = "crm.stage";
    name = fields.Char();
    is_won = fields.Boolean();
    team_ids = fields.Many2many({ relation: "crm.team" });
    _records = [
        { id: 1, name: "New" },
        { id: 2, name: "Won", is_won: true },
    ];
}

class Tag extends models.Model {
    _name = "crm.tag";
    name = fields.Char();
    _records = [
        { id: 1, name: "Hot" },
        { id: 2, name: "Warm" },
    ];
}

class LostReason extends models.Model {
    _name = "crm.lost.reason";
    name = fields.Char();
    _records = [{ id: 1, name: "Too expensive" }];
}

class LeadNote extends models.Model {
    _name = "crm.lead.note";
    name = fields.Char();
    lead_id = fields.Many2one({ relation: "crm.lead" });
    _records = [{ id: 1, name: "Call back", lead_id: 1 }];
}

class LeadDefinition extends models.Model {
    _name = "crm.lead.definition";
    name = fields.Char();
    definitions = fields.PropertiesDefinition();
    _records = [
        {
            id: 1,
            name: "Default",
            definitions: [{ name: "property_1", string: "Priority note", type: "char" }],
        },
    ];
}

class Lead extends models.Model {
    _name = "crm.lead";
    _inherit = ["mail.thread"];

    name = fields.Char();
    date_deadline = fields.Date({ string: "Expected closing" });
    stage_id = fields.Many2one({ relation: "crm.stage", group_expand: true });
    team_id = fields.Many2one({ relation: "crm.team" });
    partner_id = fields.Many2one({ relation: "res.partner" });
    tag_ids = fields.Many2many({ relation: "crm.tag" });
    note_ids = fields.One2many({ relation: "crm.lead.note", relation_field: "lead_id" });
    definition_id = fields.Many2one({ relation: "crm.lead.definition" });
    lead_properties = fields.Properties({
        definition_record: "definition_id",
        definition_record_field: "definitions",
    });
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
        default: "opportunity",
    });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [
            ["pending", "Pending"],
            ["won", "Won"],
            ["lost", "Lost"],
        ],
        default: "pending",
    });
    meeting_state = fields.Char();
    activity_summary = fields.Char();

    _records = [
        {
            id: 1,
            name: "Opp 1",
            stage_id: 1,
            team_id: 1,
            type: "opportunity",
            won_status: "pending",
            active: true,
            definition_id: 1,
            lead_properties: { property_1: "cold" },
            note_ids: [1],
            date_deadline: "2021-02-01",
        },
        {
            id: 2,
            name: "Opp 2",
            stage_id: 1,
            team_id: 1,
            type: "lead",
            won_status: "pending",
            active: true,
            date_deadline: "2021-01-01",
        },
        {
            id: 3,
            name: "Lost Opp",
            stage_id: 1,
            team_id: 1,
            type: "opportunity",
            won_status: "lost",
            active: false,
            date_deadline: "2021-03-01",
        },
        {
            id: 4,
            name: "Won Opp",
            stage_id: 2,
            team_id: 1,
            type: "opportunity",
            won_status: "won",
            active: true,
            date_deadline: "2021-01-01",
        },
    ];

    get_rainbowman_message() {
        return false;
    }

    action_set_won_rainbowman(ids) {
        ({ ids } = getKwArgs(arguments, "ids"));
        this.write(ids, { stage_id: 2, won_status: "won" });
        return true;
    }

    action_set_lost(ids) {
        ({ ids } = getKwArgs(arguments, "ids"));
        this.write(ids, { won_status: "lost", active: false });
        return true;
    }

    action_restore(ids) {
        ({ ids } = getKwArgs(arguments, "ids"));
        this.write(ids, { won_status: "pending", active: true });
        return true;
    }

    action_convert_to_opportunity(ids) {
        ({ ids } = getKwArgs(arguments, "ids"));
        this.write(ids, { type: "opportunity" });
        return true;
    }

    action_schedule_meeting(ids) {
        ({ ids } = getKwArgs(arguments, "ids"));
        this.write(ids, { meeting_state: "scheduled" });
        return true;
    }

    activity_schedule(ids) {
        const kwargs = getKwArgs(arguments, "ids", "summary", "note", "date_deadline");
        this.write(kwargs.ids, { activity_summary: kwargs.summary || "Offline activity" });
        return true;
    }

    /**
     * Mail's mock only flags has_activities on ServerModel. This model extends
     * Model, so the chatter activity button stays hidden unless get_views says so.
     */
    get_views() {
        const result = super.get_views(...arguments);
        if (result.models["crm.lead"]) {
            result.models["crm.lead"].has_activities = true;
        }
        return result;
    }
}

defineMailModels();
defineModels([Team, Stage, Tag, LostReason, LeadNote, LeadDefinition, Lead]);

const FORM_ARCH = `
    <form js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object"
                data-available-offline="" invisible="type == 'lead'"/>
            <button name="action_convert_to_opportunity" string="Convert to Opportunity" type="object"
                data-available-offline="" invisible="type == 'opportunity'"/>
            <button name="%(crm.crm_lead_lost_action)d" string="Lost" type="action"
                data-available-offline="" context="{'offline_method': 'action_set_lost'}"
                invisible="won_status != 'pending'"/>
            <button name="action_restore" string="Restore" type="object" data-available-offline=""
                invisible="won_status != 'lost'"/>
            <button name="action_schedule_meeting" string="Schedule Meeting" type="object"
                data-available-offline=""/>
            <field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/>
        </header>
        <sheet>
            <field name="name"/>
            <field name="type"/>
            <field name="won_status"/>
            <field name="team_id"/>
            <field name="partner_id"/>
            <field name="tag_ids" widget="many2many_tags"/>
            <field name="meeting_state"/>
            <field name="activity_summary"/>
            <field name="note_ids">
                <list editable="bottom">
                    <field name="name"/>
                </list>
            </field>
            <widget name="pls_tooltip_button"/>
        </sheet>
    </form>`;

const FORM_ARCH_CHATTER = FORM_ARCH.replace("</form>", "<chatter/></form>");

const FORM_ARCH_PROPERTIES = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="definition_id"/>
            <field name="lead_properties"/>
        </sheet>
    </form>`;

Lead._views = {
    "kanban,false": `
        <kanban js_class="crm_kanban" default_group_by="stage_id">
            <templates>
                <t t-name="card"><field name="name"/></t>
            </templates>
        </kanban>`,
    "list,false": `
        <list js_class="crm_list">
            <field name="name"/>
            <field name="stage_id"/>
        </list>`,
    "form,false": FORM_ARCH,
    "search,false": `
        <search>
            <field name="name"/>
            <filter name="forecast" string="Forecast" context="{'forecast_filter': 1}"/>
            <filter name="groupby_date_deadline" context="{'group_by': 'date_deadline'}"/>
        </search>`,
};

defineActions([
    {
        id: 1,
        name: "CRM Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
        ],
        context: { show_team_switcher: true, show_lead_gen_button: true },
    },
    {
        id: 99,
        xml_id: "crm.crm_lead_action_my_activities",
        name: "My Activities",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

function ormMethods() {
    return Object.values(getService(OfflinePlugin)._ormToSync()).map((entry) => entry.value.method);
}

function httpRoutes() {
    return Object.values(getService(OfflinePlugin)._httpToSync()).map((entry) => entry.value.route);
}

function useForm(arch) {
    Lead._views = { ...Lead._views, "form,false": arch };
}

async function openPipeline() {
    onRpc("has_access", () => true);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await animationFrame();
}

async function openForm(resId) {
    onRpc("has_access", () => true);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId } });
    await animationFrame();
}

async function disconnect(setOffline) {
    await runAllTimers();
    await setOffline(true);
    await getService(OfflinePlugin).getVisitedStatus();
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
}

async function reconnect(setOffline) {
    await setOffline(false);
    for (let i = 0; i < 8; i++) {
        await runAllTimers();
        await advanceTime(1100);
    }
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect(ormMethods()).toEqual([]);
    expect(httpRoutes()).toEqual([]);
}

async function see(target, options = {}) {
    if (options.count === 0) {
        const { count: _count, ...rest } = options;
        await waitForNone(target, rest);
        return;
    }
    await waitFor(target, options);
}

async function visitNewForm() {
    await contains(".o-kanban-button-new").click();
    await see(".o_form_view");
    await contains(".o_back_button").click();
    await see(".o_kanban_view");
}

describe.current.tags("desktop");
describe("CRM offline end to end", () => {
    test("pipeline stays readable through a full disconnect and reconnect", async () => {
        const setOffline = mockOffline();
        await openPipeline();
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record", { text: "Opp 2" });
        await see(".o_cp_team_switcher", { text: "All Teams" });

        await disconnect(setOffline);
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record", { text: "Opp 2" });
        await see(".o_cp_team_switcher", { text: "All Teams" });
        await see("button", { text: "New" });
        await see(".o_kanban_record:contains(Lost Opp)", { count: 0 });

        await reconnect(setOffline);
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record", { text: "Opp 2" });
    });

    test("a new lead created offline is stored when the network returns", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", ({ args }) => {
            expect.step("web_save");
            // The offline onchange never fills stage_id. A grouped kanban hides
            // a lead with no stage, so give the created record the New stage.
            const vals = args[1];
            if (vals && vals.name === "Offline Lead" && !vals.stage_id) {
                vals.stage_id = 1;
            }
        });
        await openPipeline();
        await visitNewForm();
        await disconnect(setOffline);
        expect.errors(1); // onchange is rejected while offline

        await contains(".o-kanban-button-new:not(.o_disabled_offline)").click();
        await expect.waitForErrors([
            `Connection to "/web/dataset/call_kw/crm.lead/onchange" couldn't be established`,
        ]);
        await contains(".o_field_widget[name=name] input").edit("Offline Lead");
        await contains(".o_form_button_save").click();
        expect(".o_field_widget[name=name] input").toHaveValue("Offline Lead");
        expect(ormMethods()).toEqual(["web_save"]);
        await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
        await animationFrame();
        expect(queryAllTexts(".o-dropdown--menu .o_offline_systray_content").join("\n")).toInclude(
            "Created"
        );

        await reconnect(setOffline);
        await expect.waitForSteps(["web_save"]);
        await getService("action").doAction(1);
        await see(".o_kanban_record", { text: "Offline Lead" });
    });

    test("an edit made offline is written when the network returns", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", () => expect.step("web_save"));
        await openForm(1);
        expect(".o_field_widget[name=name] input").toHaveValue("Opp 1");

        await disconnect(setOffline);
        await contains(".o_field_widget[name=name] input").edit("Opp 1 renamed");
        await contains(".o_form_button_save").click();
        expect(".o_field_widget[name=name] input").toHaveValue("Opp 1 renamed");
        expect(ormMethods()).toInclude("web_save");

        await reconnect(setOffline);
        await expect.waitForSteps(["web_save"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
        expect(".o_field_widget[name=name] input").toHaveValue("Opp 1 renamed");
    });

    test("a kanban stage move queues offline and lands in the target stage after reconnect", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", () => expect.step("web_save"));
        await openPipeline();
        await see(".o_kanban_group", { count: 2 });
        await see(".o_kanban_group:eq(0) .o_kanban_record", { text: "Opp 1" });

        await disconnect(setOffline);
        await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(Opp 1)").dragAndDrop(
            ".o_kanban_group:eq(1)"
        );
        await see(".o_kanban_group:eq(1) .o_kanban_record", { text: "Opp 1" });
        expect(ormMethods()).toInclude("web_save");

        await reconnect(setOffline);
        await expect.waitForSteps(["web_save"]);
        await getService("action").doAction(1);
        await see(".o_kanban_group:contains(Won) .o_kanban_record", { text: "Opp 1" });
    });

    test("Won, Lost, Restore, Convert, and Schedule Meeting replay after reconnect", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "action_set_won_rainbowman", () => expect.step("won"));
        onRpc("crm.lead", "action_set_lost", () => expect.step("lost"));
        onRpc("crm.lead", "action_restore", () => expect.step("restore"));
        onRpc("crm.lead", "action_convert_to_opportunity", () => expect.step("convert"));
        onRpc("crm.lead", "action_schedule_meeting", () => expect.step("meeting"));

        await openForm(1);
        await disconnect(setOffline);
        await contains("button[name=action_set_won_rainbowman]").click();
        await see(".o_notification", { text: "Queued for sync when back online" });
        expect(ormMethods()).toInclude("action_set_won_rainbowman");
        await reconnect(setOffline);
        await expect.waitForSteps(["won"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
        expect(".o_field_widget[name=won_status] input").toHaveValue("Won");

        await getService("action").doAction(1, { viewType: "form", props: { resId: 2 } });
        await disconnect(setOffline);
        await contains("button[name=action_convert_to_opportunity]").click();
        await contains("button[name=action_schedule_meeting]").click();
        expect(ormMethods()).toInclude("action_convert_to_opportunity");
        expect(ormMethods()).toInclude("action_schedule_meeting");
        await reconnect(setOffline);
        await expect.waitForSteps(["convert", "meeting"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 2 } });
        expect(".o_field_widget[name=type] input").toHaveValue("Opportunity");
        expect(".o_field_widget[name=meeting_state] input").toHaveValue("scheduled");

        await disconnect(setOffline);
        await contains("button", { text: "Lost" }).click();
        expect(ormMethods()).toInclude("action_set_lost");
        await reconnect(setOffline);
        await expect.waitForSteps(["lost"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 2 } });
        expect(".o_field_widget[name=won_status] input").toHaveValue("Lost");

        await disconnect(setOffline);
        await contains("button[name=action_restore]").click();
        expect(ormMethods()).toInclude("action_restore");
        await reconnect(setOffline);
        await expect.waitForSteps(["restore"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 2 } });
        expect(".o_field_widget[name=won_status] input").toHaveValue("Pending");
    });

    test("Duplicate queues a copy and the copy exists after reconnect", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "copy", () => expect.step("copy"));
        await openForm(1);
        await disconnect(setOffline);

        await toggleActionMenu();
        await toggleMenuItem("Duplicate");
        await see(".o_notification", { text: "Duplicate queued for sync when back online" });
        expect(ormMethods()).toInclude("copy");

        await reconnect(setOffline);
        await expect.waitForSteps(["copy"]);
        await getService("action").doAction(1);
        expect(".o_kanban_record:not(.o_kanban_ghost)").toHaveCount(4);
    });

    test("a partner quick-create and a tag link sync with the lead", async () => {
        const setOffline = mockOffline();
        onRpc("res.partner", "name_create", () => expect.step("name_create"));
        onRpc("crm.lead", "web_save", ({ args }) => {
            const vals = args[1] || {};
            if (vals.partner_id || vals.tag_ids) {
                expect.step("web_save");
            }
        });
        await openForm(1);
        await contains(".o_field_many2one[name=partner_id] input").click();
        await contains(".o_form_renderer").click();
        await contains(".o_field_many2many_tags[name=tag_ids] input").click();
        await contains(".o_form_renderer").click();

        await disconnect(setOffline);
        await contains(".o_field_many2one[name=partner_id] input").edit("Acme Offline", {
            confirm: false,
        });
        await runAllTimers();
        await contains(".o_m2o_dropdown_option_create").click();
        expect(".o_field_many2one[name=partner_id] input").toHaveValue("Acme Offline");
        await contains(".o_field_many2many_tags[name=tag_ids] input").click();
        await clickFieldDropdownItem("tag_ids", "Hot");
        await see(".o_field_many2many_tags .badge", { text: "Hot" });
        await contains(".o_form_button_save").click();
        expect(ormMethods()).toInclude("name_create");
        expect(ormMethods()).toInclude("web_save");

        await reconnect(setOffline);
        await expect.waitForSteps(["name_create", "web_save"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
        expect(".o_field_many2one[name=partner_id] input").toHaveValue("Acme Offline");
        await see(".o_field_many2many_tags .badge", { text: "Hot" });
    });

    test("an existing one2many line edited offline is written on reconnect", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "web_save", () => expect.step("web_save"));
        await openForm(1);
        await see(".o_field_one2many .o_data_cell", { text: "Call back" });

        await disconnect(setOffline);
        expect.errors(1); // editing the line onchanges the note model
        await contains(".o_field_one2many .o_data_cell").click();
        await contains(".o_field_one2many .o_data_cell input").edit("Call back tomorrow");
        await expect.waitForErrors([
            `Connection to "/web/dataset/call_kw/crm.lead.note/onchange" couldn't be established`,
        ]);
        await contains(".o_form_button_save").click();
        await see(".o_field_one2many .o_data_cell", { text: "Call back tomorrow" });
        expect(ormMethods()).toInclude("web_save");

        await reconnect(setOffline);
        await expect.waitForSteps(["web_save"]);
        await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
        await see(".o_field_one2many .o_data_cell", { text: "Call back tomorrow" });
    });

    test("a lead property edited offline is stored on reconnect", async () => {
        useForm(FORM_ARCH_PROPERTIES);
        try {
            const setOffline = mockOffline();
            onRpc("crm.lead", "web_save", () => expect.step("web_save"));
            await openForm(1);
            expect(".o_field_properties input").toHaveValue("cold");

            await disconnect(setOffline);
            await contains(".o_field_properties input").edit("warm");
            await contains(".o_form_button_save").click();
            expect(".o_field_properties input").toHaveValue("warm");
            expect(ormMethods()).toInclude("web_save");

            await reconnect(setOffline);
            await expect.waitForSteps(["web_save"]);
            await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
            expect(".o_field_properties input").toHaveValue("warm");
        } finally {
            useForm(FORM_ARCH);
        }
    });

    test("a note logged offline stays on screen and is posted when the network returns", async () => {
        useForm(FORM_ARCH_CHATTER);
        try {
            const setOffline = mockOffline();
            onRpc("/mail/message/post", async (request) => {
                const { params } = await request.clone().json();
                expect.step(params.post_data?.body || "empty-body");
            });
            await openForm(1);
            await see("button.o-mail-Chatter-logNote");

            await disconnect(setOffline);
            await contains("button.o-mail-Chatter-logNote").click();
            await insertText(".o-mail-Composer-input", "Saved from the train");
            await contains(".o-mail-Composer-send:enabled").click();
            await animationFrame();
            const message = document.querySelector(".o-mail-Message");
            expect(message?.innerText || "NO_MESSAGE").toInclude("Saved from the train");
            expect(message?.innerText || "NO_MESSAGE").toInclude("saved offline");
            expect(httpRoutes()).toInclude("/mail/message/post");

            await reconnect(setOffline);
            // The failed attempt and the sync both hit the route.
            await expect.waitForSteps(["Saved from the train", "Saved from the train"]);
            const synced = document.querySelector(".o-mail-Message");
            expect(synced?.innerText || "NO_MESSAGE").toInclude("Saved from the train");
            expect(synced?.innerText || "NO_MESSAGE").not.toInclude("saved offline");
        } finally {
            useForm(FORM_ARCH);
        }
    });

    test("scheduling an activity offline replays activity_schedule on reconnect", async () => {
        useForm(FORM_ARCH_CHATTER);
        try {
            const setOffline = mockOffline();
            onRpc("crm.lead", "activity_schedule", () => expect.step("activity_schedule"));
            await openForm(1);
            await see("button.o-mail-Chatter-activity");

            await disconnect(setOffline);
            await contains("button.o-mail-Chatter-activity").click();
            await see(".o_offline_activity_dialog");
            await contains(".o_offline_activity_dialog input[type=text]").edit("Call the buyer");
            await contains(".modal-footer .btn-primary").click();
            await see(".o_notification", { text: "Activity queued for sync" });
            expect(ormMethods()).toInclude("activity_schedule");

            await reconnect(setOffline);
            await expect.waitForSteps(["activity_schedule"]);
            await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
            expect(".o_field_widget[name=activity_summary] input").toHaveValue("Call the buyer");
        } finally {
            useForm(FORM_ARCH);
        }
    });

    test("prefetch makes forms openable offline, and they still open after reconnect", async () => {
        const setOffline = mockOffline();
        await openPipeline();
        await contains(".o_crm_offline_prefetch").click();
        await see(".o_notification", { timeout: 8000 });
        expect(queryAllTexts(".o_notification").join("\n")).toInclude("leads ready offline");

        await disconnect(setOffline);
        expect(document.querySelector(".o_crm_offline_prefetch").disabled).toBe(true);
        expect(".o_kanban_record:not(.o_kanban_ghost).o_disabled_offline").toHaveCount(0);
        // Opening the record replays the cached read, which still revalidates.
        // The cached form still revalidates, which fails while the network is down.
        expect.errors(1);
        await contains(".o_kanban_record", { text: "Opp 1" }).click();
        await see(".o_field_widget[name=name] input");
        expect(".o_field_widget[name=name] input").toHaveValue("Opp 1");
        await expect.waitForErrors([
            `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established`,
        ]);

        await reconnect(setOffline);
        expect(".o_field_widget[name=name] input").toHaveValue("Opp 1");
    });

    test("probability insights warn while offline and open again after reconnect", async () => {
        const setOffline = mockOffline();
        onRpc("crm.lead", "prepare_pls_tooltip_data", () => {
            expect.step("pls");
            return {
                probability: 40,
                team_name: "Team A",
                low_3_data: [],
                top_3_data: [],
            };
        });
        await openForm(1);
        await disconnect(setOffline);
        await contains(".o_crm_pls_tooltip_button").click();
        await see(".o_notification", { text: "Probability insights require a connection" });
        expect.verifySteps([]);

        await reconnect(setOffline);
        await contains(".o_crm_pls_tooltip_button").click();
        await see(".o_crm_pls_tooltip");
        await expect.waitForSteps(["pls"]);
    });

    test("the forecast filter still hides past records after a disconnect", async () => {
        mockDate("2021-02-10 00:00:00");
        const setOffline = mockOffline();
        await mountView({
            arch: `
                <kanban js_class="forecast_kanban" default_group_by="date_deadline">
                    <templates>
                        <t t-name="card"><field name="name"/></t>
                    </templates>
                </kanban>`,
            searchViewArch: Lead._views["search,false"],
            resModel: "crm.lead",
            type: "kanban",
            context: {
                search_default_forecast: true,
                search_default_groupby_date_deadline: true,
                forecast_field: "date_deadline",
            },
            groupBy: ["date_deadline"],
        });
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record:contains(Opp 2)", { count: 0 });

        await disconnect(setOffline);
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record:contains(Opp 2)", { count: 0 });

        await reconnect(setOffline);
        await see(".o_kanban_record", { text: "Opp 1" });
        await see(".o_kanban_record:contains(Opp 2)", { count: 0 });
        await see(".o_searchview_facet", { text: "Forecast" });
    });

    test("My Activities warns offline until the action has been opened online", async () => {
        const pyEnv = await startServer();
        const setOffline = mockOffline();
        await start();
        const leadId = pyEnv["crm.lead"].create({ name: "Activity Opp", type: "opportunity" });
        pyEnv["mail.activity"].create({
            res_id: leadId,
            res_model: "crm.lead",
        });
        await click(".o_menu_systray i[aria-label='Activities']");
        await see(".o-mail-ActivityMenu-counter");
        // The first open fetches groups and the menu closes on that update.
        if (!document.querySelector(".o-dropdown--menu .o-mail-ActivityMenu")) {
            await click(".o_menu_systray i[aria-label='Activities']");
        }
        await animationFrame();
        const group = document.querySelector(".o-mail-ActivityGroup");
        expect(`${group?.dataset.modelName || "no-model"}|${group?.innerText || "no-text"}`).toInclude(
            "crm.lead"
        );
        // Cache the action so the offline click can decide without a network read.
        await getService("action").loadAction("crm.crm_lead_action_my_activities");

        await disconnect(setOffline);
        // The menu may still be open from the online check. Clicking the
        // toggler again would close it.
        if (!document.querySelector(".o-dropdown--menu .o-mail-ActivityMenu")) {
            await contains(".o_menu_systray i[aria-label='Activities']").click();
        }
        await contains(".o-mail-ActivityMenu [data-model_name='crm.lead']").click();
        await see(".o_notification", {
            text: "My Activities is not available offline. Open it online first.",
        });

        await reconnect(setOffline);
        if (!document.querySelector(".o-dropdown--menu .o-mail-ActivityMenu")) {
            await contains(".o_menu_systray i[aria-label='Activities']").click();
        }
        await contains(".o-mail-ActivityMenu [data-model_name='crm.lead']").click();
        await see(".o_kanban_view");
        expect(getService("action").currentController.action.id).toBe(99);
        await getService("action").doAction(1);
        await disconnect(setOffline);
        await contains(".o_menu_systray i[aria-label='Activities']").click();
        // Cached views still revalidate and report the lost connection.
        expect.errors(1);
        await contains(".o-mail-ActivityMenu [data-model_name='crm.lead']").click();
        await see(".o_kanban_view");
        expect(getService("action").currentController.action.id).toBe(99);
        await expect.waitForErrors([
            `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established`,
        ]);
        await see(".o_notification:contains(not available offline)", { count: 0 });
    });

    test("share-target teams stay available across a disconnect", async () => {
        const pngFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
        patchWithCleanup(shareTargetService, {
            _getShareTargetFiles: async () => [pngFile],
        });
        const setOffline = mockOffline();
        await mountWithCleanup(WebClient);
        await see(".o_dialog div.text-truncate", { text: "card.png" });
        await contains(".o_dialog button", { text: "Lead" }).click();
        await see(".o_dialog h3", { text: "In sales team" });

        await disconnect(setOffline);
        await see(".o_dialog button", { text: "Lead" });
        await see(".o_dialog h3", { text: "In sales team" });

        await reconnect(setOffline);
        await see(".o_dialog h3", { text: "In sales team" });
    });
});
