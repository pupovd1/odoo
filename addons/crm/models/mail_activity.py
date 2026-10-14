# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, models


class MailActivity(models.Model):
    _inherit = "mail.activity"

    @api.model_create_multi
    def create(self, vals_list):
        """ Activities scheduled on a lead offline are created by a call the client
        queued with values it resolved itself: it knows the lead's model name, not
        its ir.model id. The document's model is held by res_model_id (res_model is
        related to it), so resolve it here. """
        lead_model_id = False
        new_vals_list = []
        for vals in vals_list:
            if vals.get('res_model') == 'crm.lead' and not vals.get('res_model_id'):
                lead_model_id = lead_model_id or self.env['ir.model']._get_id('crm.lead')
                vals = {key: value for key, value in vals.items() if key != 'res_model'}
                vals['res_model_id'] = lead_model_id
            new_vals_list.append(vals)
        return super().create(new_vals_list)

    def action_create_calendar_event(self):
        """ Small override of the action that creates a calendar.

        If the activity is linked to a crm.lead through the "opportunity_id" field, we include in
        the action context the default values used when scheduling a meeting from the crm.lead form
        view.
        e.g: It will set the partner_id of the crm.lead as default attendee of the meeting. """

        action = super(MailActivity, self).action_create_calendar_event()
        opportunity = self.calendar_event_id.opportunity_id
        if opportunity:
            opportunity_action_context = opportunity.action_schedule_meeting(smart_calendar=False).get('context', {})
            opportunity_action_context['initial_date'] = self.calendar_event_id.start

            action['context'].update(opportunity_action_context)

        return action
