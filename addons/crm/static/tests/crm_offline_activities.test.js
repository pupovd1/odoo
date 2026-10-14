import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, queryAllTexts, runAllTimers } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    makeMockServer,
    MockServer,
    mountView,
    onRpc,
    serverState,
} from "@web/../tests/web_test_helpers";
import {
    crmOfflineModels,
    mockCrmOffline,
    queuedCalls,
    queuedMethods,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

defineModels(crmOfflineModels);
defineMailModels();

onRpc("crm.lead", "action_log_call", () => true);
onRpc("mail.activity", "action_done", function ({ args }) {
    this.env["mail.activity"].action_feedback(args[0]);
    return true;
});

const activityForm = `
    <form js_class="crm_form">
        <sheet>
            <field name="name"/>
            <field name="user_id"/>
            <widget name="crm_offline_activities"/>
        </sheet>
    </form>`;

/**
 * Lead 1 with a planned call, opened online: the panel keeps the lead's
 * activities and the activity types in the framework's cache. A meeting type
 * exists too. The framework's startup sync (3 s after start) runs here, online,
 * as it does long before a user goes offline (hoot's mock of the browser's lock
 * API doesn't serialize it with the sync at reconnect).
 */
async function openLeadWithActivities({ before } = {}) {
    await makeMockServer();
    before?.();
    MockServer.env["mail.activity.type"].create({ name: "Meeting", category: "meeting" });
    const [activityId] = MockServer.env["mail.activity"].create([
        {
            res_model: "crm.lead",
            res_id: 1,
            activity_type_id: 2, // Call
            summary: "Discuss the quote",
            date_deadline: "2030-01-10",
            user_id: serverState.userId,
            can_write: true,
        },
    ]);
    await mountView({ type: "form", resModel: "crm.lead", resId: 1, arch: activityForm });
    await runAllTimers();
    await animationFrame();
    return activityId;
}

test("[Online] the offline activity panel renders nothing online and keeps its data cached", async () => {
    mockCrmOffline(["mail.activity/search_read", "mail.activity.type/search_read"]);
    await openLeadWithActivities();
    expect(".o_crm_offline_activities").toHaveCount(0);
    expect.verifySteps(["mail.activity/search_read", "mail.activity.type/search_read"]);
});

test("[Offline] schedule an activity: one queued create with client-resolved values, shown as pending sync", async () => {
    const setOffline = mockCrmOffline(["mail.activity/create", "mail.activity/search_read"]);
    await openLeadWithActivities();
    expect.verifySteps(["mail.activity/search_read"]);

    await setOffline(true);
    expect(".o_crm_offline_activities").toHaveCount(1);
    expect.verifySteps([]); // read from what was cached online: no request
    expect(".o_crm_offline_activity").toHaveCount(1);
    expect(".o_crm_offline_activity").toHaveText(/Call: Discuss the quote/);
    // the types come from the cache; a meeting would create a calendar event: not offered
    expect(".o_crm_offline_activity_type option").toHaveCount(3);
    expect(".o_crm_offline_activity_type option:contains(Meeting)").toHaveCount(0);

    await contains(".o_crm_offline_activity_type").select("2");
    await contains(".o_crm_offline_activity_summary").edit("Call back about the delivery");
    // a date input takes a whole date, not one typed character at a time
    await contains(".o_crm_offline_activity_deadline").edit("2030-02-01", { instantly: true });
    await contains(".o_crm_offline_schedule_button").click();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["mail.activity.create"]);
    expect(queuedCalls()[0].args).toEqual([
        [
            {
                res_model: "crm.lead",
                res_id: 1,
                activity_type_id: 2,
                summary: "Call back about the delivery",
                date_deadline: "2030-02-01",
                user_id: serverState.userId,
            },
        ],
    ]);
    expect(".o_crm_offline_pending_activity").toHaveCount(1);
    expect(".o_crm_offline_pending_activity").toHaveText(/Call: Call back about the delivery/);
    expect(".o_crm_offline_pending_activity .o_crm_pending_sync").toHaveText("Pending sync");

    // replayed once back online; the panel hides
    await setOffline(false);
    // (the panel's refresh at reconnect and the replay, in either order; then the
    // panel reads the replayed result)
    await expect.waitForSteps(
        ["mail.activity/search_read", "mail.activity/create", "mail.activity/search_read"],
        { ignoreOrder: true }
    );
    expect(queuedCalls()).toEqual([]);
    expect(".o_crm_offline_activities").toHaveCount(0);
    const summaries = MockServer.env["mail.activity"]
        .search_read([["res_id", "=", 1]], ["summary"])
        .map((activity) => activity.summary);
    expect(summaries).toEqual(["Discuss the quote", "Call back about the delivery"]);
});

test("[Offline] no activity type was cached: Schedule is disabled, not an empty picker", async () => {
    onRpc("mail.activity.type", "search_read", () => []);
    const setOffline = mockCrmOffline(["mail.activity/create"]);
    await openLeadWithActivities();

    await setOffline(true);
    expect(".o_crm_offline_activity_type").toHaveCount(0);
    expect(".o_crm_offline_schedule_button").not.toBeEnabled();
    expect(".o_crm_offline_schedule_unavailable").toHaveText(/No activity type was loaded online/);
    // logging a call doesn't need one
    expect(".o_crm_offline_log_call_button").toBeEnabled();
    expect(queuedCalls()).toEqual([]);
    expect.verifySteps([]);
});

test("[Offline] mark an activity done: only action_done is queued, shown done and pending sync", async () => {
    const setOffline = mockCrmOffline(["mail.activity/action_done"]);
    const activityId = await openLeadWithActivities();

    await setOffline(true);
    expect(".o_crm_offline_mark_done").toBeEnabled();
    await contains(".o_crm_offline_mark_done").click();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["mail.activity.action_done"]);
    expect(queuedCalls()[0].args).toEqual([[activityId]]);
    expect(".o_crm_offline_mark_done").toHaveCount(0);
    expect(".o_crm_offline_activity .o_crm_pending_sync").toHaveText("Done · Pending sync");

    await setOffline(false);
    await expect.waitForSteps(["mail.activity/action_done"]);
    expect(queuedCalls()).toEqual([]);
    expect(MockServer.env["mail.activity"].search([["id", "=", activityId]])).toEqual([]);
});

test("[Offline] log a call: one queued crm.lead call, listed as pending sync", async () => {
    const setOffline = mockCrmOffline(["crm.lead/action_log_call"]);
    await openLeadWithActivities();

    await setOffline(true);
    await contains(".o_crm_offline_call_summary").edit("Asked for a discount");
    await contains(".o_crm_offline_log_call_button").click();
    expect.verifySteps([]);
    expect(queuedMethods()).toEqual(["crm.lead.action_log_call"]);
    expect(queuedCalls()[0].args).toEqual([[1]]);
    expect(queuedCalls()[0].kwargs).toEqual({ summary: "Asked for a discount" });
    expect(".o_crm_offline_pending_call").toHaveText(/Call logged: Asked for a discount/);
    expect(".o_crm_offline_pending_call .o_crm_pending_sync").toHaveText("Pending sync");

    await setOffline(false);
    await expect.waitForSteps(["crm.lead/action_log_call"]);
    expect(queuedCalls()).toEqual([]);
});

test("[Offline] schedule an activity for the lead's salesperson: the queued create carries that assignee", async () => {
    let salespersonId;
    const setOffline = mockCrmOffline(["mail.activity/create"]);
    await openLeadWithActivities({
        before: () => {
            const [partnerId] = MockServer.env["res.partner"].create([{ name: "Sales Rep" }]);
            [salespersonId] = MockServer.env["res.users"].create([
                { name: "Sales Rep", login: "rep", partner_id: partnerId },
            ]);
            MockServer.env["crm.lead"].write([1], { user_id: salespersonId });
        },
    });

    await setOffline(true);
    // the current user, then the lead's salesperson
    expect(queryAllTexts(".o_crm_offline_activity_assignee option")).toEqual([
        queryAllTexts(".o_crm_offline_activity_assignee option")[0],
        "Sales Rep",
    ]);
    await contains(".o_crm_offline_activity_assignee").select(String(salespersonId));
    await contains(".o_crm_offline_activity_summary").edit("Visit the customer");
    await contains(".o_crm_offline_schedule_button").click();
    expect.verifySteps([]);
    expect(queuedCalls()[0].args[0][0]).toEqual({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: queuedCalls()[0].args[0][0].activity_type_id,
        summary: "Visit the customer",
        date_deadline: queuedCalls()[0].args[0][0].date_deadline,
        user_id: salespersonId,
    });

    await setOffline(false);
    await expect.waitForSteps(["mail.activity/create"]);
    const [scheduled] = MockServer.env["mail.activity"].search_read(
        [["summary", "=", "Visit the customer"]],
        ["user_id"]
    );
    expect(scheduled.user_id[0]).toBe(salespersonId);
});

