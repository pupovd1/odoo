import { describe, expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import {
    assignDialogTestEnv,
    contains,
    getService,
    mockOffline,
    mountWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { OfflineActivityDialog } from "@mail/core/web/offline_activity_dialog";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";

defineMailModels();

describe("mail offline", () => {
    test("[Offline] OfflineActivityDialog queues activity_schedule", async () => {
        assignDialogTestEnv();
        mockOffline();

        let closed = false;
        await mountWithCleanup(OfflineActivityDialog, {
            props: {
                close: () => {
                    closed = true;
                },
                resModel: "crm.lead",
                resIds: [1],
                displayName: "Opp",
            },
        });
        await animationFrame();
        await expect(".o_offline_activity_dialog").toHaveCount(1);

        const offline = getService(OfflinePlugin);
        offline.setOffline(true);
        await contains(".modal-footer .btn-primary").click();
        await animationFrame();

        expect(closed).toBe(true);
        const entries = Object.values(offline._ormToSync());
        expect(entries.some((e) => e.value.method === "activity_schedule")).toBe(true);
    });
});
