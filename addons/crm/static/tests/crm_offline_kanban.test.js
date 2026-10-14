import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { beforeEach, expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame, hover, queryFirst, runAllTimers } from "@odoo/hoot-dom";
import { mockDate } from "@odoo/hoot-mock";
import {
    contains,
    createKanbanRecord,
    defineActions,
    defineModels,
    discardKanbanRecord,
    editKanbanRecordQuickCreateInput,
    getService,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    validateKanbanRecord,
} from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { WebClient } from "@web/webclient/webclient";
import {
    CrmLead,
    CrmStage,
    CrmTag,
    CrmTeam,
    mockCrmOffline,
    queuedCalls,
    queuedMethods,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

const pipelineArch = `
    <kanban js_class="crm_kanban" default_group_by="stage_id" on_create="quick_create"
        quick_create_view="crm.quick_create_opportunity_form">
        <field name="stage_id" options='{"group_by_tooltip": {"name": "Stage"}}'/>
        <progressbar field="activity_state" colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
            sum_field="expected_revenue" recurring_revenue_sum_field="recurring_revenue_monthly"/>
        <templates>
            <t t-name="menu">
                <a role="menuitem" type="open" class="dropdown-item">Edit</a>
                <a role="menuitem" type="delete" class="dropdown-item">Delete</a>
            </t>
            <t t-name="card">
                <field name="name"/>
                <field name="priority" widget="priority"/>
                <field name="is_rotting" invisible="1"/>
            </t>
        </templates>
    </kanban>`;

class Lead extends CrmLead {
    _views = {
        kanban: pipelineArch,
        search: `<search><field name="name"/></search>`,
        form: `<form js_class="crm_form"><field name="name"/></form>`,
        "kanban,2": `
            <kanban js_class="forecast_kanban" on_create="quick_create" quick_create_view="crm.quick_create_opportunity_form">
                <field name="date_deadline"/>
                <templates>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
        "search,2": `
            <search>
                <filter name="forecast" string="Forecast" context="{'forecast_filter':1}"/>
                <filter name="groupby_date_deadline" context="{'group_by':'date_deadline'}"/>
            </search>`,
        "form,crm.quick_create_opportunity_form": `
            <form>
                <field name="partner_id"/>
                <field name="name"/>
                <field name="email_from"/>
                <field name="phone"/>
                <field name="expected_revenue"/>
            </form>`,
    };
}

defineModels([CrmStage, CrmTeam, CrmTag, Lead]);
defineMailModels();
defineActions([
    {
        id: 2,
        name: "Forecast",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[2, "kanban"]],
        search_view_id: [2, "search"],
        context: {
            search_default_forecast: true,
            search_default_groupby_date_deadline: true,
            forecast_field: "date_deadline",
        },
    },
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

onRpc("crm.lead", "get_rainbowman_message", () => "Go, go, go! Congrats for your first deal.");

beforeEach(() => {
    patchWithCleanup(AnimatedNumber, { enableAnimations: false });
});

/** Steps the calls that reach the server (offline, the framework answers 502 first). */
function stepServerSaves() {
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`server: web_save ${JSON.stringify(args)}`);
    });
}

test.tags("desktop");
test("[Offline] dragging a lead to another stage queues its save, with no rainbowman lookup", async () => {
    const setOffline = mockCrmOffline(["crm.lead/get_rainbowman_message"]);
    stepServerSaves();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(1);

    await setOffline(true);
    await contains(".o_kanban_record:contains(Office chairs)").dragAndDrop(".o_kanban_group:eq(2)");
    await runAllTimers();
    // queued, shown in the Won column at once; the rainbowman lookup isn't attempted
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([[1], { stage_id: 3 }]);
    expect(".o_kanban_group:eq(2) .o_kanban_record").toHaveCount(2);
    expect(".o_reward").toHaveCount(0);

    // replayed once back online, still without the detached rainbowman
    await setOffline(false);
    await expect.waitForSteps([`server: web_save [[1],{"stage_id":3}]`]);
    expect(queuedCalls()).toEqual([]);
    expect(".o_reward").toHaveCount(0);
});

test.tags("desktop");
test("[Online] dragging a lead to the won stage still looks up the rainbowman", async () => {
    mockCrmOffline(["crm.lead/get_rainbowman_message"]);
    stepServerSaves();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_kanban_record:contains(Office chairs)").dragAndDrop(".o_kanban_group:eq(2)");
    await expect.waitForSteps([
        `server: web_save [[1],{"stage_id":3}]`,
        "crm.lead/get_rainbowman_message",
    ]);
    expect(".o_reward").toHaveCount(1);
});

test("[Offline] the recurring-revenue probe lost with the connection is issued again once it is back", async () => {
    // the pipeline loads while the network flaps: the probe is lost, the app
    // still believing it's online
    let networkDown = true;
    onRpc("/web/dataset/call_kw/res.users/has_group", async (request) => {
        const { params } = await request.json();
        const lost = networkDown && params.args[1] === "crm.group_use_recurring_revenues";
        return lost ? new Response("", { status: 502 }) : undefined;
    });
    let probes = 0;
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "crm.group_use_recurring_revenues") {
            probes++;
        }
        return true;
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await animationFrame();
    expect(probes).toBe(0); // lost before reaching the server
    const proposition = ".o_kanban_group:eq(1) .o_kanban_counter";
    expect(proposition).not.toHaveText(/MRR/);
    expect(".o_dialog").toHaveCount(0); // no error

    // back online: probed again (web's user cache keeps the lost probe: each
    // column asks the server), and the aggregate shows for a user of the group,
    // without reloading the page
    networkDown = false;
    await setOffline(false);
    await animationFrame();
    expect(probes).toBeGreaterThan(0);
    expect(`${proposition} .o_animated_number`).toHaveCount(2);
});

test("[Offline] the recurring-revenue aggregate is not probed offline and is hidden", async () => {
    // opened again offline, the pipeline comes from the framework's cache, which
    // still tries to refresh it from the server in the background
    expect.errors(1);
    let probes = 0;
    patchWithCleanup(user, {
        hasGroup(group) {
            if (group === "crm.group_use_recurring_revenues") {
                probes++;
                return Promise.resolve(true);
            }
            return super.hasGroup(...arguments);
        },
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(probes).toBeGreaterThan(0);
    // Proposition: expected revenue + recurring revenue
    const proposition = ".o_kanban_group:eq(1) .o_kanban_counter";
    expect(`${proposition} .o_animated_number`).toHaveCount(2);

    await setOffline(true);
    probes = 0;
    // hidden, not shown as zero
    expect(`${proposition} .o_animated_number`).toHaveCount(1);
    expect(proposition).not.toHaveText(/MRR/);

    // the pipeline opened again offline (from the cache) issues no probe
    await getService("action").doAction(1);
    await animationFrame();
    expect(".o_kanban_record").toHaveCount(4);
    expect(probes).toBe(0);
    expect(proposition).not.toHaveText(/MRR/);
    await expect.waitForErrors([`Connection to "/web/dataset/call_kw/crm.lead/web_read_group"`]);

    // back online: probed, shown again
    await setOffline(false);
    await getService("action").doAction(1);
    expect(probes).toBeGreaterThan(0);
    expect(`${proposition} .o_animated_number`).toHaveCount(2);
});

test.tags("desktop");
test("[Offline] pipeline: stage configuration, card menus, progress bar and stage tooltip are unavailable", async () => {
    const setOffline = mockCrmOffline([
        "crm.lead/web_search_read",
        "crm.stage/read",
        "crm.stage/name_create",
    ]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect(".o_column_quick_create").toHaveCount(1);
    expect(".o_kanban_group.o_group_draggable").toHaveCount(3);
    expect(".o_kanban_group:first .o_group_config button").toBeEnabled();
    expect(".o_kanban_record:first .o_dropdown_kanban button").toBeEnabled();

    await setOffline(true);
    // add a stage: hidden; reorder stages: off
    expect(".o_column_quick_create").toHaveCount(0);
    expect(".o_kanban_group.o_group_draggable").toHaveCount(0);
    // column settings (edit / delete a stage) and card menus: disabled
    expect(".o_kanban_group:first .o_group_config button").not.toBeEnabled();
    expect(".o_kanban_record:first .o_dropdown_kanban button").not.toBeEnabled();
    // progress bar filter: even a programmatic click doesn't reload the column
    queryFirst(".o_kanban_group:first .o_column_progress .progress-bar").click();
    await animationFrame();
    // stage tooltip: not read offline
    await hover(".o_kanban_group:first .o_column_title");
    await advanceTime(1000);
    expect.verifySteps([]);
    expect(".o-tooltip").toHaveCount(0);

    await setOffline(false);
    expect(".o_column_quick_create").toHaveCount(1);
    expect(".o_kanban_group.o_group_draggable").toHaveCount(3);
    expect(".o_kanban_group:first .o_group_config button").toBeEnabled();
    expect(".o_kanban_record:first .o_dropdown_kanban button").toBeEnabled();
    await hover(".o_kanban_group:eq(1) .o_column_title");
    await advanceTime(1000);
    expect.verifySteps(["crm.stage/read"]);
});

test.tags("desktop");
test("[Offline] forecast: the next-period column is hidden offline, moves between periods are queued", async () => {
    mockDate("2023-09-01 00:00:00");
    const setOffline = mockCrmOffline(["crm.lead/web_read_group"]);
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`server: web_save ${JSON.stringify(Object.keys(args[1]))}`);
    });
    await mountView({
        arch: `
            <kanban js_class="forecast_kanban">
                <templates>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
        searchViewArch: `
            <search>
                <filter name="forecast" string="Forecast" context="{'forecast_filter':1}"/>
                <filter name="groupby_date_deadline" context="{'group_by':'date_deadline'}"/>
            </search>`,
        resModel: "crm.lead",
        type: "kanban",
        context: {
            search_default_forecast: true,
            search_default_groupby_date_deadline: true,
            forecast_field: "date_deadline",
        },
        groupBy: ["date_deadline"],
    });
    expect.verifySteps(["crm.lead/web_read_group"]);
    const september = ".o_kanban_group:has(.o_column_title:contains(September 2023))";
    const october = ".o_kanban_group:has(.o_column_title:contains(October 2023))";
    expect(".o_column_quick_create").toHaveCount(1);
    expect(`${september} .o_kanban_record`).toHaveCount(2);
    expect(`${october} .o_kanban_record`).toHaveCount(1);

    await setOffline(true);
    // "add the next period": hidden, so no new (uncached) read
    expect(".o_column_quick_create").toHaveCount(0);
    // moving a lead to another period: queued (QUEUE, framework web_save)
    await contains(`${september} .o_kanban_record:contains(Office chairs)`).dragAndDrop(october);
    await runAllTimers();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args[0]).toEqual([1]);
    expect(Object.keys(queuedCalls()[0].args[1])).toEqual(["date_deadline"]);
    expect(`${october} .o_kanban_record`).toHaveCount(2);

    await setOffline(false);
    await expect.waitForSteps([`server: web_save ["date_deadline"]`]);
    expect(queuedCalls()).toEqual([]);
    expect(".o_column_quick_create").toHaveCount(1);
});

test("[Offline] the rotting badge of a column doesn't filter it offline", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_search_read"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    const badge = ".o_kanban_group:eq(0) .o_kanban_counter .badge.text-bg-danger";
    expect(badge).toHaveCount(1); // "Office chairs" is rotting
    expect(badge).not.toHaveClass("o_disabled_offline");

    await setOffline(true);
    expect(badge).toHaveClass(["o_disabled_offline", "pe-none"]);
    queryFirst(badge).click();
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_kanban_group:eq(0)").not.toHaveClass("o_kanban_group_show_danger");

    await setOffline(false);
    expect(badge).not.toHaveClass("o_disabled_offline");
    await contains(badge).click();
    await expect.waitForSteps(["crm.lead/web_search_read"]);
    expect(".o_kanban_group:eq(0)").toHaveClass("o_kanban_group_show_danger");
});

test("[Offline] a lead quick-created offline is queued in its column's stage and replayed; no contact creation", async () => {
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`server: web_save ${JSON.stringify(args[0])}`);
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // online, quick create once: the framework keeps its form and its defaults
    await createKanbanRecord();
    await discardKanbanRecord();
    await runAllTimers();

    await setOffline(true);
    expect("button.o-kanban-button-new").not.toHaveClass("o_disabled_offline");
    await createKanbanRecord();
    const contactInput = ".o_kanban_quick_create .o_field_widget[name=partner_id] input";
    if (getService("ui").isSmall) {
        // small screens pick a contact in the search dialog, whose New button the
        // framework disables offline
        expect(contactInput).toHaveAttribute("readonly");
    } else {
        // the contact search offers no creation offline (a queued lead can't link a
        // contact that only exists after the replay)
        await contains(contactInput).edit("Chairs", { confirm: false });
        await runAllTimers();
        expect(".o_kanban_quick_create .o-autocomplete--dropdown-menu").toHaveCount(1);
        expect(
            ".o_m2o_dropdown_option_create, .o_m2o_dropdown_option_create_edit, .o_m2o_dropdown_option_search_more"
        ).toHaveCount(0);
        await contains(contactInput).clear({ confirm: false });
    }
    await editKanbanRecordQuickCreateInput("name", "Quick lead offline");
    await editKanbanRecordQuickCreateInput("expected_revenue", "3000");
    await validateKanbanRecord();
    await animationFrame();
    // the cached defaults are refreshed from the network in the background: that fails
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.lead\/onchange"/]);
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    const [ids, values] = queuedCalls()[0].args;
    expect(ids).toEqual([]);
    expect(values.name).toBe("Quick lead offline");
    expect(values.expected_revenue).toBe(3000);
    expect(values.stage_id).toBe(1); // the column it was created in

    await setOffline(false);
    await expect.waitForSteps(["server: web_save []"]);
    expect(queuedCalls()).toEqual([]);
    const created = MockServer.env["crm.lead"].search_read(
        [["name", "=", "Quick lead offline"]],
        ["stage_id", "expected_revenue"]
    );
    expect(created).toEqual([{ id: 6, stage_id: [1, "New"], expected_revenue: 3000 }]);
});

test("[Offline] a lead's priority set from its pipeline card is queued and replayed", async () => {
    stepServerSaves();
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    await setOffline(true);
    // the stars are available offline: the card saves the priority at once (queued)
    const star = ".o_kanban_record:contains(Office chairs) .o_priority_star:eq(0)";
    expect(star).toBeEnabled();
    await contains(star).click();
    await animationFrame();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args).toEqual([[1], { priority: "1" }]);

    await setOffline(false);
    await expect.waitForSteps([`server: web_save [[1],{"priority":"1"}]`]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].browse(1)[0].priority).toBe("1");
});

test.tags("desktop");
test("[Offline] forecast: a lead quick-created offline is queued and replayed", async () => {
    mockDate("2023-09-01 00:00:00");
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`server: web_save ${JSON.stringify(args[0])}`);
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    expect(".o_kanban_group").not.toHaveCount(0);
    // online, quick create once: the framework keeps its form and its defaults
    await createKanbanRecord();
    await discardKanbanRecord();
    await runAllTimers();

    await setOffline(true);
    expect("button.o-kanban-button-new").not.toHaveClass("o_disabled_offline");
    await createKanbanRecord();
    await editKanbanRecordQuickCreateInput("name", "Forecast lead offline");
    await validateKanbanRecord();
    await animationFrame();
    // the cached defaults are refreshed from the network in the background: that fails
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm\.lead\/onchange"/]);
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.web_save"]);
    expect(queuedCalls()[0].args[0]).toEqual([]);
    expect(queuedCalls()[0].args[1].name).toBe("Forecast lead offline");

    await setOffline(false);
    await expect.waitForSteps(["server: web_save []"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].search([["name", "=", "Forecast lead offline"]])).toHaveLength(1);
});

