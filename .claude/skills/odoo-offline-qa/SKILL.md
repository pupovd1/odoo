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
(the framework's queue: model, method, args, error), `serverCall`, `poll`, `serverLogOffset`,
`serverRequestsSince`, `BUS_WORKER_REQUEST`, `SELECTORS`, `OFFLINE_NOISE`, `ConsoleLog`.
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

## Limits (measured)

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
- The browser keeps the desktop Chrome user agent (as the mobile JS preset does), so Odoo's
  `isMobileOS()` is false; mobile UI is driven by screen size.
