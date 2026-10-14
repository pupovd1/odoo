import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, press, queryFirst, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    getService,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
    toggleActionMenu,
} from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { RelationalModel } from "@web/model/relational_model/relational_model";
import { WebClient } from "@web/webclient/webclient";
import { ShareTargetDialog } from "@web/webclient/share_target/share_target_dialog";
import {
    CrmLead,
    CrmStage,
    CrmTag,
    CrmTeam,
    mockCrmOffline,
    queuedCalls,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

class Lead extends CrmLead {
    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <templates><t t-name="card"><field name="name"/></t></templates>
            </kanban>`,
        list: `
            <list js_class="crm_list" multi_edit="1">
                <header>
                    <button name="2" type="action" string="Convert to Opportunities"/>
                </header>
                <field name="name"/>
                <field name="expected_revenue"/>
                <button name="3" type="action" string="Email" icon="mail"/>
            </list>`,
        "list,2": `
            <list js_class="forecast_list" multi_edit="1">
                <field name="name"/>
                <field name="expected_revenue"/>
            </list>`,
        form: `<form js_class="crm_form"><field name="name"/></form>`,
        graph: `<graph><field name="stage_id"/></graph>`,
        pivot: `<pivot><field name="stage_id" type="row"/></pivot>`,
        calendar: `<calendar date_start="date_deadline"><field name="name"/></calendar>`,
        search: `<search><field name="name"/><field name="team_id"/></search>`,
    };
}

class Stage extends CrmStage {
    _views = {
        list: `
            <list js_class="crm_stage_list" multi_edit="1">
                <field name="sequence" widget="handle"/>
                <field name="name"/>
            </list>`,
        form: `<form><field name="name"/><field name="is_won"/></form>`,
        search: `<search/>`,
    };
}

class Team extends CrmTeam {
    _views = {
        list: `<list><field name="name"/></list>`,
        form: `<form><field name="name"/></form>`,
        search: `<search/>`,
    };
}

defineModels([Stage, Team, CrmTag, Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        context: { show_team_switcher: true, show_lead_gen_button: true },
        views: [
            [false, "kanban"],
            [false, "list"],
            [false, "form"],
            [false, "graph"],
            [false, "pivot"],
            [false, "calendar"],
        ],
    },
    {
        id: 4,
        name: "Forecast",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[2, "list"]],
    },
    {
        id: 5,
        name: "Stages",
        res_model: "crm.stage",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
    },
    {
        id: 6,
        name: "Sales Teams",
        res_model: "crm.team",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
    },
]);

/** Selects the list's row of this index: its checkbox, or a long press on small screens. */
async function selectRow(index) {
    if (getService("ui").isSmall) {
        const { drop } = await contains(`.o_data_row:eq(${index})`).drag();
        await drop();
    } else {
        await contains(`.o_data_row:eq(${index}) .o_list_record_selector input`).click();
    }
}

/** Small screens fold the search bar behind a toggler: unfold it to read the facets. */
async function showSearchBar() {
    if (getService("ui").isSmall) {
        await contains(".o_control_panel button:has(> i[data-icon='search'])").click();
    }
}

/** Counts the sales-manager group probes (the switcher may render more than once). */
function countSaleManagerProbes() {
    const probes = { count: 0 };
    patchWithCleanup(user, {
        hasGroup(group) {
            if (group === "sales_team.group_sale_manager") {
                probes.count++;
                return Promise.resolve(true);
            }
            return super.hasGroup(...arguments);
        },
    });
    return probes;
}

test("[Offline] team switcher: no group probe, dropdown disabled, Manage Teams unreachable, team kept as a facet", async () => {
    // opened again offline, the pipeline and the switcher's teams come from the
    // framework's cache, which still tries to refresh them in the background
    expect.errors(2);
    const probes = countSaleManagerProbes();
    const setOffline = mockCrmOffline(["crm.team/get_team_switcher_data"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect.verifySteps(["crm.team/get_team_switcher_data"]);
    expect(probes.count).toBeGreaterThan(0);

    await contains(".o_cp_team_switcher").click();
    expect(".o-dropdown--menu .dropdown-item:contains(Manage Teams)").toHaveCount(1);
    await contains(".o-dropdown--menu .dropdown-item:text('Sales')").click();
    expect(".o_cp_team_switcher").toHaveText("Sales");
    expect(".o_kanban_record").toHaveCount(3); // Sales (team 1) leads

    await contains(".o_cp_team_switcher").click();
    expect(".o-dropdown--menu").toHaveCount(1);
    await setOffline(true);
    probes.count = 0;
    // the open dropdown closes, the toggler is disabled
    expect(".o-dropdown--menu").toHaveCount(0);
    expect(".o_cp_team_switcher").not.toBeEnabled();
    await contains(".o_cp_team_switcher").click({ force: true });
    expect(".o-dropdown--menu").toHaveCount(0);
    // the selected team stays visible as a search facet
    await showSearchBar();
    expect(".o_searchview_facet:contains(Sales)").toHaveCount(1);

    // the pipeline opened again offline (from the cache): no probe, still disabled
    await getService("action").doAction(1);
    await animationFrame();
    expect(".o_kanban_record").toHaveCount(3);
    expect(".o_cp_team_switcher").toHaveText("Sales");
    expect(".o_cp_team_switcher").not.toBeEnabled();
    await showSearchBar();
    expect(".o_searchview_facet:contains(Sales)").toHaveCount(1);
    expect(probes.count).toBe(0);
    // the teams come from the cache: the framework's refresh fails in the background
    expect.verifySteps(["crm.team/get_team_switcher_data"]);
    // (get_team_switcher_data and web_read_group, in either order)
    const refresh = /Connection to "\/web\/dataset\/call_kw\/(crm\.team\/get_team_switcher_data|crm\.lead\/web_read_group)"/;
    await expect.waitForErrors([refresh, refresh]);

    // back online: probed, enabled, Manage Teams reachable again
    await setOffline(false);
    await animationFrame();
    expect(probes.count).toBeGreaterThan(0);
    expect(".o_cp_team_switcher").toBeEnabled();
    await contains(".o_cp_team_switcher").click();
    expect(".o-dropdown--menu .dropdown-item:contains(Manage Teams)").toHaveCount(1);
});

/** The has_group route of the given group answers 502 while `isDown()`. */
function loseGroupProbe(group, isDown) {
    onRpc("/web/dataset/call_kw/res.users/has_group", async (request) => {
        const { params } = await request.json();
        return isDown() && params.args[1] === group ? new Response("", { status: 502 }) : undefined;
    });
}

test("[Offline] team switcher: a sales-manager probe lost with the connection is issued again once it is back", async () => {
    // the pipeline loads while the network flaps: the probe is lost, the app
    // still believing it's online
    let networkDown = true;
    loseGroupProbe("sales_team.group_sale_manager", () => networkDown);
    onRpc("res.users", "has_group", ({ args }) => {
        if (args[1] === "sales_team.group_sale_manager") {
            expect.step(`server: has_group ${args[1]}`);
            return true;
        }
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_dialog").toHaveCount(0); // no error

    // back online: probed again (web's user cache keeps the lost probe), so a
    // sales manager gets Manage Teams back without reloading the page
    networkDown = false;
    await setOffline(false);
    await animationFrame();
    expect.verifySteps(["server: has_group sales_team.group_sale_manager"]);
    await contains(".o_cp_team_switcher").click();
    expect(".o-dropdown--menu .dropdown-item:contains(Manage Teams)").toHaveCount(1);
});

test("[Offline] screens of other models reached from CRM (tags...) keep their cache online, and are unavailable offline", async () => {
    CrmTag._views = {
        list: `<list editable="bottom"><field name="name"/></list>`,
        search: `<search/>`,
    };
    defineActions([
        {
            id: 7,
            xml_id: "sales_team.sales_team_crm_tag_action",
            name: "Tags",
            res_model: "crm.tag",
            type: "ir.actions.act_window",
            views: [[false, "list"]],
        },
    ]);
    // whether each load reads the framework's disk cache
    patchWithCleanup(RelationalModel.prototype, {
        _getCacheParams() {
            const params = super._getCacheParams(...arguments);
            expect.step(`${this.env.config.actionXmlId || this.env.config.actionId}: ${params ? "cache" : "no cache"}`);
            return params;
        },
    });
    const setOffline = mockCrmOffline(["crm.tag/web_search_read"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(7);
    await runAllTimers();
    expect(".o_data_row").toHaveCount(3);
    // online, as before: cache-first rendering from the disk cache
    expect.verifySteps(["sales_team.sales_team_crm_tag_action: cache", "crm.tag/web_search_read"]);
    await getService("action").doAction(1);
    await runAllTimers();
    expect.verifySteps(["1: cache"]);

    await setOffline(true);
    const offlinePlugin = getService(OfflinePlugin);
    // never marked available offline (its menu is disabled), unlike the pipeline
    expect(offlinePlugin.isAvailableOffline(7)).toBe(false);
    expect(offlinePlugin.isAvailableOffline(1)).toBe(true);
    // opened anyway (breadcrumbs, URL): the offline action helper, no tag to edit
    await getService("action").doAction(7);
    await animationFrame();
    expect.verifySteps(["sales_team.sales_team_crm_tag_action: no cache", "crm.tag/web_search_read"]);
    expect(".o_data_row").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(1);
    expect(queuedCalls()).toEqual([]);
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\/crm.tag\/web_search_read"/]);
});

test("[Offline] lead generation: Generate is disabled offline, with no module lookup or access probe", async () => {
    onRpc("ir.module.module", "search_read", () => []);
    patchWithCleanup(user, {
        checkAccessRight(model, operation) {
            expect.step(`checkAccessRight ${model} ${operation}`);
            return super.checkAccessRight(...arguments);
        },
    });
    const setOffline = mockCrmOffline(["ir.module.module/search_read"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    const generate = "button:contains(Generate)";
    expect(generate).toBeEnabled();
    if (!getService("ui").isSmall) {
        // opened online, the dropdown closes when the connection drops
        await contains(generate).click();
        await expect.waitForSteps(["ir.module.module/search_read"]);
        await animationFrame();
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
    }

    await setOffline(true);
    expect(generate).not.toBeEnabled();
    queryFirst(generate).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await press("alt+c"); // its access key
    await animationFrame();
    expect(".o_lead_mining_menu_choices").toHaveCount(0);
    expect.verifySteps([]);

    await setOffline(false);
    expect(generate).toBeEnabled();
    // a programmatic click: on small screens the button sits in the control panel's
    // "More" menu
    queryFirst(generate).click();
    await animationFrame();
    if (getService("ui").isSmall) {
        await expect.waitForSteps(["ir.module.module/search_read"]);
    } else {
        // (the modules were already looked up when it was first opened)
        expect(".o_lead_mining_menu_choices").toHaveCount(1);
    }
});

test.tags("desktop");
test("[Offline] lead lists: no cell or multi-record editing, server buttons disabled", async () => {
    const setOffline = mockCrmOffline(["crm.lead/web_save"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "list" });
    expect(".o_data_row").toHaveCount(4);

    // online: multi-edit
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(1);
    await contains(".o_list_button_discard").click();

    await setOffline(true);
    // a click on a selected record's cell doesn't edit it (it only toggles the selection)
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(0);
    expect(".o_data_row:eq(0) .o_data_cell[name=expected_revenue] input").toHaveCount(0);
    expect("button[name='2']").not.toBeEnabled(); // header: convert (wizard)
    expect(".o_data_row:eq(0) button[name='3']").not.toBeEnabled(); // row: email (wizard)
    expect(queuedCalls()).toEqual([]);

    await setOffline(false);
    await contains(".o_data_row:eq(0) .o_list_record_selector input").check();
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(1);
});

test.tags("desktop");
test("[Offline] the forecast list is not editable offline either", async () => {
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(4);
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(1);
    await contains(".o_list_button_discard").click();

    await setOffline(true);
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(0);
    await setOffline(false);
    await contains(".o_data_row:eq(0) .o_list_record_selector input").check();
    await contains(".o_data_row:eq(0) .o_data_cell[name=expected_revenue]").click();
    expect(".o_data_row.o_selected_row").toHaveCount(1);
});

test.tags("desktop");
test("[Offline] calendar, graph and pivot views are not available offline", async () => {
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    for (const type of ["kanban", "list", "graph", "pivot", "calendar"]) {
        expect(`.o_switch_view.o_${type}`).toBeEnabled();
    }
    await setOffline(true);
    expect(".o_switch_view.o_kanban").toBeEnabled();
    for (const type of ["graph", "pivot", "calendar"]) {
        expect(`.o_switch_view.o_${type}`).not.toBeEnabled();
    }
    await setOffline(false);
    for (const type of ["graph", "pivot", "calendar"]) {
        expect(`.o_switch_view.o_${type}`).toBeEnabled();
    }
});

test.tags("desktop");
test("[Offline] action menu items the framework greys out can't be run offline, even from the keyboard", async () => {
    const setOffline = mockCrmOffline(["crm.lead/copy"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "list" });
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    await setOffline(true);
    await toggleActionMenu();
    const duplicate = ".o-dropdown--menu .o_menu_item:contains(Duplicate)";
    expect(duplicate).toHaveClass("pe-none");
    // keyboard activation (Enter on the focused item) and a programmatic click
    queryFirst(duplicate).focus();
    await press("Enter");
    queryFirst(duplicate)?.click();
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_data_row").toHaveCount(4);

    await setOffline(false);
    await toggleActionMenu();
    await contains(".o-dropdown--menu .o_menu_item:contains(Duplicate)").click();
    await expect.waitForSteps(["crm.lead/copy"]);
});

test("[Offline] stages and teams: stage list read-only, no reorder, no delete offline", async () => {
    // opened again offline, the teams come from the framework's cache, which still
    // tries to refresh them in the background
    expect.errors(1);
    const setOffline = mockCrmOffline(["crm.stage/web_save", "crm.stage/web_unlink", "crm.team/web_unlink"]);
    await mountWithCleanup(WebClient);
    await getService("action").doAction(6); // visited online: available offline
    await getService("action").doAction(5);
    expect(".o_row_handle").toHaveCount(3);
    expect(".o_data_row:first .o_row_handle").not.toHaveClass("o_disabled");

    await setOffline(true);
    expect(".o_list_renderer .o_row_draggable").toHaveCount(0);
    await selectRow(0);
    await selectRow(1);
    if (!getService("ui").isSmall) {
        // (small screens never edit in the list: a tap selects)
        await contains(".o_data_row:eq(0) .o_data_cell[name=name]").click();
        expect(".o_data_row.o_selected_row").toHaveCount(0);
    }
    await toggleActionMenu();
    const deleteItem = ".o-dropdown--menu .o_menu_item:contains(Delete)";
    expect(deleteItem).toHaveClass("pe-none");
    queryFirst(deleteItem).click();
    await animationFrame();
    expect(".modal").toHaveCount(0);
    expect(queuedCalls()).toEqual([]);

    // a sales team can't be deleted offline either
    await getService("action").doAction(6);
    await selectRow(0);
    await toggleActionMenu();
    expect(deleteItem).toHaveClass("pe-none");
    queryFirst(deleteItem).click();
    await animationFrame();
    expect(".modal").toHaveCount(0);
    expect(queuedCalls()).toEqual([]);
    expect.verifySteps([]);
    await expect.waitForErrors([`Connection to "/web/dataset/call_kw/crm.team/web_search_read"`]);

    await setOffline(false);
    await getService("action").doAction(5);
    expect(".o_list_renderer .o_row_draggable").toHaveCount(3);
});

test("[Offline] Share to Lead is disabled offline and reads no teams", async () => {
    const setOffline = mockCrmOffline(["crm.team/web_search_read", "crm.lead/name_create"]);
    onRpc("/web/binary/upload_attachment", () => {
        expect.step("upload");
    });
    await mountWithCleanup(WebClient);
    await animationFrame(); // the web client's own start-up requests are done
    await setOffline(true);
    const pngFile = new File([new Uint8Array(1)], "card.png", { type: "image/png" });
    getService("dialog").add(ShareTargetDialog, { files: [pngFile] });
    await animationFrame();
    await contains(".o_dialog button:contains(Lead)").click({ force: true });
    await animationFrame();
    expect.verifySteps([]);
    expect(".o_dialog .modal-footer .btn-primary").not.toBeEnabled();
    // programmatic save: nothing uploaded, nothing created or queued
    await getService("share_target").callHook("save");
    await animationFrame();
    expect.verifySteps([]);
    expect(queuedCalls()).toEqual([]);

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["crm.team/web_search_read"]);
    expect(".o_dialog .modal-footer .btn-primary").toBeEnabled();
});

const cogForm = `<form js_class="crm_form"><field name="name"/><field name="active" invisible="1"/></form>`;

/** Opens the cog menu of the form and tries to run `itemName` from the keyboard and by program. */
async function tryCogMenuItem(itemName) {
    await toggleActionMenu();
    const item = `.o-dropdown--menu .o_menu_item:contains(${itemName})`;
    expect(item).toHaveClass("pe-none");
    queryFirst(item).focus();
    await press("Enter");
    queryFirst(item)?.click();
    await animationFrame();
}

test("[Offline] lead form cog menu: Duplicate can't be run offline, Delete still can", async () => {
    const setOffline = mockCrmOffline(["crm.lead/copy", "crm.lead/web_unlink"]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: cogForm, actionMenus: {} });
    await setOffline(true);
    await tryCogMenuItem("Duplicate");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(queuedCalls()).toEqual([]);
    // Delete is queued by the framework (QUEUE): available offline on a lead
    await toggleActionMenu();
    expect(".o-dropdown--menu .o_menu_item:contains(Delete)").not.toHaveClass("pe-none");
});

test("[Offline] unsaved lead cog menu: the framework greys every item, crm makes them inert", async () => {
    const setOffline = mockCrmOffline(["crm.lead/action_archive"]);
    await mountView({ type: "form", resModel: "crm.lead", arch: cogForm, actionMenus: {} });
    await setOffline(true);
    await tryCogMenuItem("Archive");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(queuedCalls()).toEqual([]);
});

test("[Offline] stage form cog menu: Delete can't be run offline", async () => {
    const setOffline = mockCrmOffline(["crm.stage/web_unlink", "crm.stage/unlink"]);
    await mountView({ type: "form", resModel: "crm.stage", resId: 1, actionMenus: {} });
    await setOffline(true);
    await tryCogMenuItem("Delete");
    expect(".modal").toHaveCount(0);
    expect.verifySteps([]);
    expect(queuedCalls()).toEqual([]);

    await setOffline(false);
    await toggleActionMenu();
    expect(".o-dropdown--menu .o_menu_item:contains(Delete)").not.toHaveClass("pe-none");
});

for (const { model, actionId, row, resId, newName } of [
    { model: "crm.stage", actionId: 5, row: "Proposition", resId: 2, newName: "Proposal sent" },
    { model: "crm.team", actionId: 6, row: "Pre-Sales", resId: 2, newName: "Inside Sales" },
]) {
    test(`[Offline] a ${model} form save is queued and replayed`, async () => {
        onRpc(model, "web_save", ({ args }) => {
            expect.step(`server: web_save ${JSON.stringify(args)}`);
        });
        const setOffline = mockCrmOffline();
        await mountWithCleanup(WebClient);
        // the list and the form, visited online
        await getService("action").doAction(actionId);
        await contains(`.o_data_row .o_data_cell[name=name]:contains(${row})`).click();
        await runAllTimers();

        await setOffline(true);
        await contains(".o_field_widget[name=name] input").edit(newName);
        await contains(".o_form_button_save").click();
        await animationFrame();
        expect.verifySteps([]);
        expect(queuedCalls().map((call) => [call.model, call.method, call.args])).toEqual([
            [model, "web_save", [[resId], { name: newName }]],
        ]);

        await setOffline(false);
        await expect.waitForSteps([`server: web_save [[${resId}],{"name":"${newName}"}]`]);
        expect(queuedCalls()).toEqual([]);
        expect(MockServer.env[model].browse(resId)[0].name).toBe(newName);
    });
}

