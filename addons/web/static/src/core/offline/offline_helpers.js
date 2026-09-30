import { ConnectionLostError, rpc } from "@web/core/network/rpc";

/**
 * Call an ORM method, or schedule it for offline sync on ConnectionLostError.
 *
 * @param {import("./offline_plugin").OfflinePlugin} offlinePlugin
 * @param {import("@web/core/orm_plugin").ORM} orm
 * @param {string} model
 * @param {string} method
 * @param {any[]} args
 * @param {Object} [kwargs={}]
 * @param {Object} [scheduleOptions={}] options forwarded to scheduleORM
 * @returns {Promise<any|null>} server result, or null if scheduled offline
 */
export async function callOrScheduleORM(
    offlinePlugin,
    orm,
    model,
    method,
    args,
    kwargs = {},
    scheduleOptions = {}
) {
    try {
        return await orm.call(model, method, args, kwargs);
    } catch (e) {
        if (e instanceof ConnectionLostError) {
            offlinePlugin.scheduleORM(model, method, args, kwargs, {
                ...scheduleOptions,
                extras: {
                    timeStamp: Date.now(),
                    ...scheduleOptions.extras,
                },
            });
            return null;
        }
        throw e;
    }
}

/**
 * Call an HTTP JSON-RPC route, or schedule it for offline sync on ConnectionLostError.
 *
 * @param {import("./offline_plugin").OfflinePlugin} offlinePlugin
 * @param {string} route
 * @param {Object} params
 * @param {Object} [scheduleOptions={}]
 * @returns {Promise<any|null>}
 */
export async function callOrScheduleHTTP(offlinePlugin, route, params, scheduleOptions = {}) {
    try {
        return await rpc(route, params);
    } catch (e) {
        if (e instanceof ConnectionLostError) {
            offlinePlugin.scheduleHTTP(route, params, {
                ...scheduleOptions,
                extras: {
                    timeStamp: Date.now(),
                    ...scheduleOptions.extras,
                },
            });
            return null;
        }
        throw e;
    }
}
