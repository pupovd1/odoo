import { Component, status, t, usePlugin, useProps } from "@odoo/owl";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { localization } from "@web/core/l10n/localization";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { registry } from "@web/core/registry";
import { usePopover } from "@web/core/popover/popover_hook";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

export class CrmPlsTooltip extends Component {
    static template = "crm.PlsTooltip";

    props = useProps({
        close: t.function().optional(),
        dashArrayVals: t.string(),
        low3Data: t.array().optional(),
        probability: t.number(),
        teamName: t.string().optional(),
        top3Data: t.array().optional(),
    });
}

export class CrmPlsTooltipButton extends Component {
    static template = "crm.PlsTooltipButton";

    props = useProps(standardWidgetProps);

    setup() {
        super.setup();
        this.orm = useService("orm");
        this.ui = useService("ui");
        this.notification = useService("notification");
        this.offlinePlugin = usePlugin(OfflinePlugin);
        this.popover = usePopover(CrmPlsTooltip, {
            popoverClass: "mt-2 me-2",
            position: "bottom-start",
            useBottomSheet: this.ui.isSmall,
        });
    }

    async onClickPlsTooltipButton(ev) {
        if (this.offlinePlugin.isOffline()) {
            this.notification.add(_t("Probability insights require a connection"), {
                type: "warning",
            });
            return;
        }
        const tooltipButtonEl = ev.currentTarget;
        if (this.popover.isOpen) {
            this.popover.close();
        } else {
            await this.props.record.save();
            if (status(this) === "destroyed" || !this.props.record.resId) {
                return;
            }

            const tooltipData = await this.orm.call(
                "crm.lead",
                "prepare_pls_tooltip_data",
                [this.props.record.resId]
            );
            await this.props.record.load();

            const progressWheelPerimeter = 2 * Math.PI * 25;
            const progressBarDashLength =
                (progressWheelPerimeter * tooltipData.probability) / 100.0;
            const progressBarDashGap = progressWheelPerimeter - progressBarDashLength;
            let dashArrayVals = progressBarDashLength + " " + progressBarDashGap;
            if (localization.direction === "rtl") {
                dashArrayVals =
                    0 + " " + 0.5 * progressWheelPerimeter + " " + dashArrayVals;
            }
            this.popover.open(tooltipButtonEl, {
                dashArrayVals: dashArrayVals,
                low3Data: tooltipData.low_3_data,
                probability: tooltipData.probability,
                teamName: tooltipData.team_name,
                top3Data: tooltipData.top_3_data,
            });
        }
    }
}

registry.category("view_widgets").add("pls_tooltip_button", {
    component: CrmPlsTooltipButton,
});
