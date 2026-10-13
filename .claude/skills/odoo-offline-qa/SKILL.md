---
name: odoo-offline-qa
description: How to test Odoo's offline behavior in this repo in a real browser. Use for ANY offline UI test or QA - going offline and back online, an offline reload, offline edits and their queued replay, mobile (375x667) offline flows such as editing a lead, quick create, scheduling an activity or marking won - and to confirm on the server after reconnect that queued writes arrived. Read it before driving a browser offline.
---

# Offline QA for Odoo CRM in this repo

Drive headless Chromium with Playwright (installed under scripts/dev/), take it offline, and
check the result on the server. Everything here was verified against this checkout; the
selectors are stock Odoo 20.0, so re-check them against the DOM when your change adds UI.

## Before every browser check

1. Rebuild assets after any front-end change: `scripts/dev/rebuild-assets.sh`. A failure caused
   only by stale bundles is not a real result. (Each test run uses a fresh browser profile, so it
   always loads the current bundles.)
2. Server: `scripts/dev/start.sh --background` (http://localhost:8069, database crm_offline,
   admin/admin). The test scripts (test-py.sh, test-js.sh, ...) stop it; start it again after.
   Run one browser test at a time.
3. Playwright, once per container: `npm ci --prefix scripts/dev`. It installs into the
   git-ignored scripts/dev/node_modules and changes no tracked file. It uses the preinstalled
   Chromium, or .venv/bin/chromium.
4. Smoke first: `node scripts/dev/offline-smoke.mjs` must print `offline-smoke: PASSED`. It logs
   in on a mobile context, opens the pipeline, goes offline, reloads offline, checks the pipeline
   renders from cache and that no page request reached the server, and goes back online.
   Screenshot and console log: .eval/state/smoke/.

## What makes an offline test real

- Secure context: always http://localhost:8069. Over plain HTTP on any other host, Odoo disables
  offline entirely (no IndexedDB, no sync, scheduleORM throws). `window.isSecureContext` must be
  true.
- Mobile context: viewport 375x667, isMobile, hasTouch (the mobile JS preset's size), so the
  small-screen UI (`UIPlugin.isSmall`) renders. For desktop checks use 1366x768 without isMobile.
- Persistent profile: a plain `browser.newContext()` keeps its HTTP cache in memory and drops the
  6.7 MB web.assets_web bundle, so an offline reload can't load the app. `launchMobile()` uses a
  fresh persistent profile (disk cache, like a phone).
- Service worker offline too: Playwright applies `context.setOffline()` to the service worker
  only with `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`, which importing
  offline-smoke.mjs sets. Without it the worker keeps fetching pages from the server.
- Visit online first: only what was opened online is available offline (the pipeline, each lead
  form, the quick-create form). Wait until it is cached before going offline:
  `waitUntilCached(page, "kanban")` or `waitUntilCached(page, "form")`.
- Going offline: `goOffline(context, page)` waits until Odoo shows "Working offline" (systray
  `.o_menu_systray .o_offline_systray`; an icon with that aria-label on small screens). Buttons
  without `data-available-offline` then carry `disabled` and `.o_disabled_offline`.
- Back online: `goOnline(context, page)` waits until the queue has replayed (the indicator
  disappears) or a replay failed (label "Sync issues"; the call stays parked in the systray).

## Helpers: scripts/dev/offline-smoke.mjs

Write flow scripts under .eval/state/qa/ (git-ignored) and run them with node:

```js
// .eval/state/qa/edit_lead_offline.mjs
import { launchMobile, login, readPipeline, waitUntilCached, goOffline, goOnline, poll, queuedCalls, serverCall, SELECTORS }
    from "../../../scripts/dev/offline-smoke.mjs";

const { context, page, close } = await launchMobile();
try {
    await login(page); // lands on /odoo/crm
    await readPipeline(page);
    await page.locator(SELECTORS.kanbanCard).first().click(); // visit the lead online
    await page.waitForURL(/\/odoo\/crm\/\d+/);
    const id = Number(page.url().match(/\/odoo\/crm\/(\d+)/)[1]);
    await waitUntilCached(page, "form");
    const [before] = await serverCall(context, "crm.lead", "read", [[id], ["expected_revenue"]]);

    await goOffline(context, page);
    await page.locator(".o_form_view .o_field_widget[name=expected_revenue] input:visible").fill(String(before.expected_revenue + 1));
    await page.locator(".o_form_status_indicator .o_form_button_save").click();
    const queued = await poll(async () => (await queuedCalls(page)).length && queuedCalls(page), { timeout: 10_000, what: "the save to be queued" });
    console.log(queued.map((c) => `${c.model}.${c.method}`)); // [ 'crm.lead.web_save' ]
    const [whileOffline] = await serverCall(context, "crm.lead", "read", [[id], ["expected_revenue"]]);
    if (whileOffline.expected_revenue !== before.expected_revenue) throw new Error("a write reached the server while offline");

    const state = await goOnline(context, page); // waits for the replay
    if (state.shown) throw new Error(`replay failed: ${state.label}`);
    const [after] = await serverCall(context, "crm.lead", "read", [[id], ["expected_revenue"]]);
    if (after.expected_revenue !== before.expected_revenue + 1) throw new Error("the queued write didn't reach the server");
    console.log("PASS: offline edit replayed to the server");
} finally {
    await close();
}
```

Exports: `launchMobile`, `login`, `readPipeline`, `waitUntilCached`, `goOffline`, `goOnline`,
`offlineState` (indicator, label, disabled-control count, navigator.onLine), `queuedCalls`
(the framework's queue: model, method, args, error), `serverCall`, `poll`, `forgetView` and
`restoreOfflineStore` (see "A never-visited view"), `serverLogOffset`, `serverRequestsSince`,
`BUS_WORKER_REQUEST`, `SELECTORS`, `OFFLINE_NOISE`, `ConsoleLog`.
Save screenshots and logs under .eval/state/.

## Driving the flows

| Flow | How (stock 20.0 selectors) | Stock offline behavior |
|---|---|---|
| Edit a lead | lead form fields render twice (desktop and touch blocks): use `:visible`, e.g. `.o_form_view .o_field_widget[name=expected_revenue] input:visible`; save with `.o_form_status_indicator .o_form_button_save` | works: queues `crm.lead.web_save`, replays on reconnect |
| Quick create | column "+" `.o_kanban_group .o_kanban_quick_add`, then `.o_kanban_quick_create` with `[name=name] input:visible` and Add `.o_kanban_add` | "+" is disabled offline |
| Schedule an activity | chatter `.o-mail-Chatter-activity` on the lead form | disabled offline |
| Mark won | `.o_form_view .o_statusbar_buttons button[name=action_set_won_rainbowman]` (on small screens the first statusbar button shows; the others are under "More") | disabled offline |

The CRM offline work (KICKOFF.md) changes the last three: test the new behavior with the
selectors of the new components.

## Confirm on the server after reconnect

Wait for `goOnline()` to return with `state.shown === false` (queue empty), then read the records:

- In the flow script: `serverCall(context, model, method, args, kwargs)` posts to
  /web/dataset/call_kw with the browser's session. It is sent from Node, so it also works while
  the browser is offline: use it to prove the server still has the old value before reconnecting.
- XML-RPC, independent of the browser session:

  ```sh
  .venv/bin/python - <<'PY'
  import xmlrpc.client
  url, db, user, pwd = "http://localhost:8069", "crm_offline", "admin", "admin"
  uid = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common").authenticate(db, user, pwd, {})
  models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
  print(models.execute_kw(db, uid, pwd, "crm.lead", "search_read",
        [[["name", "=", "Lead created offline"]]], {"fields": ["name", "stage_id", "won_status"]}))
  PY
  ```

- odoo shell, straight from the database (works while the server runs):

  ```sh
  .venv/bin/python odoo-bin shell -c scripts/dev/odoo.conf -d crm_offline --no-http --log-level=warn <<'PY'
  print(env["crm.lead"].search_read([("name", "=", "Lead created offline")], ["stage_id", "won_status"]))
  print(env["mail.activity"].search_read([("res_model", "=", "crm.lead")], ["res_id", "summary"], order="id desc", limit=3))
  PY
  ```

- Nothing may reach the server while offline: `const offset = serverLogOffset()` before
  `goOffline`, then `serverRequestsSince(offset)` before `goOnline` (it reads logs/odoo.log),
  ignoring only `BUS_WORKER_REQUEST` matches (see Limits).

Tests may write test data in crm_offline; reset it between runs with scripts/dev/reset-db.sh.

## A never-visited view: the offline action helper

A list or kanban view whose records were never loaded online must show Odoo's offline action
helper when opened offline ("There is no data to display offline for the given filters"), not an
empty view or an error. The UI won't take you to such a view: offline, the view switcher disables
views that aren't cached, and the action plugin swaps an unavailable view for a cached one. So
make the pipeline look never visited:

1. Visit the pipeline online and wait until it is cached: `readPipeline(page)`,
   `waitUntilCached(page, "kanban")`.
2. Get the pipeline action's id: the `ir.actions.act_window` whose path is `crm`.
3. Go offline, then call `forgetView(page, { actionId, model: "crm.lead" })`. It backs up (into
   the IndexedDB database `offline-qa-backup`) and deletes the action's visited-ui items
   (IndexedDB `offline`) and crm.lead's cached `web_read_group` / `web_search_read` results
   (IndexedDB `rpc`). The view definitions stay cached. Check that it removed at least one of each.
4. Reload: until then the page still has the data in memory.
5. Check: `SELECTORS.noOfflineData` shows that exact text; no kanban card; no `.o_error_dialog`;
   no error except `OFFLINE_NOISE`; the systray still says "Working offline".
6. Restore the offline store: `restoreOfflineStore(page)`, reload, and check that the pipeline
   renders its cards from cache again, still offline. Then `goOnline`.

```js
// .eval/state/qa/never_visited_view.mjs
import { launchMobile, login, readPipeline, waitUntilCached, goOffline, goOnline, offlineState, forgetView, restoreOfflineStore, serverCall, SELECTORS, OFFLINE_NOISE }
    from "../../../scripts/dev/offline-smoke.mjs";

const { context, page, close, log } = await launchMobile();
try {
    await login(page); // 1. the pipeline, visited online
    const online = await readPipeline(page);
    await waitUntilCached(page, "kanban");
    const [{ id: actionId }] = await serverCall(context, "ir.actions.act_window", "search_read", [[["path", "=", "crm"]], ["id"]]); // 2.

    await goOffline(context, page); // 3.
    const removed = await forgetView(page, { actionId, model: "crm.lead" });
    if (!removed.visited || !removed.data) throw new Error(`nothing to forget: ${JSON.stringify(removed)}`);
    log.phase = "offline-reload";
    await page.reload(); // 4.
    const helper = page.locator(SELECTORS.noOfflineData); // 5.
    await helper.waitFor({ timeout: 30_000 });
    const text = (await helper.innerText()).trim();
    if (!text.includes("There is no data to display offline for the given filters")) throw new Error(`helper text: ${text}`);
    if (await page.locator(SELECTORS.kanbanCard).count()) throw new Error("kanban cards shown, not the helper");
    if (await page.locator(SELECTORS.errorDialog).count()) throw new Error("error dialog shown");
    const errors = [...log.errors("pageerror"), ...log.errors("console.error")].filter((e) => !OFFLINE_NOISE.test(e.text));
    if (errors.length) throw new Error(`errors: ${errors.map((e) => e.text.split("\n")[0]).join(" | ")}`);
    if ((await offlineState(page)).label !== "Working offline") throw new Error("not offline any more");
    await page.screenshot({ path: ".eval/state/qa/never-visited-helper.png" });
    console.log(`PASS: never-visited view shows "${text}"`);

    await restoreOfflineStore(page); // 6.
    await page.reload();
    const restored = await readPipeline(page);
    if (restored.cards.length !== online.cards.length) throw new Error("the restored store doesn't render the pipeline");
    console.log(`PASS: offline store restored, the pipeline renders from cache again (${restored.cards.length} cards)`);
    await goOnline(context, page);
} finally {
    await close();
}
```

Run it from the repository root (`node .eval/state/qa/never_visited_view.mjs`). The store lives in
the browser profile that `launchMobile()` creates and `close()` deletes, so a run that fails
before step 6 leaves nothing behind.

A lead form never opened online behaves differently in stock code: opening `/odoo/crm/<id>`
offline shows the cached pipeline instead (the action plugin swaps the unavailable form for a
cached view), with no helper and no error. KICKOFF acceptance check 9 asks for the helper there.

## Limits

### What the Playwright mobile context can and can't prove

`launchMobile()` gives a 375x667 context with isMobile and hasTouch. Measured in this repo:

| Area | Proven in the Playwright mobile context | Can't be proven there: prove it with `./scripts/dev/test-js.sh mobile` |
|---|---|---|
| Small screen | `UIPlugin.isSmall` is true, so the mobile UI renders | |
| Touch detection | `ontouchstart` exists, `(pointer: coarse)` matches, Odoo's `hasTouch()` is true, `<body>` has `o_touch_device` | |
| Taps | `locator.tap()` sends touch events: tapping a pipeline card opened the lead | |
| Gestures | only taps: Playwright has `locator.tap()` and `page.touchscreen.tap()`, no touch move; a mouse drag is not a swipe | swipes and drags: under the mobile preset, hoot-dom's `drag`, `pointerDown` and `scroll` send touch-type pointer events |
| Bottom sheets | a dropdown opens as a bottom sheet (a card's ⋮ menu gave `.o_bottom_sheet` with Edit and Delete), its items can be tapped, and tapping `.o_bottom_sheet_backdrop` closes it | dismissing it by swiping down: the sheet tracks the scroll position of `.o_bottom_sheet_rail`, which hoot `scroll` can set |
| PWA install | the manifest can be read (`context.request.get("/web/manifest.webmanifest")`: name, shortcuts, icons); the service worker and the offline cache work (offline-smoke.mjs) | the install prompt: headless Chromium fires no `beforeinstallprompt` and has no install UI; dispatch a `BeforeInstallPromptEvent` as addons/web/static/tests/core/pwa_service.test.js does |
| Installed app | nothing: `display-mode: standalone` can't be emulated (CDP `Emulation.setEmulatedMedia` left it false) | code that branches on `isDisplayStandalone()`: `mockMatchMedia({ "display-mode": "standalone" })` from `@odoo/hoot` |
| Android or iOS code | nothing: the user agent stays desktop Chrome, so `isMobileOS()` is false (as in the mobile JS preset) | `mockUserAgent("android")` from `@odoo/hoot` |

`./scripts/dev/test-js.sh mobile` runs crm's own unit tests (addons/crm/static/tests/*.test.js)
under hoot's mobile preset: 375x667 with `touch: true`, which mocks touch (`mockTouch(true)`)
before each test. web's tests don't run there. So the proof for a row above is a crm unit test
that runs in that preset: tag it `test.tags("mobile")` or leave it untagged, and don't tag it
`headless`, because the mobile run excludes `headless` tests.

### Measured gaps

- Playwright can't take workers offline (shared or dedicated). Odoo's bus worker keeps or
  reopens its websocket while the page is offline (`GET /websocket`,
  `GET /bus/websocket_worker_bundle`), so bus notifications can still arrive. Nothing else gets
  through; offline-smoke.mjs checks that.
- The service worker keeps the session info in memory only. On a phone, Chrome stops an idle
  worker after about 30 s; an offline reload then shows Odoo's "You are offline" page instead of
  the cached app. Playwright keeps the worker alive (after 45 s idle the reload still showed the
  app), so to test the phone case, stop it before the offline reload:
  `const cdp = await context.newCDPSession(page); await cdp.send("ServiceWorker.enable"); await cdp.send("ServiceWorker.stopAllWorkers");`
  This is an addons/web gap: record it as a known limit (.eval/ANSWERS.md), don't fix it.
- Expected errors while offline (treated as noise by the smoke): failed requests
  (`net::ERR_INTERNET_DISCONNECTED`), an uncaught `TypeError: Failed to fetch` from
  `odoo.reloadMenus` (the page's inline boot script) and one from
  `LocalizationPlugin.fetchTranslations`. Any other error is a finding.
