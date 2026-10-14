import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { defineModels, fields, mountView } from "@web/../tests/web_test_helpers";
import {
    CrmLead,
    CrmStage,
    CrmTag,
    CrmTeam,
    mockCrmOffline,
} from "@crm/../tests/mock_server/crm_offline_test_helpers";

/** Leads with the activity fields mail's kanban_activity widget reads. */
class ActivityCrmLead extends CrmLead {
    activity_ids = fields.One2many({ relation: "mail.activity", relation_field: "res_id" });
    activity_exception_decoration = fields.Selection({
        selection: [
            ["warning", "Alert"],
            ["danger", "Error"],
        ],
    });
    activity_exception_icon = fields.Char();
    activity_summary = fields.Char();
    activity_type_icon = fields.Char();
    activity_type_id = fields.Many2one({ relation: "mail.activity.type" });
}

defineModels([CrmStage, CrmTeam, CrmTag, ActivityCrmLead]);
defineMailModels();

test("[Offline] a lead card's activity button (its popover: schedule, mark done, edit...) is disabled offline, enabled online", async () => {
    const setOffline = mockCrmOffline();
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: `
            <kanban js_class="crm_kanban">
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                        <field name="activity_ids" widget="kanban_activity"/>
                    </t>
                </templates>
            </kanban>`,
    });
    const button = ".o_kanban_record:first .o-mail-ActivityButton";
    expect(button).toBeEnabled();
    await setOffline(true);
    expect(button).not.toBeEnabled();
    expect(button).toHaveClass("o_disabled_offline");
    await setOffline(false);
    expect(button).toBeEnabled();
});
