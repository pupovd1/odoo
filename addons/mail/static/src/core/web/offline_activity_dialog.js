import { Component, proxy, t, usePlugin, useProps } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { useService } from "@web/core/utils/hooks";

/**
 * Lightweight activity scheduler for offline mode.
 * Queues activity_schedule on the parent record for later sync.
 */
export class OfflineActivityDialog extends Component {
    static template = "mail.OfflineActivityDialog";
    static components = { Dialog };

    props = useProps({
        close: t.function(),
        resModel: t.string(),
        resIds: t.array(t.number()),
        displayName: t.string().optional(),
        dependsOn: t.string().optional(),
    });

    setup() {
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.notification = useService("notification");
        this.state = proxy({
            summary: "",
            note: "",
            date_deadline: new Date().toISOString().slice(0, 10),
        });
    }

    onConfirm() {
        const extras = {
            timeStamp: Date.now(),
            displayName: this.props.displayName || _t("Activity"),
            actionName: _t("Activities"),
        };
        if (this.props.dependsOn) {
            extras.dependsOn = this.props.dependsOn;
        }
        this.offlinePlugin.scheduleORM(
            this.props.resModel,
            "activity_schedule",
            [this.props.resIds],
            {
                summary: this.state.summary || _t("Offline activity"),
                note: this.state.note || false,
                date_deadline: this.state.date_deadline,
            },
            { extras }
        );
        this.notification.add(_t("Activity queued for sync"), { type: "info" });
        this.props.close();
    }
}
