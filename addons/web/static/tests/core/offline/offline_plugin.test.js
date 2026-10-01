import { Component, proxy, xml } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { ConnectionLostError, rpc } from "@web/core/network/rpc";

import { callOrScheduleHTTP, callOrScheduleORM } from "@web/core/offline/offline_helpers";
import { collectOfflineTempIds, OfflinePlugin } from "@web/core/offline/offline_plugin";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { session } from "@web/session";

import { advanceTime, animationFrame, expect, runAllTimers, test, tick } from "@odoo/hoot";
import {
    contains,
    getService,
    makeTestApp,
    mockOffline,
    mountWithCleanup,
    defineModels,
    fields,
    models,
    mountView,
    mountWithSearch,
    onRpc,
    patchWithCleanup,
    removeFacet,
    toggleMenuItem,
    toggleMenuItemOption,
    toggleSearchBarMenu,
} from "@web/../tests/web_test_helpers";

import { SearchBar } from "@web/search/search_bar/search_bar";
import { defineSearchBarModels, Foo } from "../../search/search_bar_menu/models";

class ResUsers extends models.Model {
    _name = "res.users";
    name = fields.Char();
    _records = [{ id: 7, name: "Mitchell" }];

    has_group() {
        return true;
    }
}
defineModels([ResUsers]);

defineSearchBarModels();

test("RPC:RESPONSE: rpc returning a status 502", async () => {
    expect.errors(1);

    onRpc("/rpc/offline", () => new Response("", { status: 502 }), { pure: true });

    await makeTestApp();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    rpc("/rpc/offline");
    await animationFrame();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    expect.verifyErrors([
        `Error: Connection to "/rpc/offline" couldn't be established or was interrupted`,
    ]);
});

test("RPC:RESPONSE: any succesfull rpc turns offline off", async () => {
    onRpc("/rpc/thatworks", () => true);

    await makeTestApp();
    getService(OfflinePlugin).setOffline(true);
    await tick();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    await rpc("/rpc/thatworks");
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
});

test("'offline' and 'online' events fired on window", async () => {
    let offline = false;
    onRpc(
        "/web/webclient/version_info",
        () => {
            expect.step("version_info");
            if (offline) {
                return new Response("", { status: 502 });
            }
            return new Response("true", { status: 200 });
        },
        { pure: true }
    );

    await makeTestApp();

    offline = true;
    browser.dispatchEvent(new Event("offline"));
    await tick();
    expect.verifySteps(["version_info"]);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    offline = false;
    browser.dispatchEvent(new Event("online"));
    await tick();
    expect.verifySteps(["version_info"]);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
});

test("'offline' and 'online' events fired on window (false positive)", async () => {
    onRpc("/web/webclient/version_info", () => expect.step("version_info"));

    await makeTestApp();

    // "online" event triggered when we're online
    browser.dispatchEvent(new Event("online"));
    await tick();
    expect.verifySteps([]);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    // "offline" event triggered when we're already offline
    getService(OfflinePlugin).setOffline(true);
    await tick();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    browser.dispatchEvent(new Event("offline"));
    await tick();
    expect.waitForSteps([]);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
});

test("offlineUI: disable interactive elements except [data-available-offline]", async () => {
    class Root extends Component {
        static template = xml`
            <div>
                <button type="button" class="button_to_disable"> Disable this button </button>
                <button type="button" class="button_available_offline" data-available-offline=""> Don't disable this button </button>
            </div>
        `;
    }

    await mountWithCleanup(Root);
    expect(`.button_to_disable`).not.toHaveAttribute("disabled");
    expect(`.button_available_offline`).not.toHaveAttribute("disabled");

    getService(OfflinePlugin).setOffline(true);
    expect(`.button_to_disable`).toHaveAttribute("disabled");
    expect(`.button_available_offline`).not.toHaveAttribute("disabled");
    expect(`.button_to_disable`).toHaveClass("o_disabled_offline");
    expect(`.button_available_offline`).not.toHaveClass("o_disabled_offline");

    getService(OfflinePlugin).setOffline(false);
    expect(`.button_to_disable`).not.toHaveAttribute("disabled");
    expect(`.button_available_offline`).not.toHaveAttribute("disabled");
});

test("offlineUI: don't disable already disabled elements", async () => {
    class Root extends Component {
        static template = xml`
            <div>
                <button type="button" class="button" disabled="disabled"> Disabled button </button>
                <input type="checkbox" class="checkbox" disabled="disabled"/>
            </div>
        `;
    }

    await mountWithCleanup(Root);
    expect(`.button`).toHaveAttribute("disabled");
    expect(`.checkbox`).toHaveAttribute("disabled");

    getService(OfflinePlugin).setOffline(true);
    expect(`.button`).toHaveAttribute("disabled");
    expect(`.checkbox`).toHaveAttribute("disabled");
    expect(`.button`).not.toHaveClass("o_disabled_offline");
    expect(`.checkbox`).not.toHaveClass("o_disabled_offline");

    getService(OfflinePlugin).setOffline(false);
    expect(`.button`).toHaveAttribute("disabled");
    expect(`.checkbox`).toHaveAttribute("disabled");
});

test("offlineUI: react to [data-available-offline] attribute changes", async () => {
    let state;
    class Root extends Component {
        static template = xml`
            <div>
                <button type="button" class="btn1" t-att="{ 'data-available-offline': this.state.btn1Available }">
                    First
                </button>
                <button type="button" class="btn2" t-att="{ 'data-available-offline': this.state.btn2Available }">
                    Second
                </button>
            </div>
        `;

        setup() {
            this.state = proxy({
                btn1Available: true,
                btn2Available: false,
            });
            state = this.state;
        }
    }

    await mountWithCleanup(Root);
    expect(".btn1").not.toHaveAttribute("disabled");
    expect(".btn2").not.toHaveAttribute("disabled");

    getService(OfflinePlugin).setOffline(true);
    expect(".btn1").not.toHaveAttribute("disabled");
    expect(".btn2").toHaveAttribute("disabled");

    state.btn1Available = false;
    state.btn2Available = true;
    await animationFrame();
    expect(".btn1").toHaveAttribute("disabled");
    expect(".btn2").not.toHaveAttribute("disabled");
});

test("Repeatedly check connection when going offline", async () => {
    patchWithCleanup(Math, {
        random: () => 1, // no jitter
    });

    const values = [false, true]; // simulate the 'back online status' after 2 'version_info' calls
    const mockVersionInfoRpc = () => {
        expect.step("version_info");
        const online = values.shift();
        if (online) {
            return new Response("true", { status: 200 });
        } else {
            return new Response("", { status: 502 });
        }
    };
    onRpc("/web/webclient/version_info", mockVersionInfoRpc, { pure: true });

    await makeTestApp();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    // go offline
    getService(OfflinePlugin).setOffline(true);
    await tick();

    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    await advanceTime(2000); // first version_info check
    expect(getService(OfflinePlugin).isOffline()).toBe(true);
    await advanceTime(3500); // second version_info check
    expect(getService(OfflinePlugin).isOffline()).toBe(false);
    expect.verifySteps(["version_info", "version_info"]);
});

test("isAvailableOffline", async () => {
    await makeTestApp();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    await getService(OfflinePlugin).setAvailableOffline(1, "list", { search: { key: 1 } });
    await getService(OfflinePlugin).setAvailableOffline(1, "form", { resId: 1 });

    // go offline
    getService(OfflinePlugin).setOffline(true);
    await getService(OfflinePlugin).getVisitedStatus();
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    expect(getService(OfflinePlugin).isAvailableOffline(1)).toBe(true);
    expect(getService(OfflinePlugin).isAvailableOffline(4)).toBe(false);

    expect(getService(OfflinePlugin).isAvailableOffline(1, "list")).toBe(true);
    expect(getService(OfflinePlugin).isAvailableOffline(1, "kanban")).toBe(false);

    expect(getService(OfflinePlugin).isAvailableOffline(1, "list", 1)).toBe(true);
    expect(getService(OfflinePlugin).isAvailableOffline(1, "kanban", 3)).toBe(false);
});

test("getAvailableSearches", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    expect(offline.isOffline()).toBe(false);

    await offline.setAvailableOffline(1, "list", { search: { key: "1" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "2" } });
    await offline.setAvailableOffline(1, "kanban", { search: { key: "oui" } });
    await offline.setAvailableOffline(2, "kanban", { search: { key: "8" } });

    // go offline
    offline.setOffline(true);
    await tick();
    expect(offline.isOffline()).toBe(true);

    expect(await offline.getAvailableSearches(1, "list")).toEqual([{ key: "2" }, { key: "1" }]);
    expect(await offline.getAvailableSearches(1, "kanban")).toEqual([{ key: "oui" }]);
    expect(await offline.getAvailableSearches(2, "kanban")).toEqual([{ key: "8" }]);
});

test("getAvailableSearches (searches order)", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    expect(offline.isOffline()).toBe(false);

    await offline.setAvailableOffline(1, "list", { search: { key: "1" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "2" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "2" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "1" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "3" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "1" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "4" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "3" } });
    await offline.setAvailableOffline(1, "list", { search: { key: "5" } });

    // go offline
    offline.setOffline(true);
    await tick();
    expect(offline.isOffline()).toBe(true);

    expect(await offline.getAvailableSearches(1, "list")).toEqual([
        { key: "1" }, // accessed 3 times
        { key: "3" }, // accessed twice
        { key: "2" }, // accessed twice (less recently)
        { key: "5" }, // accessed once
        { key: "4" }, // accessed once (less recently)
    ]);
});

test("relative date filter available offline, loosing its navigation capabilities", async () => {
    const searchBar = await mountWithSearch(SearchBar, {
        resModel: "foo",
        searchViewId: false,
        searchMenuTypes: ["filter"],
        searchViewArch: `
            <search>
                <filter string="Date" name="date_field" date="date_field"/>
            </search>
        `,
    });
    const searchModel = searchBar.env.searchModel;
    await toggleSearchBarMenu();
    await toggleMenuItem("Date");
    await toggleMenuItemOption("Date", "This Week");

    const thisWeekDomain = [
        "&",
        ["date_field", ">=", "today =week_start"],
        ["date_field", "<", "today =week_start +1w"],
    ];
    expect(searchModel.domain).toEqual(thisWeekDomain);
    expect(searchModel.facets.map((f) => f.type)).toEqual(["relative"]);
    expect(`.o_searchview_facet .o_date_nav_btn`).toHaveCount(2);

    const offline = getService(OfflinePlugin);
    await offline.setAvailableOffline(1, "list", { search: searchModel.getCurrentSearch() });

    await contains(`.o_searchview_facet [aria-label="Next period"]`).click();
    const nextWeekDomain = [
        "&",
        ["date_field", ">=", "today =week_start +1w"],
        ["date_field", "<", "today =week_start +2w"],
    ];
    expect(searchModel.domain).toEqual(nextWeekDomain);
    await offline.setAvailableOffline(1, "list", { search: searchModel.getCurrentSearch() });

    // Go offline: both cached states remain available.
    offline.setOffline(true);
    await tick();
    expect(offline.isOffline()).toBe(true);

    const cachedSearches = await offline.getAvailableSearches(1, "list");
    expect(cachedSearches.length).toBe(2);

    // Both restore their frozen smart-date domain, each degraded to a plain
    // static "filter" facet (no navigation arrows). getAvailableSearches returns
    // the most recently cached first, so "Next week" precedes "This Week".
    searchModel.applySearch(cachedSearches[0]);
    await animationFrame();
    expect(searchModel.domain).toEqual(nextWeekDomain);
    expect(searchModel.facets.map((f) => f.type)).toEqual(["filter"]);
    expect(`.o_searchview_facet .o_date_nav_btn`).toHaveCount(0);

    searchModel.applySearch(cachedSearches[1]);
    await animationFrame();
    expect(searchModel.domain).toEqual(thisWeekDomain);
    expect(searchModel.facets.map((f) => f.type)).toEqual(["filter"]);
    expect(`.o_searchview_facet .o_date_nav_btn`).toHaveCount(0);
});

test("scheduleORM", async () => {
    onRpc("partner", "modify", ({ model, method, args, kwargs }) => {
        expect.step({ model, method, args, kwargs: JSON.stringify(kwargs) });
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    expect(offline.isOffline()).toBe(false);

    // go offline
    offline.setOffline(true);
    await tick();
    expect(offline.isOffline()).toBe(true);

    await offline.scheduleORM("partner", "create", [22, 13], { arg1: true, arg2: false }, {});
    await offline.scheduleORM(
        "partner",
        "modify",
        [22, 13],
        { arg3: true },
        { id: 22, extras: { toSaveMore: true } }
    );

    expect(offline.hasScheduledCalls).toBe(true);
    expect(offline._ormToSync()).toEqual({
        22: {
            key: 22,
            value: {
                args: [22, 13],
                extras: {
                    toSaveMore: true,
                },
                kwargs: {
                    arg3: true,
                },
                method: "modify",
                model: "partner",
            },
        },
        f5b90cfd: {
            key: "f5b90cfd",
            value: {
                args: [22, 13],
                extras: {},
                kwargs: {
                    arg1: true,
                    arg2: false,
                },
                method: "create",
                model: "partner",
            },
        },
    });

    await offline._flushPersists();
    const stored = await offline._crypto.decrypt(
        (await offline._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME)).find(
            (row) => row.key === "f5b90cfd"
        ).value
    );
    expect(stored.extras).toEqual({});

    offline.removeScheduledORM("f5b90cfd");
    expect(offline._ormToSync()).toEqual({
        22: {
            key: 22,
            value: {
                args: [22, 13],
                extras: {
                    toSaveMore: true,
                },
                kwargs: {
                    arg3: true,
                },
                method: "modify",
                model: "partner",
            },
        },
    });

    // go online
    offline.setOffline(false);
    await tick();
    expect(offline.isOffline()).toBe(false);

    //SyncORM !
    await expect.waitForSteps([
        {
            args: [22, 13],
            kwargs: '{"arg3":true,"context":{"lang":"en","tz":"taht","uid":7,"allowed_company_ids":[1]}}',
            method: "modify",
            model: "partner",
        },
    ]);
});

test("queued ORM entry stored without extras still syncs", async () => {
    const setOffline = mockOffline();
    onRpc("partner", "create", ({ args }) => {
        expect.step(`create:${args[0]}`);
        return args[0];
    });

    await makeTestApp();
    const offline = getService(OfflinePlugin);
    await offline._loaded;
    await setOffline(true);

    // Sealed before extras was always present: JSON encryption drops undefined.
    const sealed = await offline._crypto.encrypt({
        model: "partner",
        method: "create",
        args: [22],
        kwargs: {},
    });
    await offline._idb.write(OfflinePlugin.ORM_SYNC_TABLE_NAME, "legacy", sealed);
    // A plaintext row is not this user's sealed payload and must not sync.
    await offline._idb.write(
        OfflinePlugin.ORM_SYNC_TABLE_NAME,
        "plain",
        JSON.stringify({
            model: "partner",
            method: "create",
            args: [99],
            kwargs: {},
        })
    );
    offline.scheduleORM("partner", "create", [23], {}, {
        id: "newer",
        extras: { timeStamp: 10 },
    });

    await offline._updateScheduledORMList();
    expect(offline._ormToSync().legacy.value.extras).toEqual({});
    expect(offline._ormToSync().plain).toBe(undefined);
    expect(
        (await offline._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME)).some(
            (row) => row.key === "plain"
        )
    ).toBe(false);

    await setOffline(false);
    await runAllTimers();
    await advanceTime(1500);
    await runAllTimers();
    await expect.waitForSteps(["create:22", "create:23"]);
});

test("syncORM ConnectionLost", async () => {
    // If a ConnectionLost is detected when syncing,
    // we should stop the syncing and don't put the scheduledORM as in error.
    const setOffline = mockOffline();
    const def = Promise.withResolvers();

    onRpc("partner", "create", async () => {
        await def.promise;
        expect.step("partner create was called: returned connection lost");
        return new Response("", { status: 502 });
    });

    onRpc("partner", "modify", () => {
        throw Error("This shouldn't be called");
    });

    await makeTestApp();
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    // go offline
    await setOffline(true);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    await getService(OfflinePlugin).scheduleORM(
        "partner",
        "create",
        [22, 13],
        { arg1: true, arg2: false },
        { extras: { timeStamp: 11 } }
    );
    await getService(OfflinePlugin).scheduleORM(
        "partner",
        "modify",
        [22, 13],
        { arg3: true },
        { id: 22, extras: { timeStamp: 22, toSaveMore: true } }
    );

    // go online
    await setOffline(false);
    expect(getService(OfflinePlugin).isOffline()).toBe(false);

    expect(getService(OfflinePlugin).syncingORM()).toBe(true);

    //go offline Again
    await setOffline(true);
    def.resolve();
    await tick();
    await runAllTimers(); // run the time for the rpc to sync

    // SyncORM !
    // Only the first should be try to be sync, as we go offline in the middle of the first sync
    await expect.waitForSteps(["partner create was called: returned connection lost"]);

    expect(getService(OfflinePlugin).syncingORM()).toBe(false);

    // Neither of the scheduledORM should be in error !
    expect(getService(OfflinePlugin)._ormToSync()).toEqual({
        22: {
            key: "22",
            value: {
                args: [22, 13],
                extras: {
                    toSaveMore: true,
                    timeStamp: 22,
                },
                kwargs: {
                    arg3: true,
                },
                method: "modify",
                model: "partner",
            },
        },
        ba559cc9: {
            key: "ba559cc9",
            value: {
                args: [22, 13],
                extras: {
                    timeStamp: 11,
                },
                kwargs: {
                    arg1: true,
                    arg2: false,
                },
                method: "create",
                model: "partner",
            },
        },
    });
});

test("scheduleHTTP and sync HTTP queue", async () => {
    const setOffline = mockOffline();
    onRpc("/mail/message/post", () => {
        expect.step("message_post");
        return { store_data: {}, message_id: 1 };
    });

    await makeTestApp();
    const offline = getService(OfflinePlugin);

    await setOffline(true);
    offline.scheduleHTTP(
        "/mail/message/post",
        { thread_id: 1, thread_model: "crm.lead", post_data: { body: "hi" } },
        { extras: { timeStamp: 1, displayName: "Note" } }
    );
    expect(offline.hasScheduledCalls).toBe(true);
    expect(Object.keys(offline._httpToSync()).length).toBe(1);

    await setOffline(false);
    await runAllTimers();
    await expect.waitForSteps(["message_post"]);
    expect(offline.hasScheduledCalls).toBe(false);
});

test("scheduleORM dependsOn waits for parent create", async () => {
    const setOffline = mockOffline();
    let createId = 100;
    onRpc("partner", "web_save", ({ args }) => {
        expect.step(`web_save:${JSON.stringify(args[0])}`);
        if (!args[0].length) {
            return [{ id: ++createId }];
        }
        return [{ id: args[0][0] }];
    });
    onRpc("partner", "message_post", ({ args }) => {
        expect.step(`message_post:${args[0][0]}`);
        return true;
    });

    await makeTestApp();
    const offline = getService(OfflinePlugin);

    await setOffline(true);
    const parentKey = offline.scheduleORM(
        "partner",
        "web_save",
        [[], { name: "New" }],
        {},
        { extras: { timeStamp: 1 } }
    );
    offline.scheduleORM(
        "partner",
        "message_post",
        [[parentKey], { body: "note" }],
        {},
        { extras: { timeStamp: 2, dependsOn: parentKey } }
    );

    await setOffline(false);
    await runAllTimers();
    await advanceTime(1500);
    await runAllTimers();
    await expect.waitForSteps(["web_save:[]", "message_post:101"]);
});

test("older web_save waits for name_create and remaps the temp id", async () => {
    const setOffline = mockOffline();
    const tempId = "offline_tmp_partner";
    onRpc("res.partner", "name_create", () => {
        expect.step("name_create");
        return [5, "Acme"];
    });
    onRpc("crm.lead", "web_save", ({ args }) => {
        expect.step(`web_save:${args[1].partner_id}`);
        return [{ id: 9 }];
    });

    await makeTestApp();
    const offline = getService(OfflinePlugin);
    await setOffline(true);

    offline.scheduleORM("res.partner", "name_create", ["Acme"], {}, {
        id: tempId,
        extras: { timeStamp: 50, tempId },
    });
    offline.scheduleORM(
        "crm.lead",
        "web_save",
        [[], { partner_id: tempId }],
        {},
        { extras: { timeStamp: 1, dependsOn: tempId } }
    );

    await setOffline(false);
    await runAllTimers();
    await advanceTime(1500);
    await runAllTimers();
    await expect.waitForSteps(["name_create", "web_save:5"]);
});

test("id remap is reloaded from IndexedDB after the in-memory map is cleared", async () => {
    const setOffline = mockOffline();
    const tempId = "offline_tmp_reload";
    onRpc("res.partner", "name_create", () => [15, "Acme"]);

    await makeTestApp();
    const offline = getService(OfflinePlugin);
    await setOffline(true);
    offline.scheduleORM("res.partner", "name_create", ["Acme"], {}, {
        id: tempId,
        extras: { timeStamp: 1, tempId },
    });
    await setOffline(false);
    await runAllTimers();
    await advanceTime(500);
    await runAllTimers();

    expect(offline.resolveId(tempId)).toBe(15);
    const map = offline._idRemap();
    for (const key of Object.keys(map)) {
        delete map[key];
    }
    expect(offline.resolveId(tempId)).toBe(tempId);
    await offline._loadIdRemap();
    expect(offline.resolveId(tempId)).toBe(15);
});

test("offline store is scoped to the user and cleared on logout", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    await offline._loaded;
    expect(offline._idb.name).toBe(`offline-${session.db}-${session.uid}`);

    const foreign = new IndexedDB(`offline-${session.db}-999`, "foreign-user");
    await foreign.write(OfflinePlugin.ORM_SYNC_TABLE_NAME, "foreign-key", {
        ciphertext: new ArrayBuffer(8),
        iv: new Uint8Array(12),
    });

    offline.scheduleORM("partner", "create", [1], {}, { id: "mine", extras: { timeStamp: 1 } });
    await offline._updateScheduledORMList();
    expect(offline._ormToSync().mine.value.model).toBe("partner");
    expect(offline._ormToSync()["foreign-key"]).toBe(undefined);
    expect((await foreign.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME)).map((row) => row.key)).toEqual([
        "foreign-key",
    ]);

    await offline.clearPersistentData();
    expect(offline._ormToSync()).toEqual({});
    expect(await offline._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME)).toEqual([]);
    expect((await foreign.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME)).map((row) => row.key)).toEqual([
        "foreign-key",
    ]);
    await foreign.deleteDatabase();
});

test("storeBlob and removeBlob", async () => {
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const key = "blob-test-1";
    await offline.storeBlob(key, { name: "a.txt", base64: "YQ==" });
    const data = await offline.getBlob(key);
    expect(data.name).toBe("a.txt");
    await offline.removeBlob(key);
    expect(await offline.getBlob(key)).toBe(undefined);
});

test("callOrScheduleORM and callOrScheduleHTTP", async () => {
    onRpc("/mail/message/post", () => ({ id: 3 }));
    onRpc("/rpc/offline", () => new Response("", { status: 502 }), { pure: true });
    onRpc("/mail/message/delete", () => {
        throw new Error("nope");
    });
    await makeTestApp();
    const offline = getService(OfflinePlugin);
    const orm = {
        async call(_model, method) {
            if (method === "write") {
                throw new ConnectionLostError("/partner/write");
            }
            if (method === "unlink") {
                throw new Error("nope");
            }
            return [{ id: 1 }];
        },
    };

    expect(await callOrScheduleORM(offline, orm, "partner", "web_save", [[1]], {})).toEqual([
        { id: 1 },
    ]);
    expect(
        await callOrScheduleORM(offline, orm, "partner", "write", [[1]], {}, {
            extras: { displayName: "Pat" },
        })
    ).toBe(null);
    expect(Object.values(offline._ormToSync()).some((entry) => entry.value.method === "write")).toBe(
        true
    );
    try {
        await callOrScheduleORM(offline, orm, "partner", "unlink", [[1]], {});
        expect(false).toBe(true);
    } catch (error) {
        expect(error.message).toInclude("nope");
    }

    expect(await callOrScheduleHTTP(offline, "/mail/message/post", { body: "ok" })).toEqual({
        id: 3,
    });
    expect(
        await callOrScheduleHTTP(offline, "/rpc/offline", { a: 1 }, { extras: { displayName: "x" } })
    ).toBe(null);
    try {
        await callOrScheduleHTTP(offline, "/mail/message/delete", {});
        expect(false).toBe(true);
    } catch (error) {
        expect(error.message).toInclude("nope");
    }
});

test("retry, copy sync, http blobs, and many2x cache", async () => {
    const setOffline = mockOffline();
    onRpc("partner", "copy", () => [55]);
    onRpc("/mail/message/post", async (request) => {
        const { params } = await request.json();
        expect.step(params.body);
        if (params.body === "boom") {
            const error = new Error("boom");
            error.data = { name: "UserError", message: "no" };
            throw error;
        }
        return { id: 1 };
    });

    await makeTestApp();
    await runAllTimers();
    const offline = getService(OfflinePlugin);
    offline.retryScheduledORM("missing");
    offline.retryScheduledHTTP("missing");

    await setOffline(true);
    const ormKey = offline.scheduleORM("partner", "write", [[1]], {}, {
        extras: { error: "stuck", timeStamp: 1, dependsOn: "parent" },
    });
    offline.retryScheduledORM(ormKey);
    expect(offline._ormToSync()[ormKey].value.extras.error).toBe(undefined);

    const httpKey = offline.scheduleHTTP("/mail/message/post", { body: "keep" }, {
        extras: { error: "stuck", timeStamp: 1, blobKeys: ["blob-a"] },
        blobKeys: ["blob-a"],
    });
    offline.retryScheduledHTTP(httpKey);
    expect(offline._httpToSync()[httpKey].value.extras.error).toBe(undefined);
    offline.removeScheduledHTTP(httpKey);

    await offline.storeBlob("blob-a", { name: "a.txt" });
    offline.scheduleORM("partner", "copy", [[1]], {}, { extras: { timeStamp: 2 } });
    offline.scheduleHTTP("/mail/message/post", { body: "hi" }, {
        extras: { timeStamp: 3 },
        blobKeys: ["blob-a"],
    });
    offline.scheduleHTTP("/mail/message/post", { body: "boom" }, { extras: { timeStamp: 4 } });

    const tempId = offline.nextTempId();
    const found = collectOfflineTempIds({ nested: [tempId, { again: tempId }], plain: "x" });
    expect([...found]).toEqual([tempId]);
    expect(collectOfflineTempIds(tempId).has(tempId)).toBe(true);
    expect(collectOfflineTempIds(null).size).toBe(0);
    expect(offline.resolveId(false)).toBe(false);
    expect(offline.resolveId(null)).toBe(null);
    expect(offline.resolveId(undefined)).toBe(undefined);

    await offline.cacheMany2XSearch("crm.stage", [
        { id: 1, display_name: "New" },
        { id: 2, display_name: "Won\nextra" },
    ]);
    const searched = await offline.searchMany2XRecords("crm.stage", "new");
    expect(searched.map((record) => record.display_name)).toEqual(["New"]);
    expect((await offline.searchMany2XRecords("crm.stage", "")).length).toBe(2);
    expect((await offline.readMany2XRecords("crm.stage", [2]))[0].display_name).toBe("Won");

    await setOffline(false);
    await runAllTimers();
    await advanceTime(2500);
    await runAllTimers();

    expect(await offline.getBlob("blob-a")).toBe(undefined);
    const failed = Object.values(offline._httpToSync()).find((entry) => entry.value.extras.error);
    expect(failed.value.extras.error).toInclude("boom");
    await expect.waitForSteps(["hi", "boom"]);
});

test("offline search bar filters, types, and shows more cached searches", async () => {
    expect.errors(2);
    const previousRecords = Foo._records;
    Foo._records = [
        { id: 1, foo: "blip" },
        { id: 2, foo: "blip" },
        { id: 3, foo: "yop" },
        { id: 4, foo: "gnap" },
    ];
    const setOffline = mockOffline();
    try {
        await mountView({
            resModel: "foo",
            type: "kanban",
            arch: `
                <kanban>
                    <templates>
                        <t t-name="card"><field name="foo"/></t>
                    </templates>
                </kanban>`,
            searchViewArch: `
                <search>
                    <filter string="Filter Blip" name="blip" domain="[['foo', '=', 'blip']]"/>
                    <filter string="GroupBy Blip" name="groupby_blip" context="{'group_by': 'foo'}"/>
                    <filter string="Empty Filter" name="empty" domain="[['foo', '=', 'no record']]"/>
                </search>`,
            config: { actionId: 234 },
        });

        await toggleSearchBarMenu();
        await toggleMenuItem("GroupBy Blip");
        await toggleMenuItem("Filter Blip");
        await toggleMenuItem("Empty Filter");
        await removeFacet("Empty Filter");

        const offline = getService(OfflinePlugin);
        for (let i = 0; i < 8; i++) {
            await offline.setAvailableOffline(234, "kanban", {
                search: {
                    key: `extra-${i}`,
                    domain: [],
                    context: {},
                    groupBy: [],
                    facets: [{ type: "filter", title: `Extra ${i}`, values: ["x"], separator: "or" }],
                },
            });
        }

        await setOffline(true);
        expect(".o_offline_search_bar").toHaveCount(1);
        await contains(".o_offline_search_bar .o_searchview_facet [data-icon='close']").click();
        await contains(".o_offline_search_bar .o_searchview_dropdown_toggler").click();
        await contains(".o_search_bar_menu_offline .o-dropdown-item:eq(0)").click();

        const input = document.querySelector(".o_offline_search_bar input");
        input.value = "zzzz-no-match";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await animationFrame();
        input.value = "blip";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await animationFrame();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await animationFrame();

        expect.verifyErrors([
            `Error: Connection to "/web/dataset/call_kw/foo/web_search_read" couldn't be established or was interrupted`,
            `Error: Connection to "/web/dataset/call_kw/foo/web_read_group" couldn't be established or was interrupted`,
        ]);
    } finally {
        Foo._records = previousRecords;
    }
});
