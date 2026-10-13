import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-dom";
import { Component, xml } from "@odoo/owl";
import { defineModels, getService, mountWithCleanup, patchWithCleanup } from "@web/../tests/web_test_helpers";
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
