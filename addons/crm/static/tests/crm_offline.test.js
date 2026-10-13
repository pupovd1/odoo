import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    isSmall,
    mockOffline,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { WebClient } from "@web/webclient/webclient";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

class Users extends models.Model {
    name = fields.Char();
    _records = [{ id: 1, name: "Mario" }];
}

class Team extends models.Model {
    _name = "crm.team";
    name = fields.Char();
    use_opportunities = fields.Boolean({ default: true });
    _records = [
        { id: 1, name: "Team A" },
        { id: 2, name: "Team B" },
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
    _records = [{ id: 1, name: "Hot" }];
}

class LostReason extends models.Model {
    _name = "crm.lost.reason";
    name = fields.Char();
    _records = [{ id: 1, name: "Too expensive" }];
}

class Lead extends models.Model {
    _name = "crm.lead";
    name = fields.Char();
    stage_id = fields.Many2one({ relation: "crm.stage" });
    team_id = fields.Many2one({ relation: "crm.team" });
    user_id = fields.Many2one({ relation: "users" });
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

    _records = [
        { id: 1, name: "Opp 1", stage_id: 1, team_id: 1, type: "opportunity" },
        { id: 2, name: "Opp 2", stage_id: 1, team_id: 1, type: "opportunity" },
    ];

    get_rainbowman_message() {
        return "Congrats!";
    }

    action_set_won_rainbowman() {
        this.write({ stage_id: 2, won_status: "won" });
        return true;
    }

    action_convert_to_opportunity() {
        this.write({ type: "opportunity" });
        return true;
    }
}

defineMailModels();
defineModels([Users, Team, Stage, Tag, LostReason, Lead]);

defineActions([
    {
        id: 1,
        name: "CRM Pipeline",
        res_model: "crm.lead",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
        context: { show_team_switcher: true, show_lead_gen_button: true },
    },
]);

Lead._views = {
    "kanban,false": `
        <kanban js_class="crm_kanban" default_group_by="stage_id">
            <templates>
                <t t-name="card"><field name="name"/></t>
            </templates>
        </kanban>`,
    "form,false": `
        <form js_class="crm_form">
            <header>
                <button name="action_set_won_rainbowman" string="Won" type="object"
                    data-available-offline=""/>
                <button name="action_convert_to_opportunity" string="Convert" type="object"
                    data-available-offline=""/>
                <button name="%(crm.crm_lead_lost_action)d" string="Lost" type="action"
                    data-available-offline="" context="{'offline_method': 'action_set_lost'}"/>
            </header>
            <sheet>
                <field name="name"/>
                <field name="stage_id"/>
                <field name="team_id"/>
                <field name="type"/>
                <field name="won_status"/>
            </sheet>
        </form>`,
    "search,false": `<search/>`,
};

test("[Offline] CRM team facet round-trip via getCurrentSearch", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await animationFrame();

    // Select a team while online so switcher data is cached
    if (document.querySelector(".o_crm_team_switcher")) {
        await contains(".o_crm_team_switcher").click();
        await animationFrame();
    }

    await setOffline(true);
    await animationFrame();

    // Offline: Generate becomes New
    await waitFor("button", { text: "New" });
});

test("[Offline] Won button schedules ORM when offline", async () => {
    const setOffline = mockOffline();
    onRpc("crm.lead", "get_rainbowman_message", () => {
        throw new Error("should not be called offline");
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
    await animationFrame();

    await setOffline(true);
    await animationFrame();

    await contains("button[name=action_set_won_rainbowman]").click();
    await animationFrame();

    const offline = getService(OfflinePlugin);
    const entries = Object.values(offline._ormToSync());
    expect(entries.some((e) => e.value.method === "action_set_won_rainbowman")).toBe(true);
});

test("[Offline] Lost button queues action_set_lost without opening the wizard", async () => {
    const setOffline = mockOffline();
    onRpc("/web/action/load", async (request) => {
        const { params } = await request.json();
        if (params.action_id !== 1) {
            throw new Error(`lost wizard must not be loaded offline: ${params.action_id}`);
        }
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
    await animationFrame();

    await setOffline(true);
    await animationFrame();

    // On a narrow screen only the first status button is shown. Lost is in More.
    if (isSmall()) {
        await contains(".o_statusbar_buttons button.dropdown-toggle-split").click();
        await animationFrame();
    }

    const lostButton = document.querySelector("button[name='%(crm.crm_lead_lost_action)d']");
    expect(lostButton).not.toBe(null);
    expect(lostButton.disabled).toBe(false);
    expect(lostButton.classList.contains("o_disabled_offline")).toBe(false);

    await contains("button", { text: "Lost" }).click();
    await animationFrame();

    const entries = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(entries.some((entry) => entry.value.method === "action_set_lost")).toBe(true);
    expect(entries.find((entry) => entry.value.method === "action_set_lost").value.args).toEqual([
        [1],
    ]);
});

test.tags("desktop");
test("[Offline] Mark Lost in the actions menu queues action_set_lost", async () => {
    const setOffline = mockOffline();
    onRpc("/web/action/load", async (request) => {
        const { params } = await request.json();
        if (String(params.action_id).includes("lost") || params.action_id === 9) {
            throw new Error(`lost wizard must not be loaded offline: ${params.action_id}`);
        }
    });

    await mountView({
        type: "form",
        resModel: "crm.lead",
        resId: 1,
        loadActionMenus: true,
        actionMenus: {
            action: [
                {
                    id: 9,
                    name: "Mark Lost",
                    res_model: "crm.lead.lost",
                    type: "ir.actions.act_window",
                },
            ],
        },
        arch: `<form><field name="name"/></form>`,
    });

    await setOffline(true);
    await animationFrame();
    await toggleActionMenu();
    const lostItem = [...document.querySelectorAll(".o-dropdown--menu .o_menu_item")].find((node) =>
        node.textContent.includes("Mark Lost")
    );
    expect(Boolean(lostItem)).toBe(true);
    expect(lostItem.classList.contains("pe-none")).toBe(false);
    await toggleMenuItem("Mark Lost");
    await animationFrame();

    const entries = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(entries.some((entry) => entry.value.method === "action_set_lost")).toBe(true);
    expect(entries.find((entry) => entry.value.method === "action_set_lost").value.args).toEqual([
        [1],
    ]);
});

test.tags("desktop");
test("[Offline] scheduleORM for convert is queued", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
    await animationFrame();
    await setOffline(true);
    await animationFrame();

    await contains("button[name=action_convert_to_opportunity]").click();
    await animationFrame();

    const offline = getService(OfflinePlugin);
    expect(
        Object.values(offline._ormToSync()).some(
            (e) => e.value.method === "action_convert_to_opportunity"
        )
    ).toBe(true);
});

test("Make available offline uses the kanban group read and the form specification", async () => {
    const reads = [];
    onRpc("crm.lead", "web_read_group", () => {
        reads.push("web_read_group");
    });
    onRpc("crm.lead", "web_read", ({ kwargs }) => {
        reads.push(kwargs.specification);
    });
    onRpc("crm.lead", "web_search_read", ({ kwargs }) => {
        reads.push(kwargs.specification);
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
    await animationFrame();
    const formRead = reads.find((entry) => entry && entry.name);
    expect(Boolean(formRead)).toBe(true);
    expect("email_from" in formRead).toBe(false);

    reads.length = 0;
    await getService("action").doAction(1);
    await animationFrame();
    reads.length = 0;

    if (isSmall()) {
        await contains(
            ".o_control_panel_main_buttons button.o-control-panel-adaptive-dropdown"
        ).click();
        await contains(".dropdown-menu .o_crm_offline_prefetch").click();
    } else {
        await contains(".o_crm_offline_prefetch").click();
    }
    await animationFrame();

    expect(reads.includes("web_read_group")).toBe(true);
    const prefetched = reads.filter((entry) => entry && typeof entry === "object");
    expect(prefetched.length).toBeGreaterThan(0);
    expect(prefetched.every((spec) => JSON.stringify(spec) === JSON.stringify(formRead))).toBe(
        true
    );
    expect(reads.some((entry) => entry && entry.email_from)).toBe(false);
});

test("[Offline] Duplicate queues a copy when the connection drops", async () => {
    const setOffline = mockOffline();
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1, { viewType: "form", props: { resId: 1 } });
    await animationFrame();
    await setOffline(true);
    await animationFrame();

    await toggleActionMenu();
    await toggleMenuItem("Duplicate");
    await animationFrame();

    const offline = getService(OfflinePlugin);
    expect(
        Object.values(offline._ormToSync()).some((entry) => entry.value.method === "copy")
    ).toBe(true);
});
