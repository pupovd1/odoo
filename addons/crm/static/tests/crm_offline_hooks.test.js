import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-dom";
import { Component, xml } from "@odoo/owl";
import {
    defineModels,
    getService,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { ConnectionLostError } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useCrmOffline } from "@crm/mobile/offline_hooks";
import { crmOfflineModels, mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

defineModels(crmOfflineModels);
defineMailModels();

/** A component reading the shared offline hooks, as the CRM components do. */
class HooksProbe extends Component {
    static template = xml`
        <div class="o_probe">
            <span class="o_probe_offline" t-out="this.crmOffline.isOffline() ? 'offline' : 'online'"/>
            <span class="o_probe_pending" t-out="this.crmOffline.isPendingSync('crm.lead', 1) ? 'pending' : 'synced'"/>
            <span class="o_probe_creates" t-out="this.crmOffline.pendingCreates('crm.lead').length"/>
        </div>`;

    setup() {
        this.crmOffline = useCrmOffline();
        probe = this.crmOffline;
    }
}
let probe;

test("[Offline] shared offline hooks: connectivity, queued calls, pending sync, pending creates, scheduling", async () => {
    const setOffline = mockCrmOffline();
    const probeComponent = await mountWithCleanup(HooksProbe);
    expect(".o_probe_offline").toHaveText("online");
    expect(".o_probe_pending").toHaveText("synced");
    expect(".o_probe_creates").toHaveText("0");

    await setOffline(true);
    expect(".o_probe_offline").toHaveText("offline");
    expect(probe.isOffline()).toBe(true);

    // scheduleCall: the framework's queue, with the extras its systray and replay read
    const t0 = Date.now();
    const saveKey = probe.scheduleCall("crm.lead", "web_save", [[1], { priority: "1" }], {}, {
        actionId: 1,
        displayName: "Office chairs",
    });
    await advanceTime(10);
    const createKey = probe.scheduleCall("crm.lead", "create", [[{ name: "New lead" }]], {}, {});
    const formCreateKey = getService(OfflinePlugin).scheduleORM("crm.lead", "web_save", [[], { name: "Form lead" }], {}, {
        extras: { timeStamp: t0 + 60_000 },
    });
    getService(OfflinePlugin).scheduleORM("crm.stage", "web_save", [[1], { name: "Fresh" }], {}, {
        extras: { timeStamp: t0 - 60_000 },
    });
    await animationFrame();
    expect(".o_probe_pending").toHaveText("pending");
    expect(".o_probe_creates").toHaveText("2");

    // oldest first; filtered by model
    expect(probe.queuedCalls().map((call) => `${call.model}.${call.method}`)).toEqual([
        "crm.stage.web_save",
        "crm.lead.web_save",
        "crm.lead.create",
        "crm.lead.web_save",
    ]);
    const [save, create] = probe.queuedCalls("crm.lead");
    expect(save.key).toBe(saveKey);
    // the time of the call is added, the given extras kept
    expect(save.extras).toEqual({ timeStamp: save.extras.timeStamp, actionId: 1, displayName: "Office chairs" });
    expect(save.extras.timeStamp >= t0).toBe(true);
    expect(create.key).toBe(createKey);
    expect(create.extras.timeStamp > save.extras.timeStamp).toBe(true);
    expect(probe.pendingCreates("crm.lead").map((call) => call.key)).toEqual([createKey, formCreateKey]);
    expect(probe.isPendingSync("crm.lead", 1)).toBe(true);
    expect(probe.isPendingSync("crm.lead", 2)).toBe(false);
    expect(probe.isPendingSync("crm.stage", 1)).toBe(true);
    expect(probe.isPendingSync("crm.lead", false)).toBe(false);

    // isAvailableOffline: the framework's answer
    patchWithCleanup(OfflinePlugin.prototype, {
        isAvailableOffline(actionId, viewType, resId) {
            expect.step(`isAvailableOffline ${actionId} ${viewType} ${resId}`);
            return true;
        },
    });
    expect(probe.isAvailableOffline(1, "form", 3)).toBe(true);
    expect.verifySteps(["isAvailableOffline 1 form 3"]);

    // the queue empties: re-rendered
    for (const call of probe.queuedCalls()) {
        getService(OfflinePlugin).removeScheduledORM(call.key);
    }
    await animationFrame();
    expect(".o_probe_pending").toHaveText("synced");
    expect(".o_probe_creates").toHaveText("0");
    expect(probeComponent.crmOffline.queuedCalls()).toEqual([]);
});

test("[Offline] shared offline hooks: the records a queued call writes, in one read of the queue", async () => {
    await mountWithCleanup(HooksProbe);
    const offlinePlugin = getService(OfflinePlugin);
    const schedule = (model, method, args) =>
        offlinePlugin.scheduleORM(model, method, args, {}, { extras: { timeStamp: Date.now() } });
    schedule("crm.lead", "web_save", [[1], { priority: "1" }]);
    schedule("crm.lead", "action_set_won", [[4]]);
    schedule("crm.lead", "web_save", [[4], { name: "Reception desk (2)" }]);
    schedule("crm.lead", "create", [[{ name: "New lead" }]]);
    schedule("crm.stage", "web_save", [[2], { name: "Fresh" }]);
    expect([...probe.pendingResIds("crm.lead")].sort()).toEqual([1, 4]);
    expect([...probe.pendingResIds("crm.stage")]).toEqual([2]);
    expect([...probe.pendingResIds("crm.team")]).toEqual([]);
});

test("[Offline] shared offline hooks: a group or access probe lost with the connection is asked again once it is back", async () => {
    // the network drops while the app still believes it's online
    let networkDown = false;
    for (const route of ["res.users/has_group", "crm.team/has_access"]) {
        onRpc(`/web/dataset/call_kw/${route}`, () =>
            networkDown ? new Response("", { status: 502 }) : undefined
        );
    }
    onRpc("res.users", "has_group", ({ args }) => {
        expect.step(`server: has_group ${args[1]}`);
        return true;
    });
    onRpc("crm.team", "has_access", ({ args }) => {
        expect.step(`server: has_access ${JSON.stringify(args)}`);
        return true;
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(HooksProbe);

    networkDown = true;
    await expect(probe.hasGroup("sales_team.group_sale_manager")).rejects.toThrow(ConnectionLostError);
    await expect(probe.checkAccessRight("crm.team", "write", 1)).rejects.toThrow(ConnectionLostError);
    // the framework sees the connection lost
    expect(probe.isOffline()).toBe(true);
    expect.verifySteps([]);

    // back online: web's user cache still holds the lost probes; crm asks the
    // server again, without that cache
    networkDown = false;
    await setOffline(false);
    await expect(probe.hasGroup("sales_team.group_sale_manager")).resolves.toBe(true);
    await expect(probe.checkAccessRight("crm.team", "write", 1)).resolves.toBe(true);
    expect.verifySteps([
        "server: has_group sales_team.group_sale_manager",
        'server: has_access [[1],"write"]',
    ]);
});

test("[Online] shared offline hooks: group and access probes go through web's user cache", async () => {
    onRpc("res.users", "has_group", ({ args }) => {
        expect.step(`server: has_group ${args[1]}`);
        return true;
    });
    mockCrmOffline();
    await mountWithCleanup(HooksProbe);
    await expect(probe.hasGroup("crm.group_use_lead")).resolves.toBe(true);
    await expect(probe.hasGroup("crm.group_use_lead")).resolves.toBe(true);
    // asked once: the second answer is web's cached one
    expect.verifySteps(["server: has_group crm.group_use_lead"]);
});
