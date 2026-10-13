# Part of Odoo. See LICENSE file for full copyright and licensing details.

from lxml import etree

from odoo.tests import Form, HttpCase, tagged

from odoo.addons.crm.tests.common import TestCrmCommon


@tagged('post_install', '-at_install')
class TestCrmOffline(HttpCase, TestCrmCommon):
    """ Server side of the CRM offline mode: what the framework's queue replays
    (a verbatim call through /web/dataset/call_kw) must leave the database in the
    same state as the online flow. """

    def _replay(self, model, method, args, kwargs=None):
        """ Replay a queued call the way the offline framework does
        (orm.silent.call -> /web/dataset/call_kw/<model>/<method>). """
        self.env.flush_all()
        result = self.make_jsonrpc_request(f'/web/dataset/call_kw/{model}/{method}', {
            'model': model,
            'method': method,
            'args': args,
            'kwargs': kwargs or {},
        })
        self.env.invalidate_all()
        return result

    def _lead_to_sync(self, name):
        """ An opportunity whose email and phone differ from its partner's: the
        crm form force-saves them so the inverse methods update the partner. """
        partner = self.env['res.partner'].create({'name': f'{name} Contact'})
        lead = self.env['crm.lead'].create({
            'name': name,
            'type': 'opportunity',
            'partner_id': partner.id,
            'email_from': f'{name.lower()}@example.com',
            'phone': '+32 494 44 44 44',
            'user_id': self.user_admin.id,
        })
        partner.write({'email': False, 'phone': False})
        self.assertTrue(lead.partner_email_update)
        self.assertTrue(lead.partner_phone_update)
        return lead, partner

    def test_offline_edit_write_matches_online(self):
        """ The queued web_save of an offline edit carries the email and phone
        that CrmFormRecord force-saves (KICKOFF defect 2): replaying it gives the
        same lead and partner state as the online save. """
        self.authenticate('admin', 'admin')
        online_lead, online_partner = self._lead_to_sync('Online')
        offline_lead, offline_partner = self._lead_to_sync('Offline')

        # online: the form saves the user's change plus the force-saved values
        online_lead.web_save({
            'expected_revenue': 1500,
            'email_from': online_lead.email_from,
            'phone': online_lead.phone,
        }, specification={})
        # offline: the exact call the framework queued (see crm_offline_form.test.js)
        self._replay('crm.lead', 'web_save', [[offline_lead.id], {
            'expected_revenue': 1500,
            'email_from': 'offline@example.com',
            'phone': '+32 494 44 44 44',
        }], {'context': {}, 'specification': {}})

        self.assertEqual(offline_lead.expected_revenue, online_lead.expected_revenue)
        self.assertEqual(offline_partner.email, 'offline@example.com')
        self.assertEqual(online_partner.email, 'online@example.com')
        self.assertEqual(offline_partner.phone, online_partner.phone)
        self.assertEqual(offline_partner.phone, '+32 494 44 44 44')

        # Without the force-saved values, the partner would not be updated: this
        # is why they must be part of the queued write.
        lead, partner = self._lead_to_sync('Missing')
        self._replay('crm.lead', 'web_save', [[lead.id], {'expected_revenue': 10}],
                     {'context': {}, 'specification': {}})
        self.assertFalse(partner.email)
        self.assertFalse(partner.phone)

    def test_offline_partner_change_write_matches_online(self):
        """ Onchanges don't run offline: after a partner change, the sync flags
        still describe the previous partner, so the crm form force-saves nothing
        (crm_offline_form.test.js). Replaying that write gives the lead the new
        partner's email and phone, as the online onchange does, and leaves the new
        partner untouched. """
        self.authenticate('admin', 'admin')
        online_lead, _online_partner = self._lead_to_sync('Online')
        offline_lead, _offline_partner = self._lead_to_sync('Offline')
        online_contact, offline_contact = self.env['res.partner'].create([
            {'name': 'New Online Contact', 'email': 'new.online@example.com', 'phone': '+32 470 00 00 01'},
            {'name': 'New Offline Contact', 'email': 'new.offline@example.com', 'phone': '+32 470 00 00 02'},
        ])

        # online: the onchange pulls the new partner's email and phone into the lead
        with Form(online_lead) as lead_form:
            lead_form.partner_id = online_contact
        # offline: the exact call the framework queued
        self._replay('crm.lead', 'web_save', [[offline_lead.id], {'partner_id': offline_contact.id}],
                     {'context': {}, 'specification': {}})

        self.assertEqual(online_lead.email_from, 'new.online@example.com')
        self.assertEqual(online_lead.phone, online_contact.phone)
        self.assertEqual(offline_lead.email_from, 'new.offline@example.com')
        self.assertEqual(offline_lead.phone, offline_contact.phone)
        self.assertEqual(online_contact.email, 'new.online@example.com')
        self.assertEqual(offline_contact.email, 'new.offline@example.com')
        self.assertEqual(offline_contact.phone, '+32 470 00 00 02')

        # Had the stale flags force-saved the lead's previous email, the replay
        # would have overwritten the new partner's email.
        lead, _partner = self._lead_to_sync('Stale')
        contact = self.env['res.partner'].create({'name': 'Kept Contact', 'email': 'kept@example.com'})
        self._replay('crm.lead', 'web_save', [[lead.id], {'partner_id': contact.id, 'email_from': lead.email_from}],
                     {'context': {}, 'specification': {}})
        self.assertEqual(contact.email, 'stale@example.com')

    def _salesman_lead(self, name):
        """ An opportunity of the salesman, who replays the queued calls below
        (no sudo: what the salesman may do online is what the replay may do). """
        self.authenticate(self.user_sales_salesman.login, self.user_sales_salesman.login)
        return self.env['crm.lead'].create({
            'name': name,
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'stage_id': self.stage_team1_1.id,
            'user_id': self.user_sales_salesman.id,
        })

    def test_offline_mark_won_replay(self):
        """ Mark won offline queues crm.lead.action_set_won([[id]]): replaying it
        leaves the lead won, as the online Won button (action_set_won_rainbowman,
        which only adds the rainbowman to its result) does. """
        online_lead = self._salesman_lead('Won online')
        offline_lead = self._salesman_lead('Won offline')

        online_lead.with_user(self.user_sales_salesman).action_set_won_rainbowman()
        self._replay('crm.lead', 'action_set_won', [[offline_lead.id]], {'context': {}})

        for lead in online_lead + offline_lead:
            with self.subTest(lead=lead.name):
                self.assertEqual(lead.won_status, 'won')
                self.assertTrue(lead.stage_id.is_won)
                self.assertEqual(lead.probability, 100)
        self.assertEqual(offline_lead.stage_id, online_lead.stage_id)

    def test_offline_activity_create_replay(self):
        """ Scheduling an activity offline queues mail.activity.create with values
        the client resolved itself (model name, record, type, summary, deadline,
        assignee): replaying it links the activity to the lead. """
        lead = self._salesman_lead('Activity offline')
        call_type = self.env.ref('mail.mail_activity_data_call')
        [activity_id] = self._replay('mail.activity', 'create', [[{
            'res_model': 'crm.lead',
            'res_id': lead.id,
            'activity_type_id': call_type.id,
            'summary': 'Call back about the quote',
            'date_deadline': '2030-01-15',
            'user_id': self.user_sales_salesman.id,
        }]], {'context': {}})

        activity = self.env['mail.activity'].browse(activity_id)
        self.assertEqual(activity.res_model_id.model, 'crm.lead')
        self.assertEqual(activity.res_model, 'crm.lead')
        self.assertEqual(activity.res_id, lead.id)
        self.assertEqual(lead.activity_ids, activity)
        self.assertEqual(activity.activity_type_id, call_type)
        self.assertEqual(activity.summary, 'Call back about the quote')
        self.assertEqual(str(activity.date_deadline), '2030-01-15')
        self.assertEqual(activity.user_id, self.user_sales_salesman)

    def test_offline_activity_done_replay(self):
        """ Marking an activity done offline queues only mail.activity.action_done
        on it, as the online Mark Done does: replaying it marks it done and logs it
        in the lead's chatter. """
        lead = self._salesman_lead('Activity done offline')
        activity = lead.with_user(self.user_sales_salesman).activity_schedule(
            'mail.mail_activity_data_todo', summary='Send the brochure',
            user_id=self.user_sales_salesman.id,
        )
        todo_type = activity.activity_type_id
        self._replay('mail.activity', 'action_done', [[activity.id]], {'context': {}})

        self.assertFalse(lead.activity_ids)
        done_messages = lead.message_ids.filtered(lambda message: message.mail_activity_type_id == todo_type)
        self.assertEqual(len(done_messages), 1)
        self.assertIn('Send the brochure', done_messages.body)

    def test_offline_log_call_replay(self):
        """ Logging a call offline queues a single crm.lead.action_log_call: the
        replay posts a done Call in the lead's chatter and leaves no open
        activity. """
        lead = self._salesman_lead('Call offline')
        call_type = self.env.ref('mail.mail_activity_data_call')
        self._replay('crm.lead', 'action_log_call', [[lead.id]], {
            'summary': 'Discussed the delivery date',
            'feedback': 'Wants delivery before May.',
            'context': {},
        })

        self.assertFalse(lead.activity_ids)
        call_messages = lead.message_ids.filtered(lambda message: message.mail_activity_type_id == call_type)
        self.assertEqual(len(call_messages), 1)
        self.assertIn('Discussed the delivery date', call_messages.body)
        self.assertIn('Wants delivery before May.', call_messages.body)
        self.assertEqual(call_messages.author_id, self.user_sales_salesman.partner_id)

    def test_offline_quick_create_replay(self):
        """ The small-screen quick create, offline, queues crm.lead.create with
        exactly the six values it captures and the pipeline's defaults in the
        context: replaying it as the salesman creates the lead with those values,
        the defaults applying as online. """
        self.authenticate(self.user_sales_salesman.login, self.user_sales_salesman.login)
        values = {
            'name': 'Quick lead offline',
            'contact_name': 'Ana Road',
            'phone': '+32 470 00 00 00',
            'email_from': 'ana@example.com',
            'expected_revenue': 1500,
            'stage_id': self.stage_team1_2.id,
        }
        lead_ids = self._replay('crm.lead', 'create', [[values]], {
            'context': {'default_type': 'opportunity', 'default_team_id': self.sales_team_1.id},
        })
        lead = self.env['crm.lead'].browse(lead_ids)
        self.assertEqual(len(lead), 1)
        self.assertRecordValues(lead, [{
            **values,
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'active': True,
        }])

    def test_mobile_pipeline_wiring(self):
        """ The small-screen pipeline is a branch of the crm_kanban renderer
        (no new view, action or js_class), enabled by the pipeline's arch only:
        other crm kanban views (the leads kanban, the forecast) keep the kanban
        on small screens. """
        kanban_view = self.env.ref('crm.crm_lead_action_pipeline_view_kanban').view_id
        self.assertEqual(kanban_view, self.env.ref('crm.crm_case_kanban_view_leads'))
        arch = kanban_view.arch
        self.assertIn('js_class="crm_kanban"', arch)
        self.assertIn('mobile_pipeline="1"', arch)
        self.assertNotIn('mobile_pipeline', self.env.ref('crm.view_crm_lead_kanban').arch)
        # the forecast kanban inherits the pipeline's arch, but its own renderer has
        # no small-screen pipeline: the marker is removed there
        forecast = etree.fromstring(self.env.ref('crm.crm_lead_view_kanban_forecast').get_combined_arch())
        self.assertEqual(forecast.get('js_class'), 'forecast_kanban')
        self.assertIsNone(forecast.get('mobile_pipeline'))

    def test_offline_wiring_and_unavailable_actions(self):
        """ The screens of decisions D13 and D16 are opted out of the offline
        cache, so the framework never makes them available offline; the stage list
        uses the crm_stage_list view (read-only and not reorderable offline). """
        for xmlid in (
            'sales_team.crm_team_action_pipeline',
            'crm.crm_activity_report_action',
            'crm.crm_activity_report_action_team',
            'crm.crm_lost_reason_action',
            'crm.crm_recurring_plan_action',
            'sales_team.crm_team_member_action',
            'sales_team.mail_activity_type_action_config_sales',
            'crm.mail_activity_plan_action_lead',
        ):
            with self.subTest(action=xmlid):
                self.assertFalse(self.env.ref(xmlid).cache)
        # the pipeline and the lead lists stay cached (available offline)
        for xmlid in ('crm.crm_lead_action_pipeline', 'crm.crm_lead_all_leads'):
            with self.subTest(action=xmlid):
                self.assertTrue(self.env.ref(xmlid).cache)
        self.assertIn('js_class="crm_stage_list"', self.env.ref('crm.crm_stage_tree').arch)

    def test_offline_wiring_of_the_lead_form(self):
        """ The lead form's arch wires the offline behaviour: one Won button,
        available offline once the lead has an id (sale_crm's view targets it by
        name), Restore available offline, the crm stage bar and the offline
        activity panel. """
        arch = etree.fromstring(self.env.ref('crm.crm_lead_view_form').arch)
        self.assertEqual(arch.get('js_class'), 'crm_form')
        won_buttons = arch.xpath("//header/button[@name='action_set_won_rainbowman']")
        self.assertEqual(len(won_buttons), 1)
        self.assertEqual(won_buttons[0].get('data-available-offline'), '1')
        self.assertEqual(won_buttons[0].get('data-crm-offline-needs-id'), '1')
        self.assertNotIn('id', won_buttons[0].get('invisible'))
        [restore] = arch.xpath("//header/button[@name='action_restore']")
        self.assertEqual(restore.get('data-available-offline'), '1')
        [stage] = arch.xpath("//header/field[@name='stage_id']")
        self.assertEqual(stage.get('widget'), 'crm_statusbar')
        self.assertEqual(len(arch.xpath("//sheet//widget[@name='crm_offline_activities']")), 1)

    def test_offline_markers_in_crm_archs(self):
        """ The <a> view buttons that need a server carry the marker crm uses to
        disable them offline (the framework only disables <button> elements). """
        lead_form = self.env.ref('crm.crm_lead_view_form').arch
        self.assertEqual(lead_form.count('name="action_set_automated_probability"'), 2)
        self.assertEqual(
            lead_form.count('name="action_set_automated_probability"'),
            lead_form.count('data-crm-offline-disable="1"'),
        )
        campaign_kanban = self.env.ref('crm.utm_campaign_view_kanban').arch
        self.assertIn('data-crm-offline-disable="1"', campaign_kanban)
