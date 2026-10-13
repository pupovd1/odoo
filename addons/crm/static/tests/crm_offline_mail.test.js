import {
    click,
    contains,
    defineMailModels,
    dragenterFiles,
    dropFiles,
    start,
    startServer,
} from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, queryFirst, runAllTimers } from "@odoo/hoot-dom";
import {
    defineActions,
    defineModels,
    getService,
    onRpc,
    serverState,
} from "@web/../tests/web_test_helpers";
import { serializeDate, today } from "@web/core/l10n/dates";
import {
    CrmLead,
    CrmStage,
    CrmTag,
    CrmTeam,
    mockCrmOffline,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

class Lead extends CrmLead {
    _inherit = ["mail.thread"];
    _views = {
        form: `
            <form js_class="crm_form">
                <sheet><field name="name"/></sheet>
                <chatter/>
            </form>`,
        list: `<list js_class="crm_list"><field name="name"/></list>`,
        search: `<search/>`,
    };

    get_views() {
        const result = super.get_views(...arguments);
        result.models["crm.lead"].has_activities = true; // the lead is a mail.activity.mixin
        return result;
    }
}

defineModels([CrmStage, CrmTeam, CrmTag, Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Leads",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
    },
]);

/** Open lead 1 from the leads action, as the framework caches it for offline use. */
async function openLead() {
    await getService("action").doAction(1);
    await click(".o_data_row:first .o_data_cell");
    await contains(".o-mail-Chatter-topbar");
}

test("[Offline] the CRM entry of the activity menu is disabled offline", async () => {
    const pyEnv = await startServer();
    pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        date_deadline: serializeDate(today()),
        user_id: serverState.userId,
    });
    const setOffline = mockCrmOffline();
    onRpc("/web/action/load", () => {
        expect.step("load My Activities");
        return {
            id: 7,
            type: "ir.actions.act_window",
            res_model: "crm.lead",
            views: [[false, "list"]],
            domain: [],
            context: {},
        };
    });
    await start();
    await click(".o_menu_systray i[aria-label='Activities']");
    const crmGroup = ".o-mail-ActivityGroup[data-model_name='crm.lead']";
    await contains(crmGroup);
    await animationFrame(); // the menu's own refresh is done
    expect(crmGroup).not.toHaveClass("o_disabled_offline");

    await setOffline(true);
    expect(crmGroup).toHaveClass("o_disabled_offline");
    expect(crmGroup).toHaveAttribute("aria-disabled", "true");
    // a programmatic click on the row or on its "Today" filter does nothing
    queryFirst(crmGroup).click();
    queryFirst(`${crmGroup} span:contains(Today)`).click();
    await animationFrame();
    expect.verifySteps([]);
    expect(crmGroup).toHaveCount(1);

    await setOffline(false);
    expect(crmGroup).not.toHaveClass("o_disabled_offline");
    expect(crmGroup).not.toHaveAttribute("aria-disabled");
    await click(crmGroup);
    await expect.waitForSteps(["load My Activities"]);
});

test("[Offline] the lead chatter is read-only offline, with no uncaught error", async () => {
    // opened again offline, the leads come from the framework's cache, which still
    // tries to refresh them from the server in the background
    expect.errors(2);
    await startServer();
    const setOffline = mockCrmOffline();
    let storeCalls = 0;
    onRpc("/mail/store", () => {
        storeCalls++;
    });
    await start();
    await openLead();
    expect(storeCalls).toBeGreaterThan(0);
    await click(".o-mail-Chatter-logNote");
    await contains(".o-mail-Composer");

    await setOffline(true);
    storeCalls = 0;
    // the open composer closes, the chatter says why it is read-only
    await contains(".o-mail-Composer", { count: 0 });
    await contains(".o_crm_chatter_offline");
    for (const selector of [
        ".o-mail-Chatter-sendMessage",
        ".o-mail-Chatter-logNote",
        ".o-mail-Chatter-activity",
        ".o-mail-Chatter-attachFiles",
        ".o-mail-Followers-button",
    ]) {
        expect(selector).not.toBeEnabled();
    }
    // a programmatic click doesn't open the composer either
    for (const selector of [".o-mail-Chatter-sendMessage", ".o-mail-Chatter-logNote"]) {
        queryFirst(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    await animationFrame();
    expect(".o-mail-Composer").toHaveCount(0);

    // the lead opened again offline: its chatter issues no request
    await openLead();
    await contains(".o_crm_chatter_offline");
    expect(storeCalls).toBe(0);
    // (web_search_read and web_read, in either order)
    await expect.waitForErrors([/Connection to "\/web\/dataset\/call_kw\//, /Connection to "\/web\/dataset\/call_kw\//]);

    // back online: the chatter reloads and is usable again
    await setOffline(false);
    await contains(".o_crm_chatter_offline", { count: 0 });
    await animationFrame();
    expect(storeCalls).toBeGreaterThan(0);
    expect(".o-mail-Chatter-sendMessage").toBeEnabled();
    await click(".o-mail-Chatter-logNote");
    await contains(".o-mail-Composer");
});

test("[Offline] files dropped on the lead chatter aren't uploaded offline", async () => {
    await startServer();
    const setOffline = mockCrmOffline();
    onRpc("/mail/attachment/upload", () => {
        expect.step("upload");
    });
    await start();
    await openLead();
    // let the chatter's batched data fetches complete online before the switch
    await runAllTimers();
    await animationFrame();
    const file = new File(["quote"], "quote.txt", { type: "text/plain" });

    await setOffline(true);
    await dragenterFiles(".o-mail-Chatter", [file]);
    await dropFiles(".o-Dropzone", [file]);
    await animationFrame();
    expect.verifySteps([]);
    await contains(".o-mail-AttachmentContainer", { count: 0 });

    await setOffline(false);
    await dragenterFiles(".o-mail-Chatter", [file]);
    await dropFiles(".o-Dropzone", [file]);
    await expect.waitForSteps(["upload"]);
});
