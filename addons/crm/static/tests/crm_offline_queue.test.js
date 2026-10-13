import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame, click, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    getService,
    makeServerError,
    MockServer,
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

const leadForm = `
    <form js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won" type="object" data-available-offline="1"
                invisible="won_status == 'won' or type == 'lead' or not active or not id"/>
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
 * before a user goes offline. hoot's navigator.locks doesn't serialize the
 * "db-sync" lock: a startup sync still pending at reconnect would replay the
 * queue a second time, which the browser's lock prevents.
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
