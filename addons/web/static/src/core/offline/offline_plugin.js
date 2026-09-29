import {
    computed,
    markRaw,
    onWillDestroy,
    Plugin,
    signal,
    useListener,
    usePlugin,
} from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { Crypto, CRYPTO_ALGO } from "@web/core/crypto";
import { DebugModePlugin } from "@web/core/debug_mode_plugin";
import { NonSecureContextError } from "@web/core/errors/non_secure_context_error";
import { _t } from "@web/core/l10n/translation";
import { normalize } from "@web/core/l10n/utils";
import { ConnectionLostError, rpc, rpcBus } from "@web/core/network/rpc";
import { ORM } from "@web/core/orm_plugin";
import { registry } from "@web/core/registry";
import { services } from "@web/core/services";
import { IndexedDB } from "@web/core/utils/indexed_db";
import { hashCode } from "@web/core/utils/strings";
import { session } from "@web/session";

const IS_READY = Symbol("ready");

/**
 * IndexedDB can only store structured-cloneable values. Search facets are
 * reactive records, so keep the plain data applySearch reads back.
 */
function cloneForIndexedDB(search) {
    try {
        return JSON.parse(JSON.stringify(search));
    } catch {
        return {
            key: search?.key,
            domain: search?.domain,
            groupBys: search?.groupBys,
            facets: [],
        };
    }
}

class FakeIndexedDB {
    // used in non secure context to disable the offline features as data can't be encrypted
    invalidate() {}
    read() {
        return Promise.resolve({});
    }
    write() {}
    delete() {}
    getAllKeys() {
        return Promise.resolve([]);
    }
    getAllEntries() {
        return Promise.resolve([]);
    }
}

export class OfflinePlugin extends Plugin {
    static VISITED_UI_TABLE_NAME = "visited-ui-items";
    static VISITED_UI_TABLE_NAME_DEBUG = "visited-ui-items-debug";
    static ORM_SYNC_TABLE_NAME = "orm-to-sync";
    static HTTP_SYNC_TABLE_NAME = "http-to-sync";
    static BLOB_TABLE_NAME = "offline-blobs";
    static MANY2X_TABLE_PREFIX = "many2x_";
    /** Temporary id -> real id, kept across reloads so later saves can resolve. */
    static ID_REMAP_TABLE_NAME = "id-remap";
    /** Placeholder id prefix for records created offline before sync. */
    static TEMP_ID_PREFIX = "offline_tmp_";

    static SELECTORS_TO_DISABLE = ["button:not([data-available-offline]):not([disabled])"];

    debugMode = usePlugin(DebugModePlugin);
    orm = usePlugin(ORM);

    _idb = window.isSecureContext
        ? markRaw(new IndexedDB("offline", session.registry_hash + CRYPTO_ALGO))
        : new FakeIndexedDB();
    _crypto =
        window.isSecureContext &&
        session.browser_cache_secret &&
        new Crypto(session.browser_cache_secret);
    _visitedUITable = computed(() =>
        this.debugMode.isActive()
            ? OfflinePlugin.VISITED_UI_TABLE_NAME_DEBUG
            : OfflinePlugin.VISITED_UI_TABLE_NAME
    );
    _timeout = null; // used to repeatedly ping the server when offline
    _observer = null; // used to detect DOM mutations and disable the UI when offline

    /** whether the connection to the server is currently lost */
    isOffline = signal(false);

    /** whether scheduled ORM/HTTP calls are currently being synced */
    syncingORM = signal(false);

    /** orm calls that need to be synced once we go back online */
    _ormToSync = signal.Object({});

    /** http calls that need to be synced once we go back online */
    _httpToSync = signal.Object({});

    /** maps temporary offline ids / queue keys to real server ids after create sync */
    _idRemap = signal.Object({});

    /** items available offline (only populated when offline) */
    _visited = signal.Object({ [IS_READY]: null });

    setup() {
        // Use "offline" and "online" events for instant detection of connection lost/restored.
        useListener(browser, "offline", () => {
            if (!this.isOffline()) {
                this.checkConnection();
            }
        });
        useListener(browser, "online", () => {
            if (this.isOffline()) {
                this.checkConnection();
            }
        });

        // Use RPC:RESPONSE to validate the current offline status, which is more accurate than
        // the "offline"/"online" events (e.g. server is down).
        useListener(rpcBus, "RPC:RESPONSE", (ev) => {
            this.setOffline(ev.detail.error instanceof ConnectionLostError);
        });

        // When the "CLEAR-CACHES" event is triggered, the rpc cache is wiped out, so we must also
        // clear the information about elements that are available offline, as they aren't anymore.
        useListener(rpcBus, "CLEAR-CACHES", () => {
            this._idb.invalidate([
                OfflinePlugin.VISITED_UI_TABLE_NAME,
                OfflinePlugin.VISITED_UI_TABLE_NAME_DEBUG,
                new RegExp(`^${OfflinePlugin.MANY2X_TABLE_PREFIX}`),
            ]);
            this._visited.set({});
        });

        Promise.all([
            this._updateScheduledORMList(),
            this._updateScheduledHTTPList(),
            this._loadIdRemap(),
        ]).then(
            async () => {
                if (!this.isOffline()) {
                    // wait a bit for the webclient to be started before synchronizing
                    await new Promise((r) => browser.setTimeout(r, 3000));
                    this._syncAll();
                }
            }
        );

        onWillDestroy(() => this._cleanup());
    }

    /**
     * Sets the offline status.
     *
     * If we're going offline, we must get the information about actions, views, records that
     * are available offline before toggling the status, such that the rest of the UI can
     * synchronously access the information when rendering offline. As reading from indexeddb
     * is async, we read everything once, and store it in an plain object. We also ensure that
     * buttons and inputs in the UI that haven't been tagged as "available-offline" are
     * disabled while being offline. Finally, we repeatedly try to ping the server to detect if
     * connection is back.
     *
     * If we're going online, we re-enable the UI and update the offline status.
     *
     * @param {boolean} offline
     */
    setOffline(offline) {
        if (offline === this.isOffline()) {
            return;
        }
        this.isOffline.set(offline);
        this._visited.set({});
        if (offline) {
            // Disable everything in the UI that isn't marked as available offline.
            this._offlineUI();
            // Create an observer instance linked to the callback function to keep disabling
            // elements that would appear in the DOM while being offline.
            this._observer = new MutationObserver(() => {
                if (this.isOffline()) {
                    this._offlineUI();
                }
            });
            this._observer.observe(document.body, {
                childList: true, // listen for direct children being added/removed
                subtree: true, // also observe descendants (not just direct children)
                attributeFilter: ["data-available-offline"], // listen for specific attribute change
            });

            // Repeatedly check if connection is back.
            let delay = 2000;
            const _checkConnection = async () => {
                if (this.isOffline()) {
                    await this.checkConnection();
                    // exponential backoff, with some jitter
                    delay = delay * 1.5 + 500 * Math.random();
                    this._timeout = browser.setTimeout(_checkConnection, delay);
                }
            };
            this._timeout = browser.setTimeout(_checkConnection, delay);

            // Retrieve the information about visited items from indexeddb.
            this._visited()[IS_READY] = this._populateVisited();
        } else {
            this._syncAll();
            this._cleanup();
        }
    }

    /**
     * Pings the server to check if it is reachable.
     */
    async checkConnection() {
        try {
            await rpc("/web/webclient/version_info", {});
        } catch {
            // just catch the error, the offline status will be updated with RPC:RESPONSE
        }
    }

    // Expose the promise to allow tests to wait for it
    getVisitedStatus() {
        return this._visited()[IS_READY];
    }
    /**
     * Returns search queries that are available offline, their facets and the number of times they
     * have been accessed, given an action id and a view type.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"}
     * @returns Promise<Object[]>
     */
    async getAvailableSearches(actionId, viewType) {
        await this._visited()[IS_READY];
        if (!this._visited()[actionId]?.views[viewType]) {
            return [];
        } else if (this._visited()[actionId]?.views[viewType] === true) {
            // Searches for that action/view type haven't been retrieve from idb yet
            this._visited()[actionId].views[viewType] = this._idb
                .read(this._visitedUITable(), this._generateKey(actionId, viewType))
                .then((r) =>
                    Object.values(r || {})
                        .reverse() // last visited first
                        .sort(({ count: c1 }, { count: c2 }) => c2 - c1)
                        .map(({ search }) => search)
                );
        }
        const searches = await this._visited()[actionId]?.views[viewType];
        return [...searches];
    }

    /**
     * Returns a boolean indicating whether the requested element is available offline, i.e.
     * if it has been visited online and stored in cache.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"} [viewType]
     * @param {number} [resId]
     * @returns boolean
     */
    isAvailableOffline(actionId, viewType, resId) {
        const action = this._visited()[actionId];
        if (!viewType) {
            return !!action;
        }
        const view = action?.views[viewType];
        if (viewType !== "form") {
            return !!view;
        }
        return view?.includes(resId);
    }

    /**
     * Mark an action, view type and optionally record as available offline.
     *
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"|"kanban_quick_create"|"list_quick_create"} viewType
     * @param {Object} params
     * @param {number} [params.resId] the record id, when viewType is "form"
     * @param {Object} [params.search] the current search view state
     */
    async setAvailableOffline(actionId, viewType, { resId, search }) {
        if (!this.isOffline()) {
            const key = this._generateKey(actionId, viewType, resId);
            let value;
            if (["form", "kanban_quick_create", "list_quick_create"].includes(viewType)) {
                value = true;
            } else {
                value = (await this._idb.read(this._visitedUITable(), key)) || {};
                let count = value[search.key]?.count || 0;
                search = value[search.key]?.search || search; // keep original search (no "Custom Filter")
                search = cloneForIndexedDB(search);
                delete value[search.key]; // delete and re-add to mark it as "last visited"
                value[search.key] = { count: ++count, search };
            }
            return this._idb.write(this._visitedUITable(), key, value);
        }
    }

    // -------------------------------------------------------------------------
    // ORM Offline
    // -------------------------------------------------------------------------

    /**
     * Schedule an ORM call for later sync.
     *
     * @param {string} model
     * @param {string} method
     * @param {any[]} args
     * @param {Object} kwargs
     * @param {Object} [options]
     * @param {string} [options.id] stable queue key (reuse to coalesce)
     * @param {string|string[]} [options.dependsOn] queue key(s) that must sync first; ids are remapped after
     * @param {Object} [options.extras] UI metadata (timeStamp, displayName, error, ...)
     * @param {Function} [options.rewrite] optional (value, idRemap) => value before replay
     */
    scheduleORM(model, method, args, kwargs, options = {}) {
        if (!window.isSecureContext) {
            throw new NonSecureContextError(
                _t("Offline features not available in a non-secure context")
            );
        }
        // Keep the caller's extras object when there is no dependency. The
        // queue key is a hash of that object, and a new timeStamp changes it.
        // An omitted extras must still be an object: JSON.stringify drops
        // undefined, and sync reads extras.error / extras.timeStamp.
        let extras = options.extras ?? {};
        if (options.dependsOn) {
            extras = { ...extras, dependsOn: options.dependsOn };
        }
        const value = { model, method, args, kwargs, extras };
        const key = options.id ?? hashCode(JSON.stringify(value));
        this._ormToSync()[key] = { key, value };
        this._idb.write(OfflinePlugin.ORM_SYNC_TABLE_NAME, key, JSON.stringify(value));
        return key;
    }

    removeScheduledORM(key) {
        delete this._ormToSync()[key];
        this._idb.delete(OfflinePlugin.ORM_SYNC_TABLE_NAME, key);
    }

    /**
     * Clear a sync error and retry on next sync pass.
     * @param {string} key
     */
    retryScheduledORM(key) {
        const entry = this._ormToSync()[key];
        if (!entry) {
            return;
        }
        const extras = { ...entry.value.extras };
        delete extras.error;
        this.scheduleORM(entry.value.model, entry.value.method, entry.value.args, entry.value.kwargs, {
            id: key,
            extras,
            dependsOn: extras.dependsOn,
        });
    }

    // -------------------------------------------------------------------------
    // HTTP Offline
    // -------------------------------------------------------------------------

    /**
     * Schedule an HTTP JSON-RPC call for later sync.
     *
     * @param {string} route
     * @param {Object} params
     * @param {Object} [options]
     * @param {string} [options.id]
     * @param {string|string[]} [options.dependsOn]
     * @param {string[]} [options.blobKeys] keys in the blob store to upload first
     * @param {Object} [options.extras]
     */
    scheduleHTTP(route, params, options = {}) {
        if (!window.isSecureContext) {
            throw new NonSecureContextError(
                _t("Offline features not available in a non-secure context")
            );
        }
        const extras = { timeStamp: Date.now(), ...options.extras };
        if (options.dependsOn) {
            extras.dependsOn = options.dependsOn;
        }
        if (options.blobKeys?.length) {
            extras.blobKeys = options.blobKeys;
        }
        const value = { route, params, extras };
        const key = options.id ?? hashCode(JSON.stringify({ route, params, extras: { timeStamp: extras.timeStamp } }));
        this._httpToSync()[key] = { key, value };
        this._idb.write(OfflinePlugin.HTTP_SYNC_TABLE_NAME, key, JSON.stringify(value));
        return key;
    }

    removeScheduledHTTP(key) {
        delete this._httpToSync()[key];
        this._idb.delete(OfflinePlugin.HTTP_SYNC_TABLE_NAME, key);
    }

    retryScheduledHTTP(key) {
        const entry = this._httpToSync()[key];
        if (!entry) {
            return;
        }
        const extras = { ...entry.value.extras };
        delete extras.error;
        this.scheduleHTTP(entry.value.route, entry.value.params, {
            id: key,
            extras,
            dependsOn: extras.dependsOn,
            blobKeys: extras.blobKeys,
        });
    }

    // -------------------------------------------------------------------------
    // Blob store (attachments / binary)
    // -------------------------------------------------------------------------

    /**
     * Store a binary blob for later upload. Value must be JSON-serializable
     * (e.g. { name, type, base64 } or ArrayBuffer-compatible structure).
     *
     * @param {string} key
     * @param {Object} blobData
     */
    async storeBlob(key, blobData) {
        if (!window.isSecureContext) {
            throw new NonSecureContextError(
                _t("Offline features not available in a non-secure context")
            );
        }
        await this._idb.write(OfflinePlugin.BLOB_TABLE_NAME, key, blobData);
        return key;
    }

    async getBlob(key) {
        return this._idb.read(OfflinePlugin.BLOB_TABLE_NAME, key);
    }

    async removeBlob(key) {
        return this._idb.delete(OfflinePlugin.BLOB_TABLE_NAME, key);
    }

    /**
     * Allocate a temporary id for offline-created relational records.
     * @returns {string}
     */
    nextTempId() {
        return `${OfflinePlugin.TEMP_ID_PREFIX}${hashCode(String(Date.now() + Math.random()))}`;
    }

    /**
     * Resolve a possibly-temporary id through the remap table.
     * @param {number|string|false} id
     */
    resolveId(id) {
        if (id === false || id === undefined || id === null) {
            return id;
        }
        return this._idRemap()[id] ?? id;
    }

    /**
     * Remember a temporary id (or queue key) -> server id, including across reloads.
     * @param {string|number} fromId
     * @param {number|string} realId
     */
    _rememberId(fromId, realId) {
        if (fromId === undefined || fromId === null || fromId === false || realId == null) {
            return;
        }
        if (fromId === realId) {
            return;
        }
        this._idRemap()[fromId] = realId;
        return this._idb.write(OfflinePlugin.ID_REMAP_TABLE_NAME, String(fromId), realId);
    }

    async _loadIdRemap() {
        const table = (await this._idb.getAllEntries(OfflinePlugin.ID_REMAP_TABLE_NAME)) || [];
        const map = this._idRemap();
        for (const { key, value } of table) {
            map[key] = value;
        }
    }

    get hasScheduledCalls() {
        return (
            !!Object.keys(this._ormToSync()).length || !!Object.keys(this._httpToSync()).length
        );
    }

    // -------------------------------------------------------------------------
    // Many2X Offline
    // -------------------------------------------------------------------------

    async cacheMany2XSearch(resModel, result) {
        if (!this._crypto) {
            return;
        }
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const values = await this._encryptAndFormat(result);
        this._idb.write(tableName, values);
    }

    async searchMany2XRecords(resModel, name) {
        if (!this._crypto) {
            return;
        }

        const normalizeSearch = normalize(name);
        const _searchFn = !normalizeSearch
            ? () => true
            : async (value) => {
                  const decryptedValue = normalize(await this._crypto.decrypt(value));
                  return decryptedValue.includes(normalizeSearch);
              };
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const res = await this._idb.search(tableName, _searchFn);
        return this._decryptAndFormat(res);
    }

    async readMany2XRecords(resModel, resIds) {
        if (!this._crypto) {
            return;
        }
        const tableName = OfflinePlugin.MANY2X_TABLE_PREFIX + resModel;
        const res = await this._idb.read(tableName, resIds);
        return this._decryptAndFormat(res);
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    /**
     * @private
     */
    _cleanup() {
        this._onlineUI();
        this._observer?.disconnect();
        browser.clearTimeout(this._timeout);
    }

    async _decryptAndFormat(offlineRes) {
        const decrytedRes = [];
        for (const r of offlineRes) {
            const value = r.value ? await this._crypto.decrypt(r.value) : undefined;
            decrytedRes.push({ id: Number(r.key), display_name: value });
        }
        return decrytedRes;
    }

    async _encryptAndFormat(ormResult) {
        const encryptedRes = [];
        for (const r of ormResult) {
            const value = await this._crypto.encrypt(
                typeof r.display_name === "string" ? r.display_name.split("\n")[0] : r.display_name
            );

            encryptedRes.push({ key: r.id, value });
        }
        return encryptedRes;
    }

    /**
     * Generates the key to identify an action, a viewType and optionally a record
     * id, to use as key in the indexeddb table.
     *
     * @private
     * @param {number} actionId
     * @param {"kanban"|"list"|"form"} viewType
     * @param {number} [params.resId] the record id, when viewType is "form"
     * @returns string
     */
    _generateKey(actionId, viewType, resId) {
        return JSON.stringify({ action: actionId, viewType, resId });
    }

    /**
     * Populates the `_visited` structure with the information read from indexeddb.
     *
     * @private
     */
    async _populateVisited() {
        return this._idb.getAllKeys(this._visitedUITable()).then((keys) => {
            if (!this.isOffline()) {
                return; // status changed again meanwhile
            }
            for (const key of keys) {
                const { action, viewType, resId } = JSON.parse(key);
                this._visited()[action] = this._visited()[action] || { views: {} };
                if (viewType === "form") {
                    this._visited()[action].views.form = this._visited()[action].views.form || [];
                    this._visited()[action].views.form.push(resId);
                } else {
                    this._visited()[action].views[viewType] = true;
                }
            }
        });
    }

    /**
     * Disables interactive elements (e.g. buttons) that haven't been tagged as "available-offline".
     *
     * @private
     */
    _offlineUI() {
        // Re-enable elements that have been marked as available offline
        document.querySelectorAll(".o_disabled_offline[data-available-offline]").forEach((el) => {
            el.removeAttribute("disabled");
            el.classList.remove("o_disabled_offline");
        });
        document.querySelectorAll(OfflinePlugin.SELECTORS_TO_DISABLE.join(", ")).forEach((el) => {
            el.setAttribute("disabled", "");
            el.classList.add("o_disabled_offline");
        });
    }

    /**
     * Re-enables elements that have previously been disabled by @_offlineUI.
     *
     * @private
     */
    _onlineUI() {
        document.querySelectorAll(".o_disabled_offline").forEach((el) => {
            el.removeAttribute("disabled");
            el.classList.remove("o_disabled_offline");
        });
    }

    // -------------------------------------------------------------------------
    // ORM / HTTP Sync
    // -------------------------------------------------------------------------

    async _syncAll() {
        if (!window.isSecureContext) {
            return;
        }
        await navigator.locks.request("db-sync", async () => {
            this.syncingORM.set(true);
            await this._updateScheduledORMList();
            await this._updateScheduledHTTPList();
            await this._loadIdRemap();
            try {
                await this._syncORMEntries();
                await this._syncHTTPEntries();
            } finally {
                this.syncingORM.set(false);
            }
        });
    }

    /** @deprecated use _syncAll */
    async _syncORM() {
        return this._syncAll();
    }

    /**
     * Deep-replace temporary ids in a structure using _idRemap.
     * @param {any} data
     */
    _remapIds(data) {
        const remap = this._idRemap();
        const walk = (v) => {
            if (Array.isArray(v)) {
                return v.map(walk);
            }
            if (v && typeof v === "object") {
                const out = {};
                for (const [k, val] of Object.entries(v)) {
                    out[k] = walk(val);
                }
                return out;
            }
            if (typeof v === "string" && v in remap) {
                return remap[v];
            }
            return v;
        };
        return walk(data);
    }

    _dependencyKeys(dependsOn) {
        if (!dependsOn) {
            return [];
        }
        return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
    }

    _sortedReadyEntries(entries) {
        const remap = this._idRemap();
        const ormQueue = this._ormToSync();
        return Object.values(entries)
            .filter(({ value }) => {
                const extras = value.extras || {};
                if (extras.error) {
                    return false;
                }
                for (const dep of this._dependencyKeys(extras.dependsOn)) {
                    // Still queued and not yet turned into a server id.
                    if (!(dep in remap) && ormQueue[dep]) {
                        return false;
                    }
                }
                return true;
            })
            .sort(
                (s1, s2) => (s1.value.extras?.timeStamp || 0) - (s2.value.extras?.timeStamp || 0)
            );
    }

    async _syncORMEntries() {
        let index = 0;
        // Loop until no more ready entries (handles dependency chains)
        for (;;) {
            const ready = this._sortedReadyEntries(this._ormToSync());
            if (!ready.length) {
                break;
            }
            let progressed = false;
            for (const { key, value } of ready) {
                if (index !== 0) {
                    await new Promise((r) => browser.setTimeout(r, 1000));
                }
                index++;
                try {
                    const args = this._remapIds(value.args);
                    const kwargs = this._remapIds(value.kwargs || {});
                    const result = await this.orm.silent.call(
                        value.model,
                        value.method,
                        args,
                        kwargs
                    );
                    // Map create / web_save([]) results to the queue key for dependents
                    if (
                        value.method === "web_save" &&
                        Array.isArray(value.args[0]) &&
                        value.args[0].length === 0
                    ) {
                        const newId = Array.isArray(result)
                            ? result[0]?.id ?? result[0]
                            : result?.id ?? result;
                        if (newId) {
                            await this._rememberId(key, newId);
                            if (value.extras.tempId) {
                                await this._rememberId(value.extras.tempId, newId);
                            }
                        }
                    }
                    if (value.method === "name_create" && Array.isArray(result)) {
                        await this._rememberId(key, result[0]);
                        if (value.extras.tempId) {
                            await this._rememberId(value.extras.tempId, result[0]);
                        }
                    }
                    if (value.method === "copy" && result) {
                        const newId = Array.isArray(result) ? result[0] : result;
                        await this._rememberId(key, newId);
                    }
                    this.removeScheduledORM(key);
                    progressed = true;
                    // Notify listeners that offline sync progressed (views can reload)
                    rpcBus.trigger("OFFLINE-SYNC", {
                        model: value.model,
                        method: value.method,
                        result,
                        key,
                    });
                } catch (e) {
                    if (e instanceof ConnectionLostError) {
                        return;
                    }
                    let error = e.message || _t("Error");
                    if (e.data) {
                        error = e.data.name + " - " + e.data.message;
                    }
                    this.scheduleORM(value.model, value.method, value.args, value.kwargs, {
                        id: key,
                        extras: { ...value.extras, error },
                    });
                }
            }
            if (!progressed) {
                break;
            }
        }
    }

    async _syncHTTPEntries() {
        let index = 0;
        for (;;) {
            const ready = this._sortedReadyEntries(this._httpToSync());
            if (!ready.length) {
                break;
            }
            let progressed = false;
            for (const { key, value } of ready) {
                if (index !== 0) {
                    await new Promise((r) => browser.setTimeout(r, 1000));
                }
                index++;
                try {
                    // Upload pending blobs first (e.g. attachment uploads handled by caller params)
                    if (value.extras.blobKeys?.length) {
                        for (const blobKey of value.extras.blobKeys) {
                            // Blobs are consumed by route-specific params already serialized;
                            // cleanup after successful call.
                            await this.getBlob(blobKey);
                        }
                    }
                    const params = this._remapIds(value.params);
                    const result = await rpc(value.route, params, { silent: true });
                    if (value.extras.blobKeys?.length) {
                        for (const blobKey of value.extras.blobKeys) {
                            await this.removeBlob(blobKey);
                        }
                    }
                    this.removeScheduledHTTP(key);
                    progressed = true;
                    // Same signal as ORM sync. Chatter reloads posted notes from it;
                    // the form id was already adopted when the parent web_save synced.
                    rpcBus.trigger("OFFLINE-SYNC", {
                        route: value.route,
                        params,
                        result,
                        key,
                    });
                } catch (e) {
                    if (e instanceof ConnectionLostError) {
                        return;
                    }
                    let error = e.message || _t("Error");
                    if (e.data) {
                        error = e.data.name + " - " + e.data.message;
                    }
                    this.scheduleHTTP(value.route, value.params, {
                        id: key,
                        extras: { ...value.extras, error },
                        blobKeys: value.extras.blobKeys,
                    });
                }
            }
            if (!progressed) {
                break;
            }
        }
    }

    _parseSyncValue(raw) {
        const value = JSON.parse(raw);
        // Rows queued before extras was always stored have no extras key.
        value.extras ??= {};
        return value;
    }

    async _updateScheduledORMList() {
        const table = await this._idb.getAllEntries(OfflinePlugin.ORM_SYNC_TABLE_NAME);
        this._ormToSync.set(
            Object.fromEntries(
                table.map((v) => [v.key, { key: v.key, value: this._parseSyncValue(v.value) }])
            )
        );
    }

    async _updateScheduledHTTPList() {
        const table = await this._idb.getAllEntries(OfflinePlugin.HTTP_SYNC_TABLE_NAME);
        this._httpToSync.set(
            Object.fromEntries(
                table.map((v) => [v.key, { key: v.key, value: this._parseSyncValue(v.value) }])
            )
        );
    }
}

/** @param {unknown} id */
export function isOfflineTempId(id) {
    return typeof id === "string" && id.startsWith(OfflinePlugin.TEMP_ID_PREFIX);
}

/**
 * Collect temporary ids embedded in an offline write payload.
 * @param {unknown} value
 * @param {Set<string>} [acc]
 * @returns {Set<string>}
 */
export function collectOfflineTempIds(value, acc = new Set()) {
    if (typeof value === "string") {
        if (isOfflineTempId(value)) {
            acc.add(value);
        }
        return acc;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectOfflineTempIds(item, acc);
        }
        return acc;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) {
            collectOfflineTempIds(item, acc);
        }
    }
    return acc;
}

services.add(OfflinePlugin);

/**
 * -----------------------------------------------------------------------------
 * @todo owl3 migration
 * temporary - to remove when all use of the offline service are removed
 * -----------------------------------------------------------------------------
 *
 * Bridges the legacy `useService("offline")` API to the OfflinePlugin. New code
 * should use `usePlugin(OfflinePlugin)` directly and read the `isOffline()` signal.
 */
export const offlineService = {
    start() {
        const offlinePlugin = usePlugin(OfflinePlugin);
        const offlineService = Object.create(offlinePlugin);
        Object.defineProperty(offlineService, "offline", {
            get() {
                return offlinePlugin.isOffline();
            },
            set(offline) {
                offlinePlugin.setOffline(offline);
            },
        });
        Object.defineProperty(offlineService, "syncingORM", {
            get() {
                return offlinePlugin.syncingORM();
            },
        });
        Object.defineProperty(offlineService, "scheduledORM", {
            get() {
                return offlinePlugin._ormToSync();
            },
        });
        return offlineService;
    },
};

registry.category("services").add("offline", offlineService);
