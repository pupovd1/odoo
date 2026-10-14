import { Component, proxy, t, useProps } from "@odoo/owl";
import { InvalidNumberError, parseFloat } from "@web/views/fields/parsers";

/**
 * The small-screen quick create, shown in a bottom sheet: exactly the lead's
 * name, contact name, phone, email, expected revenue and stage. Each field
 * carries the framework's offline-availability attribute: the lead is created
 * or, offline, queued by the pipeline (`onAdd`), with these values only.
 */
export class CrmMobileQuickCreate extends Component {
    static template = "crm.MobileQuickCreate";
    props = useProps({
        stages: t.array(),
        stageId: t.any().optional(),
        onAdd: t.function(),
        close: t.function(),
    });

    setup() {
        this.state = proxy({
            name: "",
            contact_name: "",
            phone: "",
            email_from: "",
            expected_revenue: "",
            stage_id: this.props.stageId || this.props.stages[0]?.id || false,
            adding: false,
        });
    }

    /**
     * The expected revenue typed, read in the user's number format (as the
     * lead form reads it); null when it isn't a number.
     */
    get expectedRevenue() {
        const text = this.state.expected_revenue.trim();
        if (!text) {
            return 0;
        }
        try {
            return parseFloat(text);
        } catch (error) {
            if (error instanceof InvalidNumberError) {
                return null;
            }
            throw error;
        }
    }

    get isRevenueValid() {
        return this.expectedRevenue !== null;
    }

    get canAdd() {
        return !this.state.adding && Boolean(this.state.name.trim()) && this.isRevenueValid;
    }

    /** The values of the new lead, as the server's create takes them. */
    get values() {
        return {
            name: this.state.name.trim(),
            contact_name: this.state.contact_name.trim() || false,
            phone: this.state.phone.trim() || false,
            email_from: this.state.email_from.trim() || false,
            expected_revenue: this.expectedRevenue,
            stage_id: this.state.stage_id,
        };
    }

    onInput(fieldName, ev) {
        this.state[fieldName] = ev.target.value;
    }

    onStageChange(ev) {
        this.state.stage_id = Number(ev.target.value);
    }

    /**
     * Adds the lead, then closes the sheet. When the server refuses the lead (a
     * lost connection queues it instead), the sheet stays open with the values
     * typed, to correct them and add again.
     */
    async add() {
        if (!this.canAdd) {
            return;
        }
        this.state.adding = true;
        try {
            await this.props.onAdd(this.values);
        } catch (error) {
            this.state.adding = false;
            throw error;
        }
        this.props.close();
    }
}
