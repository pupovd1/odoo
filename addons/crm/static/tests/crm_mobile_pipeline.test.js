import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    animationFrame,
    pointerDown,
    pointerUp,
    press,
    queryAll,
    queryAllTexts,
    queryOne,
    runAllTimers,
    scroll,
    waitFor,
} from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    defineParams,
    getService,
    makeMockServer,
    MockServer,
    mountWithCleanup,
    onRpc,
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

const pipelineArch = `
    <kanban js_class="crm_kanban" default_group_by="stage_id" on_create="quick_create" mobile_pipeline="1">
        <field name="stage_id"/>
        <field name="partner_id"/>
        <field name="contact_name"/>
        <field name="expected_revenue"/>
        <progressbar field="activity_state" colors='{"planned": "success", "today": "warning", "overdue": "danger"}'
            sum_field="expected_revenue"/>
        <templates>
            <t t-name="card"><field name="name"/></t>
        </templates>
    </kanban>`;

defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
        search_view_id: [false, "search"],
        context: { default_type: "opportunity" },
    },
    {
        id: 2,
        name: "Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
        search_view_id: [false, "search"],
        context: { default_type: "opportunity", show_team_switcher: true },
    },
]);

/**
 * The pipeline (stages New: 2 leads, 6,000; Proposition: 1 lead; Won: 1 lead),
 * opened online in the web client. The framework's startup sync runs online
 * first, as in a real session.
 */
async function openPipeline({ foldWon = false, kanban = pipelineArch, before, action = 1 } = {}) {
    await makeMockServer();
    if (foldWon) {
        MockServer.env["crm.stage"].write([3], { fold: true });
    }
    before?.();
    CrmLead._views = {
        kanban,
        form: `<form js_class="crm_form"><field name="name"/></form>`,
        search: `<search><field name="name"/></search>`,
    };
    await mountWithCleanup(WebClient);
    await getService("action").doAction(action);
    await runAllTimers();
    await animationFrame();
}

const stageName = () => queryOne(".o_crm_mobile_stage_name").textContent.trim();
/** The leads shown in the stage (not the ones pending creation). */
const cardNames = () =>
    queryAllTexts(".o_crm_mobile_stage .o_crm_mobile_card:not(.o_crm_mobile_pending_card) .o_crm_mobile_card_name");

test.tags("mobile");
test("[Mobile] the pipeline shows one stage at a time, with its name, lead count and revenue", async () => {
    await openPipeline();
    expect(".o_crm_mobile_pipeline").toHaveCount(1);
    // the kanban's columns are not rendered: one stage fills the screen
    expect(".o_kanban_group").toHaveCount(0);
    expect(stageName()).toBe("New");
    expect(".o_crm_mobile_stage_count").toHaveText("2");
    expect(".o_crm_mobile_stage_revenue").toHaveText(/6,000/);
    expect(cardNames()).toEqual(["Office chairs", "Desks for the new office"]);
    // the header stays at the top of the screen: the stage below it scrolls
    expect(".o_crm_mobile_stage .o_crm_mobile_stage_header").toHaveCount(0);
    const pipeline = queryOne(".o_crm_mobile_pipeline").getBoundingClientRect();
    expect(Math.round(pipeline.width)).toBe(Math.round(queryOne(".o_kanban_renderer").clientWidth));
});

test.tags("mobile");
test("[Mobile] previous / next buttons and horizontal swipes move to the adjacent stages", async () => {
    await openPipeline();
    expect(".o_crm_mobile_prev").not.toBeEnabled(); // first stage
    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Proposition");
    expect(cardNames()).toEqual(["Meeting room"]);
    expect(".o_crm_mobile_stage_count").toHaveText("1");
    expect(".o_crm_mobile_stage_header").toHaveText(/1 lead\b/);
    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Won");
    expect(".o_crm_mobile_next").not.toBeEnabled(); // last stage
    await contains(".o_crm_mobile_prev").click();
    expect(stageName()).toBe("Proposition");

    // swipe right: previous stage; swipe left: next stage
    const stage = ".o_crm_mobile_stage";
    await pointerDown(stage, { position: { x: 40, y: 20 }, relative: true });
    await pointerUp(stage, { position: { x: 300, y: 25 }, relative: true });
    await animationFrame();
    expect(stageName()).toBe("New");
    await pointerDown(stage, { position: { x: 300, y: 20 }, relative: true });
    await pointerUp(stage, { position: { x: 40, y: 30 }, relative: true });
    await animationFrame();
    expect(stageName()).toBe("Proposition");
    // a short or vertical move is not a swipe
    await pointerDown(stage, { position: { x: 100, y: 20 }, relative: true });
    await pointerUp(stage, { position: { x: 120, y: 300 }, relative: true });
    await animationFrame();
    expect(stageName()).toBe("Proposition");
});

test.tags("mobile");
test("[Offline] [Mobile] a stage loaded online renders offline, a stage never loaded shows the offline action helper", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_search_read"]);
    await openPipeline({ foldWon: true });
    // the Won stage is folded: its leads were never loaded
    expect.verifySteps([]);

    await setOffline(true);
    // the pipeline opened again offline: from the framework's cache
    await getService("action").doAction(1);
    await animationFrame();
    expect(stageName()).toBe("New");
    expect(cardNames()).toEqual(["Office chairs", "Desks for the new office"]);
    await contains(".o_crm_mobile_next").click();
    expect(cardNames()).toEqual(["Meeting room"]);

    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Won");
    expect.verifySteps(["crm.lead/web_search_read"]); // tried, nothing cached
    expect(".o_crm_mobile_stage .o_offline_action_helper, .o_crm_mobile_stage .o_view_nocontent").toHaveCount(1);
    expect(".o_crm_mobile_card").toHaveCount(0);
    expect(".o_dialog").toHaveCount(0);
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.lead\/web_read_group"/]);

    // back online: the stage loads
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/web_search_read"]);
    await animationFrame();
    expect(cardNames()).toEqual(["Reception desk"]);
});

test.tags("mobile");
test("[Mobile] lead card: 44 px touch target, name, contact, revenue and a pending-sync badge read from the queue", async () => {
    await openPipeline({
        before: () => {
            const [partnerId] = MockServer.env["res.partner"].create([{ name: "Chairs Contact" }]);
            MockServer.env["crm.lead"].write([1], { partner_id: partnerId });
            MockServer.env["crm.lead"].write([2], { contact_name: "Dana Desk" });
        },
    });

    const [chairs, desks] = queryAll(".o_crm_mobile_card");
    expect(chairs.querySelector(".o_crm_mobile_card_name")).toHaveText("Office chairs");
    expect(chairs.querySelector(".o_crm_mobile_card_partner")).toHaveText("Chairs Contact");
    expect(chairs.querySelector(".o_crm_mobile_card_revenue")).toHaveText(/1,200/);
    expect(desks.querySelector(".o_crm_mobile_card_partner")).toHaveText("Dana Desk");
    for (const target of queryAll(".o_crm_mobile_card_open, .o_crm_mobile_prev, .o_crm_mobile_next")) {
        const { width, height } = target.getBoundingClientRect();
        expect(width >= 44 && height >= 44).toBe(true, { message: `${target.className}: ${width}x${height}` });
    }
    expect(".o_crm_mobile_card .o_crm_pending_sync").toHaveCount(0);

    // a call writing lead 1 waits in the framework's queue: its card says so
    const offlinePlugin = getService(OfflinePlugin);
    const key = offlinePlugin.scheduleORM("crm.lead", "web_save", [[1], { priority: "2" }], {}, {
        extras: { timeStamp: Date.now() },
    });
    await animationFrame();
    expect(".o_crm_mobile_card:eq(0) .o_crm_pending_sync").toHaveText("Pending sync");
    expect(".o_crm_mobile_card:eq(1) .o_crm_pending_sync").toHaveCount(0);
    offlinePlugin.removeScheduledORM(key);
    await animationFrame();
    expect(".o_crm_mobile_card .o_crm_pending_sync").toHaveCount(0);

    // the card opens the lead
    await contains(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_open").click();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Office chairs");
});

test.tags("mobile");
test("[Mobile] quick create: a bottom sheet with exactly name, contact, phone, email, revenue and stage, all available offline", async () => {
    await openPipeline();
    await contains(".o_crm_mobile_next").click(); // Proposition
    await contains(".o_control_panel_main_buttons button.o-kanban-button-new").click();
    expect(".o_bottom_sheet .o_crm_mobile_quick_create").toHaveCount(1);
    const fields = queryAll(".o_crm_mobile_quick_create [name]");
    expect(fields.map((field) => field.getAttribute("name"))).toEqual([
        "name",
        "contact_name",
        "phone",
        "email_from",
        "expected_revenue",
        "stage_id",
    ]);
    for (const field of [...fields, queryOne(".o_crm_mobile_quick_create_add")]) {
        expect(field).toHaveAttribute("data-available-offline");
    }
    // the stage shown in the pipeline
    expect(".o_crm_mobile_quick_create [name=stage_id]").toHaveValue("2");
    expect(queryAllTexts(".o_crm_mobile_quick_create [name=stage_id] option")).toEqual([
        "New",
        "Proposition",
        "Won",
    ]);
    // a name is required
    expect(".o_crm_mobile_quick_create_add").not.toBeEnabled();
});

/** Fills the quick create and adds the lead. */
async function quickCreate({ stageId = "2" } = {}) {
    await contains(".o_control_panel_main_buttons button.o-kanban-button-new").click();
    await contains(".o_crm_mobile_quick_create [name=name]").edit("Lead created on the go");
    await contains(".o_crm_mobile_quick_create [name=contact_name]").edit("Ana Road");
    await contains(".o_crm_mobile_quick_create [name=phone]").edit("+32 470 00 00 00");
    await contains(".o_crm_mobile_quick_create [name=email_from]").edit("ana@example.com");
    await contains(".o_crm_mobile_quick_create [name=expected_revenue]").edit("1500", { instantly: true });
    await contains(".o_crm_mobile_quick_create [name=stage_id]").select(stageId);
    await contains(".o_crm_mobile_quick_create_add").click();
}

const createdValues = {
    name: "Lead created on the go",
    contact_name: "Ana Road",
    phone: "+32 470 00 00 00",
    email_from: "ana@example.com",
    expected_revenue: 1500,
    stage_id: 2,
};

test.tags("mobile");
test("[Offline] [Mobile] quick create queues one create and shows the lead at once as pending sync; replayed online", async () => {
    const setOffline = mockCrmOffline(["crm.lead/create"]);
    await openPipeline();
    await contains(".o_crm_mobile_next").click(); // Proposition

    await setOffline(true);
    expect(".o_control_panel_main_buttons button.o-kanban-button-new").toBeEnabled();
    await quickCreate();
    expect.verifySteps([]);
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queuedMethods()).toEqual(["crm.lead.create"]);
    expect(queuedCalls()[0].args).toEqual([[createdValues]]);
    expect(queuedCalls()[0].kwargs).toEqual({ context: { default_type: "opportunity" } });
    // shown at once in its stage, marked as pending sync
    expect(cardNames()).toEqual(["Meeting room"]);
    expect(".o_crm_mobile_pending_card").toHaveCount(1);
    expect(".o_crm_mobile_pending_card .o_crm_mobile_card_name").toHaveText("Lead created on the go");
    expect(".o_crm_mobile_pending_card .o_crm_pending_sync").toHaveText("Pending sync");
    // the framework's systray lists it
    await contains(".o_menu_systray .o_offline_systray").click();
    expect(".o_offline_systray_content .o_badge").toHaveText("Created");
    await contains(".o_menu_systray .o_offline_systray").click();

    // replayed once back online; the stage then shows the created lead
    await setOffline(false);
    await expect.waitForSteps(["crm.lead/create"]);
    expect(queuedCalls()).toEqual([]);
    await animationFrame();
    expect(".o_crm_mobile_pending_card").toHaveCount(0);
    expect(cardNames()).toEqual(["Meeting room", "Lead created on the go"]);
    const [created] = MockServer.env["crm.lead"].search_read(
        [["name", "=", "Lead created on the go"]],
        ["contact_name", "phone", "email_from", "expected_revenue", "stage_id", "type"]
    );
    expect(created).toEqual({
        id: 6,
        contact_name: "Ana Road",
        phone: "+32 470 00 00 00",
        email_from: "ana@example.com",
        expected_revenue: 1500,
        stage_id: [2, "Proposition"],
        type: "opportunity",
    });
});

test.tags("mobile");
test("[Mobile] quick create online creates the lead and shows it in its stage", async () => {
    onRpc("crm.lead", "create", ({ args, kwargs }) => {
        expect.step(["create", args, kwargs.context.default_type]);
    });
    await openPipeline();
    await quickCreate({ stageId: "1" });
    await expect.waitForSteps([["create", [[{ ...createdValues, stage_id: 1 }]], "opportunity"]]);
    await animationFrame();
    expect(".o_bottom_sheet").toHaveCount(0);
    expect(queuedCalls()).toEqual([]);
    expect(stageName()).toBe("New");
    expect(cardNames()).toEqual(["Office chairs", "Desks for the new office", "Lead created on the go"]);
    expect(".o_crm_mobile_stage_count").toHaveText("3");
});

test.tags("desktop");
test("[Desktop] the pipeline keeps the standard kanban", async () => {
    await openPipeline();
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(3);
    // New opens the framework's quick create in the first column
    await contains(".o_control_panel_main_buttons button.o-kanban-button-new").click();
    await waitFor(".o_kanban_group:eq(0) .o_kanban_quick_create");
    expect(".o_bottom_sheet").toHaveCount(0);
});

test.tags("mobile");
test("[Mobile] a kanban of leads not grouped by stage keeps the standard kanban", async () => {
    await openPipeline({ kanban: pipelineArch.replace('default_group_by="stage_id"', 'default_group_by="team_id"') });
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(2);
});

test.tags("mobile");
test("[Mobile] a crm kanban whose arch isn't the pipeline's (no mobile_pipeline) keeps the standard kanban", async () => {
    await openPipeline({ kanban: pipelineArch.replace(' mobile_pipeline="1"', "") });
    expect(".o_crm_mobile_pipeline").toHaveCount(0);
    expect(".o_kanban_group").toHaveCount(3);
});

test.tags("mobile");
test("[Mobile] arrow keys move through the stage's leads, without breaking the kanban's navigation", async () => {
    await openPipeline();
    // the cards are records of the kanban
    expect(".o_kanban_renderer .o_kanban_record").toHaveCount(2);
    queryAll(".o_crm_mobile_card_open")[0].focus();
    await press("ArrowDown");
    await animationFrame();
    expect(document.activeElement).toBe(queryAll(".o_crm_mobile_card_open")[1]);
    await press("ArrowRight");
    await press("ArrowLeft");
    await animationFrame();
    expect(document.activeElement).toBe(queryAll(".o_crm_mobile_card_open")[1]);
    await press("ArrowUp");
    await animationFrame();
    expect(document.activeElement).toBe(queryAll(".o_crm_mobile_card_open")[0]);
});

/** Adds leads to a stage, after the existing ones. */
function addLeads(count, stageId = 1) {
    MockServer.env["crm.lead"].create(
        Array.from({ length: count }, (_, index) => ({ name: `Extra lead ${index + 1}`, stage_id: stageId, team_id: 1 }))
    );
}

test.tags("mobile");
test("[Mobile] a long stage scrolls under its header, down to its last lead", async () => {
    await openPipeline({ before: () => addLeads(20) });
    const stage = queryOne(".o_crm_mobile_stage");
    expect(getComputedStyle(stage).overflowY).toBe("auto");
    expect(stage.scrollHeight > stage.clientHeight).toBe(true);
    const headerTop = queryOne(".o_crm_mobile_stage_header").getBoundingClientRect().top;
    const lastCard = queryAll(".o_crm_mobile_card").at(-1);
    expect(lastCard).toHaveText(/Extra lead 20/);
    expect(lastCard.getBoundingClientRect().top >= stage.getBoundingClientRect().bottom).toBe(true);

    await scroll(stage, { top: stage.scrollHeight });
    await animationFrame();
    expect(lastCard.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 1).toBe(true);
    expect(queryOne(".o_crm_mobile_stage_header").getBoundingClientRect().top).toBe(headerTop);
});

const samplePipelineArch = pipelineArch.replace('mobile_pipeline="1"', 'mobile_pipeline="1" sample="1"');
const noLeads = () => MockServer.env["crm.lead"].unlink(MockServer.env["crm.lead"].search([]));
/** As crm.lead's stage_id on the server (group_expand): every stage is a group, even without leads. */
function expandStages() {
    onRpc("crm.lead", "web_read_group", function ({ kwargs, parent }) {
        const result = parent();
        if (kwargs.groupby?.[0] !== "stage_id") {
            return result;
        }
        const stages = this.env["crm.stage"].search_read([], ["name", "sequence"]);
        for (const stage of stages) {
            if (!result.groups.some((group) => group.stage_id?.[0] === stage.id)) {
                result.groups.push({
                    __extra_domain: [["stage_id", "=", stage.id]],
                    stage_id: [stage.id, stage.name],
                    __count: 0,
                    __records: [],
                });
            }
        }
        const sequence = (group) => stages.find((stage) => stage.id === group.stage_id?.[0])?.sequence;
        result.groups.sort((a, b) => sequence(a) - sequence(b));
        result.length = result.groups.length;
        return result;
    });
}

test.tags("mobile");
test("[Mobile] quick create in an empty pipeline leaves the sample data: the new lead shows and opens", async () => {
    expandStages();
    await openPipeline({ kanban: samplePipelineArch, before: noLeads });
    expect(".o_view_sample_data").toHaveCount(1);
    await quickCreate({ stageId: "1" });
    await animationFrame();
    expect(".o_view_sample_data").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(stageName()).toBe("New");
    expect(cardNames()).toEqual(["Lead created on the go"]);
    await contains(".o_crm_mobile_card_open").click();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Lead created on the go");
});

test.tags("mobile");
test("[Offline] [Mobile] quick create offline in an empty pipeline: the pending lead shows, then the real one", async () => {
    expandStages();
    const setOffline = mockCrmOffline(["crm.lead/create"]);
    await openPipeline({ kanban: samplePipelineArch, before: noLeads });
    await setOffline(true);
    await quickCreate({ stageId: "1" });
    expect(".o_view_sample_data").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(0);
    expect(".o_crm_mobile_pending_card .o_crm_mobile_card_name").toHaveText("Lead created on the go");
    expect(".o_crm_mobile_stage_empty").toHaveCount(0);

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/create"]);
    await animationFrame();
    expect(".o_crm_mobile_pending_card").toHaveCount(0);
    expect(cardNames()).toEqual(["Lead created on the go"]);
});

test.tags("mobile");
test("[Mobile] quick create online: a reload lost with the connection doesn't queue the created lead again", async () => {
    let reloadLost = false;
    onRpc("crm.lead", "create", () => {
        expect.step("create");
        reloadLost = true;
    });
    onRpc("/web/dataset/call_kw/crm.lead/web_read_group", () =>
        reloadLost ? new Response("", { status: 502 }) : undefined
    );
    await openPipeline();
    await quickCreate({ stageId: "1" });
    await animationFrame();
    expect.verifySteps(["create"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["crm.lead"].search_count([["name", "=", "Lead created on the go"]])).toBe(1);
    expect(".o_dialog").toHaveCount(0);
});

test.tags("mobile");
test("[Mobile] quick create reads the expected revenue in the user's number format, and refuses an invalid one", async () => {
    defineParams({ lang_parameters: { decimal_point: ",", thousands_sep: "." } });
    onRpc("crm.lead", "create", ({ args }) => {
        expect.step(args[0][0].expected_revenue);
    });
    await openPipeline();
    await contains(".o_control_panel_main_buttons button.o-kanban-button-new").click();
    await contains(".o_crm_mobile_quick_create [name=name]").edit("Lead with revenue");
    const revenue = ".o_crm_mobile_quick_create [name=expected_revenue]";
    await contains(revenue).edit("a lot", { instantly: true });
    expect(revenue).toHaveClass("is-invalid");
    expect(".o_crm_mobile_quick_create_add").not.toBeEnabled();
    await contains(revenue).edit("1.500,50", { instantly: true });
    expect(revenue).not.toHaveClass("is-invalid");
    await contains(".o_crm_mobile_quick_create_add").click();
    await expect.waitForSteps([1500.5]);
});

test.tags("mobile");
test("[Mobile] coming back from a lead shows the stage it was opened from", async () => {
    await openPipeline();
    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Proposition");
    await contains(".o_crm_mobile_card_open").click();
    expect(".o_form_view .o_field_widget[name=name] input").toHaveValue("Meeting room");
    await contains(".o_back_button").click();
    expect(stageName()).toBe("Proposition");
    expect(cardNames()).toEqual(["Meeting room"]);
});

test.tags("mobile");
test("[Mobile] a folded stage shown stays loaded when the pipeline reloads (team switcher)", async () => {
    await openPipeline({ foldWon: true, action: 2 });
    await contains(".o_crm_mobile_next").click();
    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Won");
    expect(cardNames()).toEqual(["Reception desk"]);

    await contains(".o_cp_team_switcher").click();
    await contains(".dropdown-item:contains(Sales)").click();
    await animationFrame();
    expect(".o_cp_team_switcher").toHaveText("Sales");
    expect(stageName()).toBe("Won");
    expect(cardNames()).toEqual(["Reception desk"]);
    expect(".o_crm_mobile_load_more").toHaveCount(0);
    expect(".o_crm_mobile_stage_empty").toHaveCount(0);
});

test.tags("mobile");
test("[Offline] [Mobile] after the pipeline reloads offline, a stage never loaded still shows the offline action helper", async () => {
    const setOffline = mockCrmOffline();
    await openPipeline({ foldWon: true });
    await setOffline(true);
    await contains(".o_crm_mobile_next").click();
    await contains(".o_crm_mobile_next").click();
    expect(stageName()).toBe("Won");
    expect(".o_crm_mobile_stage .o_view_nocontent").toHaveCount(1);

    // the helper's Reset Filters reloads the pipeline (from the cache; the
    // framework's refresh of the cached groups fails in the background)
    await contains(".o_crm_mobile_stage .o_view_nocontent button").click();
    await animationFrame();
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.lead\/web_read_group"/]);
    expect(stageName()).toBe("Won");
    expect(".o_crm_mobile_stage .o_view_nocontent").toHaveCount(1);
    expect(".o_crm_mobile_load_more").toHaveCount(0);
    expect(".o_crm_mobile_stage_empty").toHaveCount(0);
});
