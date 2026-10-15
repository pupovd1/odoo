import { usePlugin } from "@odoo/owl";
import { ConnectionLostError, rpc } from "@web/core/network/rpc";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { user } from "@web/core/user";
import { ensureArray } from "@web/core/utils/arrays";

/**
 * Offline predicates shared by the CRM components, read from the framework's
 * OfflinePlugin: its `isOffline` signal and its queue of calls to replay. CRM
 * components call `useCrmOffline()` in `setup` instead of resolving the plugin
 * themselves. Every predicate reads signals, so a template that calls one
 * re-renders when connectivity or the queue changes.
 */

/**
 * The calls waiting in the framework's queue, oldest first.
 * The plugin has no public getter for its queue: it is read the way the
 * framework's own offline systray reads it.
 *
 * @param {OfflinePlugin} offlinePlugin
 * @returns {{ key: string, model: string, method: string, args: any[], kwargs: Object, extras: Object }[]}
 */
export function getQueuedCalls(offlinePlugin) {
    return Object.values(offlinePlugin._ormToSync())
        .map(({ key, value }) => ({ key, ...value }))
        .sort((a, b) => (a.extras?.timeStamp || 0) - (b.extras?.timeStamp || 0));
}

/**
 * Ids of the records a queued call writes, when its first argument is a list of
 * ids (web_save, unlink, action_* methods). Creates have none.
 *
 * @param {{ args: any[] }} call
 * @returns {number[]}
 */
export function getQueuedResIds(call) {
    const ids = call.args?.[0];
    return Array.isArray(ids) && ids.every((id) => Number.isInteger(id)) ? ids : [];
}

/**
 * Whether a queued call creates a record of its model: `create`, or `web_save`
 * without ids.
 *
 * @param {{ method: string, args: any[] }} call
 */
export function isQueuedCreate(call) {
    return call.method === "create" || (call.method === "web_save" && !call.args?.[0]?.length);
}

/**
 * Ids of the records of this model a queued call writes, in one pass over the
 * queue (no copy, no sort).
 *
 * @param {OfflinePlugin} offlinePlugin
 * @param {string} model
 * @returns {Set<number>}
 */
export function getPendingResIds(offlinePlugin, model) {
    const resIds = new Set();
    for (const { value } of Object.values(offlinePlugin._ormToSync())) {
        if (value.model === model) {
            for (const resId of getQueuedResIds(value)) {
                resIds.add(resId);
            }
        }
    }
    return resIds;
}

/**
 * Calls the model method web's `user` calls for a group or access-right probe,
 * without its cache.
 */
function callUserProbe(model, method, args) {
    return rpc(`/web/dataset/call_kw/${model}/${method}`, {
        model,
        method,
        args,
        kwargs: { context: user.context },
    });
}

export function useCrmOffline() {
    const offlinePlugin = usePlugin(OfflinePlugin);
    const crmOffline = {
        /** @returns {boolean} */
        isOffline: () => offlinePlugin.isOffline(),
        /** @returns {boolean} whether the queue is being replayed */
        isSyncing: () => offlinePlugin.syncingORM(),
        /**
         * @param {string} [model] only the calls on this model
         */
        queuedCalls: (model) =>
            getQueuedCalls(offlinePlugin).filter((call) => !model || call.model === model),
        /**
         * Whether a call writing this record waits in the queue.
         *
         * @param {string} model
         * @param {number} resId
         */
        isPendingSync: (model, resId) => !!resId && getPendingResIds(offlinePlugin, model).has(resId),
        /**
         * Ids of the records of this model a queued call writes.
         *
         * @param {string} model
         * @returns {Set<number>}
         */
        pendingResIds: (model) => getPendingResIds(offlinePlugin, model),
        /**
         * The queued calls creating a record of this model.
         *
         * @param {string} model
         */
        pendingCreates: (model) => crmOffline.queuedCalls(model).filter(isQueuedCreate),
        /**
         * Queue a call in the framework's queue, with the extras its systray and
         * replay need (timeStamp orders the replay).
         *
         * @param {string} model
         * @param {string} method
         * @param {any[]} args
         * @param {Object} kwargs
         * @param {Object} extras actionId, actionName, viewType, displayName...
         * @returns {string} the key of the queued call
         */
        scheduleCall: (model, method, args, kwargs, extras) =>
            offlinePlugin.scheduleORM(model, method, args, kwargs, {
                extras: { timeStamp: Date.now(), ...extras },
            }),
        /**
         * @param {number} actionId
         * @param {string} [viewType]
         * @param {number|false} [resId]
         */
        isAvailableOffline: (actionId, viewType, resId) =>
            offlinePlugin.isAvailableOffline(actionId, viewType, resId),
        /**
         * `user.hasGroup`, for a probe that can be lost with the connection: web's
         * user cache keeps a lost probe's rejection for the rest of the session,
         * so once the connection is back the server is asked again, without that
         * cache. Rejects with the ConnectionLostError while the connection is lost.
         *
         * @param {string} group
         * @returns {Promise<boolean>}
         */
        hasGroup: (group) =>
            probeOnline(
                () => user.hasGroup(group),
                () => callUserProbe("res.users", "has_group", [user.userId, group])
            ),
        /**
         * `user.checkAccessRight`, for a probe that can be lost with the
         * connection (see hasGroup).
         *
         * @param {string} model
         * @param {string} operation
         * @param {number|number[]} [ids]
         * @returns {Promise<boolean>}
         */
        checkAccessRight: (model, operation, ids = []) =>
            probeOnline(
                () => user.checkAccessRight(model, operation, ids),
                () => callUserProbe(model, "has_access", [ensureArray(ids), operation])
            ),
    };
    async function probeOnline(cachedProbe, uncachedProbe) {
        try {
            return await cachedProbe();
        } catch (error) {
            if (!(error instanceof ConnectionLostError) || offlinePlugin.isOffline()) {
                throw error;
            }
            return uncachedProbe();
        }
    }
    return crmOffline;
}
