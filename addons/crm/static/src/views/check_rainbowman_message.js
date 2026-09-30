import { ConnectionLostError } from "@web/core/network/rpc";

/**
 * Soft-fail rainbowman when offline / connection lost.
 * Stage changes still sync via normal web_save / kanban move.
 */
export async function checkRainbowmanMessage(orm, effect, recordId) {
    try {
        const message = await orm.call("crm.lead", "get_rainbowman_message", [[recordId]]);
        if (message) {
            effect.add({
                message,
                type: "rainbow_man",
            });
        }
    } catch (e) {
        if (e instanceof ConnectionLostError) {
            return;
        }
        throw e;
    }
}
