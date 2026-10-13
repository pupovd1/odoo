# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.addons.crm.tests.common import TestCrmCommon
from odoo.tests import Form, HttpCase, tagged


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
