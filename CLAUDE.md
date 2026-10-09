# CLAUDE.md

Odoo 20.0 fork. The work is CRM offline/PWA support in addons/crm; the base branch is eval/base.

## 1. Commands

Run from the repository root; details are in scripts/dev/README.md. Database `crm_offline`,
server http://localhost:8069, login admin / admin.

- `scripts/dev/setup.sh`: once per fresh container (system and Python deps, PostgreSQL, Chromium); idempotent.
- `scripts/dev/start.sh [--background]` / `scripts/dev/stop.sh`: dev server on 127.0.0.1:8069; creates
  crm_offline (crm, mail, demo data) if missing. Log: logs/odoo.log.
- `scripts/dev/smoke.sh`: with the server up, logs in, opens the CRM pipeline, checks the secure context.
- `scripts/dev/rebuild-assets.sh`: after every front-end change, before any test run.
- `scripts/dev/test-py.sh`: all crm tests (recreates crm_offline). `scripts/dev/test-py.sh TestCrmOffline`: one class.
- `scripts/dev/test-js.sh desktop` and `scripts/dev/test-js.sh mobile`: crm's JS unit tests, one preset each.
- `scripts/dev/test-guard.sh`: fails if any .test.js uses only( or debug(.
- `scripts/dev/reset-db.sh`: back to a clean crm_offline.
- `scripts/dev/check.sh scope`: run before you stop. `scripts/dev/check.sh full`: run before you report a milestone done.
- Test scripts stop a running dev server. They fail on zero collected tests or a skipped suite;
  the plain odoo-bin forms exit 0 in both cases, so use the scripts.

Facts
- Offline only works over HTTPS or on localhost. Outside a secure context the framework disables offline
  entirely (FakeIndexedDB, no sync, scheduleORM throws), so use http://localhost:8069.
- Asset changes need a module upgrade or a restart with regenerated assets: run rebuild-assets.sh before
  any test run, and treat a failure caused only by stale assets as not a real result.
- There is no CI in this repository: every test command must actually be run and its result reported.

Known baseline failures (exist before this project's changes; out of scope, don't fix, all in addons/web).
Measured with web's full JS suite in this container (Chromium 141; desktop 6,506 tests, mobile 3,968), each
failure then re-run alone 3 times. To re-check: `--test-tags /web:WebSuite.test_unit_desktop` or
`/web:MobileWebSuite.test_unit_mobile`, without `-u` (about 10 minutes each).
- `@web/core/l10n/dates/toLocaleDateTimeString: showWeekday`: desktop and mobile, fails every time. The
  browser's ICU writes U+202F (narrow no-break space) before "PM"; the test expects a normal space.
- `@web/views/fields/daterange_field/list daterange: start date input width matches its span counterpart`:
  desktop only, fails every time. The input is 138 px wide instead of 149 px (this container's fonts).
- Not reproduced: `@web/core/utils/timing/throttleForAnimationScrollEvent/scroll loses target` was reported
  as failing, but passed in all 5 runs here (desktop; mobile does not run it).

When compacting, keep the current milestone, the list of changed files, and the last result of each test command.

## 2. The offline and PWA framework (addons/web)

JS paths are relative to addons/web/static/src.

- Offline plugin: core/offline/offline_plugin.js (`OfflinePlugin`).
  - It sets `isOffline` from every RPC response (ConnectionLostError = HTTP 502, non-JSON reply or XHR
    error, core/network/rpc.js) and from browser online/offline events, then pings
    /web/webclient/version_info with backoff.
  - core/offline/offline_error.js also goes offline on an uncaught ConnectionLostError or fetch error,
    without showing an error dialog.
- Stores: IndexedDB "offline" holds "orm-to-sync" (the queue), "visited-ui-items"(-debug) and
  "many2x_<model>". The RPC disk cache is a separate database, "rpc" (core/network/rpc_cache.js).
- Sync queue: each row is `{model, method, args, kwargs, extras}` as plain JSON, written by `scheduleORM()`.
  The only producers are the relational model's ConnectionLostError fallbacks for web_save, web_unlink
  and action_(un)archive (model/relational_model/record.js, dynamic_list.js); they put `timeStamp` in
  `extras`.
- Replay: `_syncORM()` runs under `navigator.locks` "db-sync", in ascending `extras.timeStamp` order, one
  call per second, as a verbatim `orm.silent.call(model, method, args, kwargs)`. No conflict check
  (last write wins), no id remapping. It runs on reconnect and 3 s after startup.
- Failed calls: a ConnectionLostError stops the replay and keeps the call. Any other error re-queues the
  call with `extras.error`; it is never replayed automatically and stays in the offline systray.
- Encryption and locking: core/utils/indexed_db.js (`IndexedDB`, per-tab mutex) plus core/crypto.js
  (`Crypto`, AES-GCM, key = `session.browser_cache_secret`).
  - Encrypted: many2x values and the RPC cache. Plain: the queue and visited-ui items.
  - "offline" is deleted whenever `session.registry_hash` changes (e.g. a module upgrade), queued calls
    included.
  - The only cross-tab lock is "db-sync".
- Relational-field cache: "many2x_<model>" maps id to the encrypted first line of display_name.
  - Filled by `cacheMany2XSearch()` (Many2XAutocomplete in views/fields/relational_utils.js;
    RelationalModel `_cacheMany2X`); read offline by `searchMany2XRecords()` / `readMany2XRecords()`.
  - rpcBus "CLEAR-CACHES" clears it together with visited-ui, but not the queue.
- Offline-available views: `setAvailableOffline(actionId, viewType, {resId, search})` is called from
  RelationalModel's disk-cache callback.
  - Only when the action's `cache` is truthy: DB act_windows default to True, action dicts built in
    Python without `cache` never are. For list and kanban, only when records came back.
  - `isAvailableOffline()` only answers while offline; when offline,
    webclient/actions/action_plugin.js switches to an available view.
- Offline action helper: views/offline_action_helper.{js,xml} (`OfflineActionHelper`) is the empty state
  list and kanban show offline when nothing is cached for the filters (`couldNotLoadRootOffline`). It is
  not an API.
- Offline systray: webclient/offline_systray/ (`OfflineSystray`, systray "offline").
  - It shows while offline or while calls are queued, groups them by action, turns red on errors, and
    can discard each call.
  - Clicking a queued form-view save opens the form with those changes re-applied as unsaved edits
    (`offlineId`, views/form/form_controller.js). Online, that click also removes the call from the queue.
- Offline-availability attribute: `data-available-offline`, placed on the `<button>` itself.
  - While offline, `button:not([data-available-offline]):not([disabled])` (`SELECTORS_TO_DISABLE`) gets
    `disabled` and class `o_disabled_offline` (core/offline/offline.scss).
  - A MutationObserver on document.body re-applies this; both are removed when back online.
  - Only `<button>` elements are covered.
  - Other opt-ins:
    - Action and cog menu items take `availableOffline: true` (views/list/list_controller.js,
      views/form/form_controller.js); the rest are greyed out with pe-none.
    - Field types not marked `availableOffline` become read-only (views/fields/field.js).
    - Navbar menus use `_isAvailable` (webclient/navbar/navbar.js).
- Secure context: outside one the plugin uses FakeIndexedDB, never syncs, and `scheduleORM()` throws
  NonSecureContextError (core/errors/non_secure_context_error.js).
- Plugin API: `Plugin`, `usePlugin`, `signal` and `computed` come from vendored Owl 3 (`@odoo/owl`,
  addons/web/static/lib/owl/owl.js). Global plugins register with `services.add(Class)`
  (core/services.js); components read `usePlugin(OfflinePlugin).isOffline()`.
- Legacy bridge: the "offline" service at the end of offline_plugin.js (`offline`, `syncingORM`,
  `scheduledORM`) is marked temporary. Its comment says new code should use `usePlugin(OfflinePlugin)`
  and read the `isOffline()` signal.
- Small-screen signal: `UIPlugin.isSmall`, a signal (core/ui/ui_plugin.js; ≤ 767 px, driven by media
  queries); read it with `usePlugin(UIPlugin).isSmall()`. Legacy form: `useService("ui").isSmall`.
  `env.isSmall` was removed and throws.
- Bottom sheet: dialogs have no bottom-sheet option.
  - `DialogPlugin.add` options are onClose, rootRef and scope (core/dialog/dialog_plugin.js); Dialog
    props are in core/dialog/dialog.js.
  - On small screens lg/xl/fs dialogs go fullscreen; sm/md do not.
  - Bottom sheets come from core/bottom_sheet/ (`BottomSheetPlugin`, legacy service "bottom_sheet"),
    through `usePopover(Comp, { useBottomSheet })` (core/popover/popover_hook.js) or Dropdown's
    `bottomSheet` prop (default true, touch devices only, core/dropdown/dropdown.js).
- PWA service: core/pwa/pwa_service.js (legacy service "pwa": install-prompt state, show/decline,
  manifest, scoped apps). The standalone check is `isDisplayStandalone()` in
  core/browser/feature_detection.js.
- Web-manifest controller: addons/web/controllers/webmanifest.py serves /web/manifest.webmanifest,
  /web/service-worker.js, /odoo/offline and the scoped-app routes. Extend it by subclassing
  (`_get_webmanifest`, `_get_service_worker_content`, `_has_share_target`); crm already overrides
  `_has_share_target` (addons/crm/controllers/webmanifest.py).
- Shared service worker: service_worker.js, a single unbundled file (mail appends its own for internal
  users), registered by webclient/webclient.js with scope /odoo.
  - Network-first for HTML navigations. It keeps one cached app page: the last HTML loaded, keyed
    "/odoo", with session info stripped and held in worker memory.
  - Offline, it serves that page for any /odoo/* navigation. It also pre-caches /odoo/offline and
    handles share-target POSTs.
- Offline fallback page: template `web.webclient_offline` (addons/web/views/webclient_templates.xml).
  Served by /odoo/offline, and by the worker when the cached app page can't be used: no session info
  in worker memory (after logout or a worker restart) or debug=assets.
- Reference tests: addons/web/static/tests/core/offline/{offline_plugin,offline_error}.test.js,
  addons/web/static/tests/webclient/offline_systray.test.js.

## 3. addons/crm conventions

- Layout:
  - One directory per component under static/src/components/<name>/, files usually named after it
    (exception: breadcrumbs/crm_breadcrumbs.*).
  - One directory per view type under static/src/views/<crm_kanban|crm_form|crm_list|forecast_*|…>/
    (`<dir>_view.js`, `_model`, `_renderer`, …). View-specific components live in their view directory
    (crm_form/crm_pls_tooltip_button.*).
  - Mail-store models are in static/src/core/common/; older code is in static/src/js/{fields,tours}/.
- Templates: `static template = "crm.X"` matches `<t t-name="crm.X">` in the sibling .xml. Web templates
  are extended with `t-inherit="web.…" t-inherit-mode="primary"` (views/crm_kanban/crm_kanban_view.xml).
- Patching other addons' components:
  - Pattern: `import { patch } from "@web/core/utils/patch";` then
    `patch(Target.prototype, { m() { …; return super.m(...arguments); } })`, in `<target>_patch.js`.
  - Examples: static/src/activity_menu_patch.js (mail ActivityMenu),
    static/src/core/common/res_partner_model_patch.js (mail ResPartner).
  - crm's own views are extended by subclassing, not patching (views/crm_kanban/crm_kanban_view.js).
- mail.activity: models/mail_activity.py (`_inherit = "mail.activity"`, no fields, overrides
  `action_create_calendar_event` only). Related: static/src/activity_menu_patch.js (systray) and
  static/src/views/crm_activity/ (activity view, lazy bundle).
- Kanban views in views/crm_lead_views.xml:
  - Leads kanban `view_crm_lead_kanban` (`class="o_kanban_mobile"`, priority 100) and pipeline
    `crm_case_kanban_view_leads`; both use `js_class="crm_kanban"`.
  - No crm XML reads isSmall. The lead form has separate desktop and touch blocks toggled by
    `d-sm-*` / `d-touch-*` classes (sm = 576 px, not isSmall's 767 px).
  - The only JS isSmall use is views/crm_form/crm_pls_tooltip_button.js (`useBottomSheet: this.ui.isSmall`).
- js_class:
  - The main lead views set one: crm_form, crm_list, crm_kanban, crm_calendar, crm_activity, crm_graph,
    crm_pivot, forecast_kanban/list/graph/pivot. The quick-create form, the simplified list and the
    report views do not.
  - Each key is added with `registry.category("views").add(…)` in static/src/views/<dir>/<dir>_view.js
    (form: crm_form/crm_form.js).
  - forecast_kanban and forecast_list set it through a primary inherit plus `<attribute name="js_class">`;
    forecast_graph and forecast_pivot set it inline.
- Manifest assets (__manifest__.py):
  - `web.assets_backend` = `crm/static/src/**` minus `('remove', 'crm/static/src/views/<dir>/**')` for
    crm_activity, crm_graph, crm_pivot, forecast_graph and forecast_pivot, which are re-listed in
    `web.assets_backend_lazy`.
  - static/src/core/common/** also goes to the livechat, public mail and portal chatter bundles.
  - `web.assets_unit_tests` = static/tests/**/*.test.js, mock_server/**, crm_test_helpers.js and
    crm_mock_server.js. A new helper module elsewhere in static/tests/ is NOT bundled.
  - `web.assets_tests` = static/tests/tours/**/*.
- Python tests:
  - Base classes are in tests/common.py (`TestCrmCommon`, `TestLeadConvertCommon`,
    `TestLeadConvertMassCommon`). Every concrete test class is `@tagged`.
  - Tours run from tests/test_crm_ui.py and tests/test_sales_team_ui.py via
    `self.start_tour("/odoo", "<tour>", login=…)`, in HttpCase classes tagged post_install, -at_install.
  - The onboarding crm_tour lives in static/src/js/tours/crm.js (+ data/crm_tour.xml).
- JS unit tests: static/tests/*.test.js use hoot (`@odoo/hoot`, `-dom`, `-mock`) and
  `@web/../tests/web_test_helpers` (defineModels, mountView, onRpc).
  - Each file declares its models and calls `defineMailModels()`.
  - Preset tags go per test, `test.tags("desktop")` / `test.tags("mobile")` (crm_rainbowman.test.js).
  - Mock server: static/tests/crm_mock_server.js, mock_server/mock_models/.
- Tours: static/tests/tours/*.js register with
  `registry.category("web_tour.tours").add(name, { steps: () => [{ trigger, content, run }] })`,
  using `stepUtils` from `@web_tour/tour_utils`. They are started from Python and have no `url:`.
- tests/__init__.py imports every test_*.py; odoo/tests/loader.py only runs `test_*` modules imported
  there.

## 4. Project rules

Scope
- Change files only under addons/crm/. The fork must stay rebasable onto
  upstream 20.0. To change behavior owned by another addon, extend it
  from inside addons/crm/ with Python _inherit, controller subclassing,
  JS patch(), or XML view or template inheritance.
- Make only the changes the current task needs. Don't refactor or
  optimize existing code that isn't directly involved.

Offline framework
- Never build a second offline engine: no new sync queue, IndexedDB
  wrapper, service worker, cache layer, encryption helper, connectivity
  detector, offline-state store, or conflict resolver. A duplicate stack
  won't inherit the existing encryption, multi-tab locking, and error
  parking, and the two will diverge.
- Don't change the queue's conflict semantics: timestamp-ordered replay,
  last write wins, failed calls parked in the offline systray. No
  conflict detection, write_date comparison, field-level merge, or
  conflict dialog.
- The queue replays model, method, arguments, and kwargs verbatim, with
  no id remapping between calls. Anything that needs a server onchange,
  a transient-model wizard, or an id produced by another call can't be
  queued.
- A control stays usable offline only if it carries the framework's
  offline-availability attribute on the interactive element itself.
- New OWL code uses the plugin API (Plugin, usePlugin, signal), not the
  legacy offline service bridge.

Mobile and desktop
- Gate every mobile behavior on the small-screen signal. Desktop
  behavior must not change.
- "Native mobile" means the installable PWA this fork already supports.
  Never create a native app project (React Native, Flutter, Swift,
  Kotlin, Gradle, Xcode, Capacitor).

Security and dependencies
- Don't add or change any access rule, record rule, or group. The
  offline cache must never widen what a user can see.
- No new dependency: no Python or JS package, no new addon in the
  manifest's depends, requirements.txt unchanged. No npm, bundler, or
  JS build tooling.
- Don't add fields to crm.lead, crm.stage, or crm.team.

Wiring (a component that exists but is never reached is the most common
failure; prove each point with a test)
- Every new view is registered in the view registry and referenced by a
  js_class in the addon's lead views.
- Every new component is reachable from a rendered parent template, not
  only from its own unit test.
- The manifest's existing asset globs already cover new source, test,
  and tour files. Verify that rather than adding globs; add a bundle
  entry only to exclude or lazily load a file, in the existing style.
- Import every new Python test module in the tests package __init__.
  Import every new Python model or controller file in its package
  __init__, and add every new XML data file to the manifest data list
  in dependency order.

Tests
- Follow the addon's existing test conventions: Python tests, JS unit
  tests, and browser tours.
- Run new JS unit tests under both the desktop and the mobile preset.
- Never use only() or debug() in a .test.js file; a guard test fails
  the run if either appears.
- Never delete, skip, retag, or weaken an existing test. The only
  existing test file that may change is the tests package __init__.
