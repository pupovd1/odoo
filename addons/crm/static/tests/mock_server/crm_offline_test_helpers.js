import { expect } from "@odoo/hoot";
import { getQueuedCalls } from "@crm/mobile/offline_hooks";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { fields, getService, mockOffline, models, onRpc } from "@web/../tests/web_test_helpers";

/**
 * Helpers and mock models for the CRM offline tests. This module lives under
 * mock_server/ so that the web.assets_unit_tests globs of the crm manifest
 * bundle it.
 */

/**
 * Switch the framework offline / online for the current test (`mockOffline`:
 * every server route answers 502 while offline), and record the given dataset
 * calls whenever they are attempted, online or offline, as
 * `expect.step("<model>/<method>")`.
 *
 * `mockOffline` registers its 502 listener first and route listeners run
 * newest first, so the recording listener below sees every attempt: a test can
 * prove which calls were (not) issued offline.
 *
 * @param {string[]} [recorded] "<model>/<method>" of the calls to record
 * @returns {(offline: boolean) => Promise<void>}
 */
export function mockCrmOffline(recorded = []) {
    const setOffline = mockOffline();
    onRpc("/*", (request) => {
        const route = new URL(request.url).pathname;
        const match = route.match(/^\/web\/dataset\/call_(?:kw|button)\/([^/]+)\/([^/]+)/);
        const call = match && `${match[1]}/${match[2]}`;
        if (call && recorded.includes(call)) {
            expect.step(call);
        }
    });
    return setOffline;
}

/** The calls waiting in the framework's queue, oldest first. */
export function queuedCalls() {
    return getQueuedCalls(getService(OfflinePlugin));
}

/** `model.method` of each queued call, oldest first. */
export function queuedMethods() {
    return queuedCalls().map((call) => `${call.model}.${call.method}`);
}

export class CrmStage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer();
    is_won = fields.Boolean();
    fold = fields.Boolean();
    team_ids = fields.Many2many({ relation: "crm.team" });

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Proposition", sequence: 2 },
        { id: 3, name: "Won", sequence: 3, is_won: true },
    ];
}

export class CrmTeam extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    sequence = fields.Integer();
    use_opportunities = fields.Boolean({ default: true });

    _records = [
        { id: 1, name: "Sales", sequence: 1 },
        { id: 2, name: "Pre-Sales", sequence: 2 },
    ];

    get_team_switcher_data() {
        const teams = this._filter([["use_opportunities", "=", true]]);
        return {
            available: teams.length > 1,
            teams: teams.map((team) => ({
                id: team.id,
                name: team.name,
                switcher_domain: ["|", ["team_id", "=", team.id], ["team_id", "=", false]],
            })),
        };
    }
}

export class CrmTag extends models.Model {
    _name = "crm.tag";

    name = fields.Char();
    color = fields.Integer();

    _records = [
        { id: 1, name: "Furniture", color: 1 },
        { id: 2, name: "Priority customer", color: 2 },
        { id: 3, name: "Renewal", color: 3 },
    ];
}

export class CrmLead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    type = fields.Selection({
        selection: [
            ["lead", "Lead"],
            ["opportunity", "Opportunity"],
        ],
        default: "opportunity",
    });
    stage_id = fields.Many2one({ relation: "crm.stage" });
    team_id = fields.Many2one({ relation: "crm.team" });
    user_id = fields.Many2one({ relation: "res.users" });
    partner_id = fields.Many2one({ relation: "res.partner" });
    tag_ids = fields.Many2many({ relation: "crm.tag" });
    contact_name = fields.Char();
    email_from = fields.Char();
    phone = fields.Char();
    // computed on the server: readonly, never part of a save
    partner_email_update = fields.Boolean({ readonly: true });
    partner_phone_update = fields.Boolean({ readonly: true });
    expected_revenue = fields.Float({ aggregator: "sum" });
    recurring_revenue_monthly = fields.Float({ aggregator: "sum" });
    probability = fields.Float();
    automated_probability = fields.Float();
    is_automated_probability = fields.Boolean();
    won_status = fields.Selection({
        selection: [
            ["pending", "In Progress"],
            ["won", "Won"],
            ["lost", "Lost"],
        ],
        default: "pending",
    });
    active = fields.Boolean({ default: true });
    priority = fields.Selection({
        selection: [
            ["0", "Low"],
            ["1", "Medium"],
            ["2", "High"],
            ["3", "Very High"],
        ],
        default: "0",
    });
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });
    color = fields.Integer();
    description = fields.Html();
    date_deadline = fields.Date();
    duration_tracking = fields.Json(); // read by the stage bar (mail's statusbar_duration)
    is_rotting = fields.Boolean();
    rotting_days = fields.Integer();

    _onChanges = {
        // as the server's computes: a partner's email and phone go to the lead, and the
        // sync flags tell whether the lead's still differ from the partner's
        partner_id: (record) => {
            const [partner] = record.partner_id ? this.env["res.partner"].browse(record.partner_id) : [];
            if (partner?.email) {
                record.email_from = partner.email;
            }
            if (partner?.phone) {
                record.phone = partner.phone;
            }
            record.partner_email_update = Boolean(partner && record.email_from && record.email_from !== partner.email);
            record.partner_phone_update = Boolean(partner && record.phone && record.phone !== partner.phone);
        },
    };

    _records = [
        {
            id: 1,
            name: "Office chairs",
            date_deadline: "2023-09-05",
            stage_id: 1,
            team_id: 1,
            expected_revenue: 1200,
            email_from: "chairs@example.com",
            phone: "+32 470 11 11 11",
            partner_email_update: true,
            partner_phone_update: true,
            activity_state: "planned",
            is_rotting: true,
            rotting_days: 12,
        },
        {
            id: 2,
            name: "Desks for the new office",
            date_deadline: "2023-09-20",
            stage_id: 1,
            team_id: 2,
            expected_revenue: 4800,
            activity_state: "today",
        },
        {
            id: 3,
            name: "Meeting room",
            date_deadline: "2023-10-10",
            stage_id: 2,
            team_id: 1,
            expected_revenue: 2500,
            recurring_revenue_monthly: 40,
            activity_state: "overdue",
        },
        {
            id: 4,
            name: "Reception desk",
            stage_id: 3,
            team_id: 1,
            expected_revenue: 900,
            won_status: "won",
            probability: 100,
        },
        {
            id: 5,
            name: "Lost bid",
            stage_id: 2,
            team_id: 1,
            expected_revenue: 700,
            active: false,
            won_status: "lost",
            probability: 0,
            automated_probability: 30,
        },
    ];
}

export const crmOfflineModels = [CrmStage, CrmTeam, CrmTag, CrmLead];
