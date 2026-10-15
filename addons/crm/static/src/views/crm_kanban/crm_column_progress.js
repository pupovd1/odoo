import { onWillStart, proxy, useOnChange } from "@odoo/owl";
import { ConnectionLostError } from "@web/core/network/rpc";
import { RottingColumnProgress } from "@mail/js/rotting_mixin/rotting_column_progress";
import { _t } from "@web/core/l10n/translation";
import { useCrmOffline } from "@crm/mobile/offline_hooks";

export class CrmColumnProgress extends RottingColumnProgress {
    static template = "crm.ColumnProgress";
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        this.recurringRevenueState = proxy({ allowed: false });

        onWillStart(() => this.loadRecurringRevenueGroup());
        // The group probe is skipped offline: run it once the connection is back.
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => !isOffline && this.loadRecurringRevenueGroup(),
            { initialRun: false }
        );
    }

    /**
     * Offline the recurring revenue aggregate is hidden, as its group probe isn't
     * issued: a zero would read as real data.
     */
    get showRecurringRevenue() {
        return !this.crmOffline.isOffline() && this.recurringRevenueState.allowed;
    }

    /**
     * A probe lost with the connection is issued again once it is back (see
     * useCrmOffline().hasGroup): the aggregate is never left hidden for a user
     * of the group.
     */
    async loadRecurringRevenueGroup() {
        if (
            this.crmOffline.isOffline() ||
            this.recurringRevenueGroupLoaded ||
            this.recurringRevenueGroupLoading ||
            !this.props.progressBarState.progressAttributes.recurring_revenue_sum_field
        ) {
            return;
        }
        this.recurringRevenueGroupLoading = true;
        try {
            this.recurringRevenueState.allowed = await this.crmOffline.hasGroup(
                "crm.group_use_recurring_revenues"
            );
            this.recurringRevenueGroupLoaded = true;
        } catch (error) {
            if (!(error instanceof ConnectionLostError)) {
                throw error;
            }
        } finally {
            this.recurringRevenueGroupLoading = false;
        }
    }

    getRecurringRevenueGroupAggregate(group) {
        if (!this.showRecurringRevenue) {
            return {};
        }
        const rrField = this.props.progressBarState.progressAttributes.recurring_revenue_sum_field;
        return this.props.progressBarState.getAggregateValue(group, rrField);
    }

    getColumnProgressTooltip(bar) {
        const barString = typeof bar.value === 'symbol' ? _t('Without activities scheduled') : bar.string;
        return `${bar.count} ${barString}`;
    }

    /**
     * The bar and rotting filters reload the column: unavailable offline.
     */
    async onBarClick() {
        if (!this.crmOffline.isOffline()) {
            return super.onBarClick(...arguments);
        }
    }

    async onRottingIconClick() {
        if (!this.crmOffline.isOffline()) {
            return super.onRottingIconClick(...arguments);
        }
    }
}
