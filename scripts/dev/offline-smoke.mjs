#!/usr/bin/env node
// Offline smoke test for the dev server started by scripts/dev/start.sh.
//
// In a mobile Chromium context (375x667, isMobile, hasTouch) on http://localhost:8069 (a secure
// context, so Odoo's offline features are on), it logs in as admin, opens the CRM pipeline,
// waits until the pipeline is cached for offline use, goes offline with
// context.setOffline(true), checks that Odoo shows its offline state, reloads once while
// offline, checks that the pipeline renders from cache without reaching the server, then goes
// back online with context.setOffline(false) and checks that Odoo notices.
// Screenshot and console log: .eval/state/smoke/. Exit status 1 if any check fails.
//
// Usage: npm ci --prefix scripts/dev     (once: installs Playwright into scripts/dev/node_modules)
//        node scripts/dev/offline-smoke.mjs
// Env:   ODOO_URL (default http://localhost:8069), ODOO_LOGIN / ODOO_PASSWORD (admin / admin),
//        HEADED=1 to watch the browser.
//
// Two browser settings matter for a real offline test (found in the spike that wrote this):
// - A persistent profile. A plain Playwright context keeps its HTTP cache in memory only, which
//   doesn't hold the 6.7 MB web.assets_web bundle, so an offline reload couldn't load the app.
// - PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1. Without it, context.setOffline() doesn't
//   apply to the service worker, which then keeps fetching pages from the server.
// Playwright can't take workers offline (shared or dedicated), so Odoo's bus worker keeps or
// reopens its websocket while the page is offline. The check below allows exactly the bus
// worker's two requests and lists them; any other request reaching the server fails it.
//
// The helpers are exported for other offline QA scripts (.claude/skills/odoo-offline-qa).

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Make context.setOffline() apply to the service worker too (read when Playwright attaches to it).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

let chromium;
try {
    ({ chromium } = await import("playwright"));
} catch (error) {
    throw new Error("Playwright is not installed: run `npm ci --prefix scripts/dev` from the repository root", {
        cause: error,
    });
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ODOO_URL = process.env.ODOO_URL || "http://localhost:8069";
export const SMOKE_DIR = path.join(REPO_ROOT, ".eval/state/smoke");
export const SERVER_LOG = path.join(REPO_ROOT, "logs/odoo.log");

// The device the mobile JS preset (MobileWebSuite) also uses.
export const MOBILE_CONTEXT = { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true };

export const SELECTORS = {
    // Systray item shown while offline or while calls are queued (an icon only on small screens).
    offlineIndicator: ".o_menu_systray .o_offline_systray",
    kanbanGroup: ".o_kanban_renderer .o_kanban_group",
    kanbanCard: ".o_kanban_renderer .o_kanban_record:not(.o_kanban_ghost):not(.o-kanban-button-new)",
    // OfflineActionHelper: the view has nothing cached for the current filters.
    noOfflineData: ".o_view_nocontent:has-text('no data to display offline')",
    errorDialog: ".o_error_dialog",
};

// Errors that are expected while the browser is offline: failed network requests, including
// Odoo's own boot fetches (odoo.reloadMenus, LocalizationPlugin.fetchTranslations).
export const OFFLINE_NOISE = /net::ERR_INTERNET_DISCONNECTED|Failed to load resource|TypeError: Failed to fetch/;

export class ConsoleLog {
    phase = "start";
    entries = [];

    add(kind, text) {
        this.entries.push({ time: new Date().toISOString(), phase: this.phase, kind, text });
    }

    attach(page) {
        page.on("console", (msg) => {
            const where = msg.location()?.url;
            this.add(`console.${msg.type()}`, where ? `${msg.text()} (${where})` : msg.text());
        });
        page.on("pageerror", (error) => this.add("pageerror", error.stack || String(error)));
        page.on("requestfailed", (request) =>
            this.add("requestfailed", `${request.method()} ${request.url()}: ${request.failure()?.errorText}`)
        );
        page.on("framenavigated", (frame) => frame === page.mainFrame() && this.add("navigated", frame.url()));
    }

    errors(kind) {
        return this.entries.filter((entry) => entry.kind === kind);
    }

    write(file) {
        const lines = this.entries.map((entry) => `${entry.time} [${entry.phase}] ${entry.kind}: ${entry.text}`);
        writeFileSync(file, lines.join("\n") + "\n");
    }
}

/**
 * Launch headless Chromium with a mobile context on a fresh persistent profile (disk HTTP cache,
 * like a phone's browser). Console output goes to `log`. Call close() when done.
 */
export async function launchMobile({ headless = !process.env.HEADED, log = new ConsoleLog() } = {}) {
    const profile = mkdtempSync(path.join(os.tmpdir(), "odoo-offline-qa-"));
    const options = { ...MOBILE_CONTEXT, baseURL: ODOO_URL, headless, args: ["--no-proxy-server"] };
    let context;
    try {
        context = await chromium.launchPersistentContext(profile, options);
    } catch (error) {
        // Playwright's own Chromium isn't installed: use the one setup.sh linked.
        const fallback = process.env.ODOO_BROWSER_BIN || path.join(REPO_ROOT, ".venv/bin/chromium");
        if (!existsSync(fallback)) {
            rmSync(profile, { recursive: true, force: true });
            throw error;
        }
        context = await chromium.launchPersistentContext(profile, { ...options, executablePath: fallback });
    }
    const page = context.pages()[0] || (await context.newPage());
    log.attach(page);
    const close = async () => {
        await context.close().catch(() => {});
        rmSync(profile, { recursive: true, force: true });
    };
    return { context, page, log, close };
}

export async function login(
    page,
    {
        login = process.env.ODOO_LOGIN || "admin",
        password = process.env.ODOO_PASSWORD || "admin",
        redirect = "/odoo/crm",
    } = {}
) {
    await page.goto(`/web/login?redirect=${encodeURIComponent(redirect)}`);
    const form = page.locator("form.oe_login_form");
    // fill() waits until the page scripts show the form, so the submit can't get lost.
    await form.locator("input[name=login]").fill(login);
    await form.locator("input[name=password]").fill(password);
    await Promise.all([
        page.waitForURL((url) => url.pathname.startsWith(redirect), { timeout: 60_000 }),
        form.locator("button[type=submit]").click(),
    ]);
}

/** Wait for kanban cards and return the stages and card names shown. */
export async function readPipeline(page, { timeout = 30_000 } = {}) {
    await page.locator(SELECTORS.kanbanCard).first().waitFor({ timeout });
    return page.evaluate(
        ({ group, card }) => ({
            stages: document.querySelectorAll(group).length,
            cards: [...document.querySelectorAll(card)].map(
                (el) => (el.querySelector("[name=name]") || el).innerText.trim().split("\n")[0]
            ),
        }),
        { group: SELECTORS.kanbanGroup, card: SELECTORS.kanbanCard }
    );
}

/** Poll `probe` until it returns something truthy (and return that), or throw after `timeout` ms. */
export async function poll(probe, { timeout, interval = 500, what }) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out after ${timeout / 1000}s waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}

/**
 * Wait until the current view can be shown offline: the service worker is active and has the
 * app page cached, and the offline plugin has marked a view of `viewType` as available offline
 * (it does that once the view's data are in the RPC disk cache).
 */
export async function waitUntilCached(page, viewType = "kanban", { timeout = 30_000 } = {}) {
    return poll(
        () =>
            page.evaluate(async (viewType) => {
                const registration = await navigator.serviceWorker?.getRegistration();
                if (registration?.active?.state !== "activated") {
                    return false;
                }
                const cache = await caches.open("odoo-sw-cache");
                if (!(await cache.match("/odoo"))) {
                    return false;
                }
                if (!(await indexedDB.databases()).some((db) => db.name === "offline")) {
                    return false;
                }
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open("offline");
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    if (!db.objectStoreNames.contains("visited-ui-items")) {
                        return false;
                    }
                    const keys = await new Promise((resolve, reject) => {
                        const request = db.transaction("visited-ui-items").objectStore("visited-ui-items").getAllKeys();
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    return keys.some((key) => JSON.parse(key).viewType === viewType);
                } finally {
                    db.close();
                }
            }, viewType),
        { timeout, what: `the ${viewType} view to be cached for offline use` }
    );
}

/** What the page shows about connectivity right now. */
export async function offlineState(page) {
    return page.evaluate((selector) => {
        const indicator = document.querySelector(selector);
        return {
            shown: Boolean(indicator),
            // Small screens show an icon with an aria-label; larger ones a labelled button.
            label: indicator?.querySelector("[aria-label]")?.getAttribute("aria-label") || indicator?.innerText.trim() || null,
            icon: indicator?.querySelector("[data-icon]")?.dataset.icon || null,
            disabledControls: document.querySelectorAll(".o_disabled_offline").length,
            onLine: navigator.onLine,
        };
    }, SELECTORS.offlineIndicator);
}

/** Go offline and wait until Odoo shows it ("Working offline"). */
export async function goOffline(context, page, { timeout = 15_000 } = {}) {
    await context.setOffline(true);
    return poll(
        async () => {
            const state = await offlineState(page);
            return state.label === "Working offline" && state;
        },
        { timeout, what: 'Odoo to show "Working offline"' }
    );
}

/**
 * Go back online and wait until Odoo has replayed every queued call: the offline indicator
 * disappears. Returns the state; `state.shown` with label "Sync issues" means a replayed call
 * failed and is parked in the systray.
 */
export async function goOnline(context, page, { timeout = 60_000 } = {}) {
    await context.setOffline(false);
    return poll(
        async () => {
            const state = await offlineState(page);
            return (!state.shown || state.label === "Sync issues") && state;
        },
        { timeout, what: "Odoo to come back online and replay its queue" }
    );
}

/**
 * The calls waiting in the offline queue (IndexedDB "offline", table "orm-to-sync"):
 * [{ key, model, method, args, kwargs, error }]. `error` is set once a replay failed.
 */
export async function queuedCalls(page) {
    return page.evaluate(async () => {
        if (!(await indexedDB.databases()).some((db) => db.name === "offline")) {
            return [];
        }
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("offline");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            if (!db.objectStoreNames.contains("orm-to-sync")) {
                return [];
            }
            const store = db.transaction("orm-to-sync").objectStore("orm-to-sync");
            const [keys, values] = await Promise.all(
                [store.getAllKeys(), store.getAll()].map(
                    (request) =>
                        new Promise((resolve, reject) => {
                            request.onsuccess = () => resolve(request.result);
                            request.onerror = () => reject(request.error);
                        })
                )
            );
            return values.map((value, i) => {
                const { model, method, args, kwargs, extras } = JSON.parse(value);
                return { key: keys[i], model, method, args, kwargs, error: extras?.error || null };
            });
        } finally {
            db.close();
        }
    });
}

/**
 * Call a model method on the server with the browser's session, for server-side checks:
 * serverCall(context, "crm.lead", "read", [[id], ["name"]]). The request is sent from Node,
 * so it reaches the server whatever the browser's offline state.
 */
export async function serverCall(context, model, method, args = [], kwargs = {}) {
    const response = await context.request.post(`/web/dataset/call_kw/${model}/${method}`, {
        data: { jsonrpc: "2.0", method: "call", id: 1, params: { model, method, args, kwargs } },
    });
    const body = await response.json();
    if (body.error) {
        throw new Error(`${model}.${method}: ${body.error.data?.message || body.error.message}`);
    }
    return body.result;
}

/** Size of logs/odoo.log, to find the requests the server received after this point. */
export function serverLogOffset() {
    return existsSync(SERVER_LOG) ? statSync(SERVER_LOG).size : null;
}

// Requests of Odoo's bus worker, which Playwright can't take offline (see the header).
export const BUS_WORKER_REQUEST = /^GET \/(websocket|bus\/websocket_worker_bundle)\?/;

/** HTTP requests the server logged since `offset` ("GET /path"), or null without a log. */
export function serverRequestsSince(offset) {
    if (offset === null || !existsSync(SERVER_LOG)) {
        return null;
    }
    const length = statSync(SERVER_LOG).size - offset;
    const buffer = Buffer.alloc(Math.max(length, 0));
    const fd = openSync(SERVER_LOG, "r");
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
        closeSync(fd);
    }
    return buffer
        .toString("utf8")
        .split("\n")
        .map((line) => / odoo\.http\.server: .*?"([A-Z]+ \S+)/.exec(line)?.[1])
        .filter(Boolean);
}

async function main() {
    mkdirSync(SMOKE_DIR, { recursive: true });
    const screenshot = path.join(SMOKE_DIR, "offline-pipeline.png");
    const consoleFile = path.join(SMOKE_DIR, "console.log");
    const failureShot = path.join(SMOKE_DIR, "failure.png");
    for (const file of [screenshot, consoleFile, failureShot]) {
        rmSync(file, { force: true }); // no stale output from an earlier run
    }
    const checks = [];
    const check = (name, ok, detail = "") => {
        checks.push({ name, ok });
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
    };

    const log = new ConsoleLog();
    const { context, page, close } = await launchMobile({ log });
    const chrome = /Chrome\/([\d.]+)/.exec(await page.evaluate(() => navigator.userAgent))?.[1];
    console.log(`Chromium ${chrome}, mobile context 375x667 (isMobile, hasTouch), ${ODOO_URL}`);
    try {
        log.phase = "online";
        await login(page);
        const secure = await page.evaluate(() => window.isSecureContext);
        check("secure context", secure, `window.isSecureContext is ${secure} on ${new URL(page.url()).origin}`);
        const online = await readPipeline(page);
        check("pipeline renders online", online.cards.length > 0, `${online.stages} stages, ${online.cards.length} cards`);
        await waitUntilCached(page, "kanban");
        check("pipeline cached for offline use", true, "service worker active, app page cached, kanban view marked available offline");

        log.phase = "offline";
        const offset = serverLogOffset();
        const offline = await goOffline(context, page);
        check(
            "Odoo shows its offline state",
            true,
            `systray "${offline.label}" (icon ${offline.icon}), navigator.onLine ${offline.onLine}, ${offline.disabledControls} controls disabled`
        );

        log.phase = "offline-reload";
        const reloadStart = Date.now();
        const response = await page.reload({ waitUntil: "domcontentloaded" });
        const fromWorker = Boolean(response?.fromServiceWorker());
        check("offline reload served by the service worker", fromWorker, `document status ${response?.status()}, ${fromWorker ? "from the service worker" : "not from the service worker"}`);
        if (await page.locator("h1:has-text('You are offline')").count()) {
            throw new Error('the service worker served the "You are offline" page, not the cached app');
        }
        const cached = await readPipeline(page, { timeout: 90_000 });
        const renderSeconds = ((Date.now() - reloadStart) / 1000).toFixed(1);
        const sameCards = JSON.stringify([...cached.cards].sort()) === JSON.stringify([...online.cards].sort());
        check(
            "pipeline renders from cache after the offline reload",
            cached.cards.length > 0 && sameCards && !(await page.locator(SELECTORS.noOfflineData).count()),
            `${cached.stages} stages, ${cached.cards.length} cards${sameCards ? ", same cards as online" : `; online had ${online.cards.length}`}, rendered ${renderSeconds}s after the reload`
        );
        const stillOffline = await poll(
            async () => {
                const state = await offlineState(page);
                return state.label === "Working offline" && state;
            },
            { timeout: 15_000, what: 'Odoo to show "Working offline" after the reload' }
        );
        check("offline state shown after the reload", true, `systray "${stillOffline.label}", ${stillOffline.disabledControls} controls disabled`);
        const requests = serverRequestsSince(offset);
        if (requests === null) {
            console.log("SKIP  no request reached the server while offline - no logs/odoo.log (server not started by start.sh)");
        } else {
            const fromPage = requests.filter((request) => !BUS_WORKER_REQUEST.test(request));
            const fromBus = requests.filter((request) => BUS_WORKER_REQUEST.test(request));
            check(
                "no page or service-worker request reached the server while offline",
                fromPage.length === 0,
                fromPage.length ? `server logged: ${fromPage.slice(0, 5).join(", ")}` : `logs/odoo.log: ${requests.length} request(s) in the offline window, none from the page or service worker`
            );
            if (fromBus.length) {
                console.log(`NOTE  the bus worker reached the server while offline (Playwright can't take workers offline): ${fromBus.join(", ")}`);
            }
        }
        await page.screenshot({ path: screenshot });

        log.phase = "back-online";
        const back = await goOnline(context, page);
        check(
            "Odoo is back online",
            !back.shown && back.onLine && back.disabledControls === 0,
            back.shown ? `systray still shows "${back.label}"` : "offline indicator gone, no control disabled"
        );
        check("no error dialog", !(await page.locator(SELECTORS.errorDialog).count()));
    } catch (error) {
        check("smoke run", false, error.message.split("\n")[0]);
        await page.screenshot({ path: failureShot }).catch(() => {});
    } finally {
        await context.setOffline(false).catch(() => {});
    }

    // Network failures while offline are expected; any other error, or any error online, fails.
    const offlinePhases = new Set(["offline", "offline-reload"]);
    const errors = [...log.errors("pageerror"), ...log.errors("console.error")];
    const expected = errors.filter((e) => offlinePhases.has(e.phase) && OFFLINE_NOISE.test(e.text));
    const unexpected = errors.filter((e) => !expected.includes(e));
    const firstLine = (e) => `[${e.phase}] ${e.kind}: ${e.text.split("\n")[0]}`;
    check("no unexpected errors", unexpected.length === 0, unexpected.map(firstLine).slice(0, 3).join(" | "));
    if (expected.length) {
        const where = new Set(expected.map((e) => /at ([\w.]+) /.exec(e.text)?.[1] || "network request"));
        console.log(`NOTE  ${expected.length} expected offline network errors (${[...where].join(", ")}); see the console log`);
    }
    log.write(consoleFile);
    await close();

    const failed = checks.filter((c) => !c.ok).length;
    const shot = [screenshot, failureShot].filter((file) => existsSync(file)).map((file) => path.relative(REPO_ROOT, file));
    console.log(`\nScreenshot:  ${shot.join(", ") || "none"}`);
    console.log(`Console log: ${path.relative(REPO_ROOT, consoleFile)} (${log.entries.length} entries)`);
    console.log(failed ? `offline-smoke: FAILED (${failed} of ${checks.length} checks)` : `offline-smoke: PASSED (${checks.length} checks)`);
    return failed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.exit(await main());
}
