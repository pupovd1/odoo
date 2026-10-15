import { Component, t, useProps } from "@odoo/owl";
import { formatMonetary } from "@web/views/fields/formatters";

/**
 * An amount of the pipeline (a lead's expected revenue, a stage's sum), in the
 * company currency when it is known; nothing for zero.
 *
 * @param {number} value
 * @param {number} [currencyId]
 */
export function formatRevenue(value, currencyId) {
    return value ? formatMonetary(value, { currencyId }) : "";
}

/**
 * A lead of the small-screen pipeline: name, contact, expected revenue, and
 * whether a change of the lead waits in the framework's offline queue. That is
 * read from the queue itself, not from a flag the card keeps: the pipeline
 * reads the queue once for all its cards (useCrmOffline().pendingResIds) and
 * gives each card its answer. The card is one touch target, at least 44 x 44
 * px, opening the lead. It is a record of the kanban (`o_kanban_record`, the
 * datapoint id), as the kanban's own cards.
 */
export class CrmMobileLeadCard extends Component {
    static template = "crm.MobileLeadCard";
    props = useProps({
        record: t.any(),
        openRecord: t.function(),
        isPendingSync: t.boolean().optional(),
    });

    get data() {
        return this.props.record.data;
    }

    get contactName() {
        return this.data.partner_id?.display_name || this.data.contact_name || "";
    }

    get revenue() {
        return formatRevenue(this.data.expected_revenue, this.data.company_currency?.id);
    }
}
