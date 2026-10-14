# Part of Odoo. See LICENSE file for full copyright and licensing details.

import re
from contextlib import contextmanager
from unittest.mock import patch

from lxml import etree

from odoo.tests import Form, HttpCase, tagged
from odoo.tests.common import ChromeBrowser
from odoo.tools import file_open

from odoo.addons.crm.controllers.webmanifest import WebManifest as CrmWebManifest
from odoo.addons.crm.models.mail_activity import MailActivity as CrmMailActivity
from odoo.addons.crm.tests.common import TestCrmCommon
from odoo.addons.mail.tests.common import mail_new_test_user
from odoo.addons.web.controllers.webmanifest import WebManifest

# what crm_offline_tour logs to switch the test browser's network off / on
TOUR_NETWORK_SIGNALS = {
    'crm_offline_tour: network off': True,
    'crm_offline_tour: network on': False,
}


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

    def _online_partner_change(self, lead, partner):
        """ The online flow of a partner change on the lead form: the partner's
        onchange, then the save of CrmFormRecord (the changes, plus the email and
        phone force-saved when the onchange's sync flags are set). """
        lead_form = Form(lead)
        lead_form.partner_id = partner
        values = {'partner_id': partner.id}
        for fname, flag in (('email_from', 'partner_email_update'), ('phone', 'partner_phone_update')):
            if lead_form[fname] and (lead_form[fname] != lead[fname] or lead_form[flag]):
                values[fname] = lead_form[fname]
        lead.web_save(values, specification={})

    def test_offline_partner_change_write_matches_online(self):
        """ Onchanges don't run offline: after a partner change, the sync flags
        still describe the previous partner. The crm form then force-saves the
        lead's email and phone and names them in the context
        (crm_partner_sync_force_saved, crm_offline_form.test.js); replaying that
        write gives the same lead and partner state as the online onchange and
        save, whether the new partner has its own email and phone (the lead takes
        them, the partner is untouched) or not (the partner gets the lead's). """
        self.authenticate('admin', 'admin')
        new_partners = {
            'with email and phone': {'email': 'new@example.com', 'phone': '+32 470 00 00 01'},
            'without email or phone': {'email': False, 'phone': False},
            'with an email only': {'email': 'new@example.com', 'phone': False},
        }
        for case, partner_values in new_partners.items():
            with self.subTest(case=case):
                online_lead, _ = self._lead_to_sync('Online')
                offline_lead, _ = self._lead_to_sync('Offline')
                online_contact, offline_contact = self.env['res.partner'].create([
                    {'name': 'New Online Contact', **partner_values},
                    {'name': 'New Offline Contact', **partner_values},
                ])

                self._online_partner_change(online_lead, online_contact)
                # offline: the exact call the framework queued
                self._replay('crm.lead', 'web_save', [[offline_lead.id], {
                    'partner_id': offline_contact.id,
                    'email_from': offline_lead.email_from,
                    'phone': offline_lead.phone,
                }], {
                    'context': {'crm_partner_sync_force_saved': ['email_from', 'phone']},
                    'specification': {},
                })

                self.assertEqual(offline_lead.partner_id, offline_contact)
                # the leads differ only by their initial email: compare with it swapped
                swap = lambda value: value and value.replace('online@', 'offline@')
                self.assertEqual(offline_lead.email_from, swap(online_lead.email_from))
                self.assertEqual(offline_lead.phone, online_lead.phone)
                self.assertEqual(offline_contact.email, swap(online_contact.email))
                self.assertEqual(offline_contact.phone, online_contact.phone)
                if partner_values['email']:
                    self.assertEqual(offline_lead.email_from, 'new@example.com')
                    self.assertEqual(offline_contact.email, 'new@example.com')
                else:
                    # propagated to the partner, as online (KICKOFF defect 2)
                    self.assertEqual(offline_contact.email, 'offline@example.com')
                if not partner_values['phone']:
                    self.assertEqual(offline_contact.phone, '+32 494 44 44 44')

        # Without the context key, the force-saved values would be kept as the
        # user's own: the new partner's email would be overwritten.
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
        the client resolved itself (record, type, summary, deadline, assignee) and
        the lead's model in the context, as the chatter schedules one:
        mail.activity's own default_get resolves it (crm doesn't override
        create). Replaying it links the activity to the lead. """
        self.assertNotIn('create', vars(CrmMailActivity))
        lead = self._salesman_lead('Activity offline')
        call_type = self.env.ref('mail.mail_activity_data_call')
        [activity_id] = self._replay('mail.activity', 'create', [[{
            'res_id': lead.id,
            'activity_type_id': call_type.id,
            'summary': 'Call back about the quote',
            'date_deadline': '2030-01-15',
            'user_id': self.user_sales_salesman.id,
        }]], {'context': {'default_res_model': 'crm.lead'}})

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
        """ The screens of decisions D13 and D16 (and the tags) are unavailable
        offline through crm's RelationalModel patch, which names them by xml id:
        each is an existing action, and keeps the framework's cache (cache-first
        rendering online, as before). The stage list uses the crm_stage_list view
        (read-only and not reorderable offline). """
        with file_open('crm/static/src/views/relational_model_patch.js') as patch_file:
            source = patch_file.read()
        online_only = re.findall(r'^\s+"([\w.]+)",$', source.split('CRM_ONLINE_ONLY_ACTIONS')[1].split('];')[0], re.M)
        self.assertEqual(sorted(online_only), sorted([
            'sales_team.crm_team_action_pipeline',
            'crm.crm_activity_report_action',
            'crm.crm_activity_report_action_team',
            'crm.crm_lost_reason_action',
            'crm.crm_recurring_plan_action',
            'sales_team.crm_team_member_action',
            'sales_team.mail_activity_type_action_config_sales',
            'crm.mail_activity_plan_action_lead',
            'sales_team.sales_team_crm_tag_action',
        ]))
        for xmlid in online_only:
            with self.subTest(action=xmlid):
                action = self.env.ref(xmlid)
                self.assertEqual(action._name, 'ir.actions.act_window')
                self.assertTrue(action.cache)
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

    def _manifest(self):
        response = self.url_open('/web/manifest.webmanifest')
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_webmanifest_crm_shortcuts(self):
        """ The manifest's shortcuts are the parent's (the CRM app once), then
        My Pipeline and New Lead in the parent's shape with crm's own icon; the
        manifest's icon is the addon's existing icon (openable, one large enough
        for an installable app); the rest of the manifest is the parent's (its
        colors, the share target kept). """
        self.authenticate(self.user_sales_salesman.login, self.user_sales_salesman.login)
        with patch.object(CrmWebManifest, '_get_shortcuts', WebManifest._get_shortcuts), \
             patch.object(CrmWebManifest, '_get_webmanifest', WebManifest._get_webmanifest):
            parent = self._manifest()
        manifest = self._manifest()
        shortcuts = manifest['shortcuts']
        self.assertEqual(shortcuts[:-2], parent['shortcuts'])
        self.assertEqual(
            {**manifest, 'shortcuts': None, 'icons': None},
            {**parent, 'shortcuts': None, 'icons': None},
        )
        crm_app_url = '/odoo?menu_id=%s' % self.env.ref('crm.crm_menu_root').id
        self.assertEqual([shortcut['url'] for shortcut in shortcuts].count(crm_app_url), 1)

        pipeline_menu = self.env.ref('crm.menu_crm_opportunities')
        pipeline_action = self.env.ref('crm.crm_lead_action_pipeline')
        crm_icons = [{'sizes': '100x100', 'src': '/crm/static/description/icon.png', 'type': 'image/png'}]
        self.assertEqual(shortcuts[-2:], [{
            'name': 'My Pipeline',
            'url': '/odoo?menu_id=%s' % pipeline_menu.id,
            'description': 'Your opportunities, stage by stage',
            'icons': crm_icons,
        }, {
            'name': 'New Lead',
            # the pipeline action's route, on a new record
            'url': '/odoo/action-%s/new' % pipeline_action.id,
            'description': 'Create a lead in your pipeline',
            'icons': crm_icons,
        }])
        for shortcut in shortcuts[-2:]:
            self.assertEqual(shortcut.keys(), parent['shortcuts'][0].keys())

        # the manifest's icon: the addon's existing icon assets
        self.assertEqual(manifest['icons'], [
            {'src': '/crm/static/description/icon_hi.png', 'sizes': '512x512', 'type': 'image/png'},
            {'src': '/crm/static/description/icon.png', 'sizes': '100x100', 'type': 'image/png'},
        ])
        self.assertEqual(parent['icons'][0]['src'], '/web/static/img/odoo-icon-192x192.png')
        for icon in manifest['icons'] + crm_icons:
            response = self.url_open(icon['src'])
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Content-Type'], 'image/png')

        # crm extends the manifest's content only (and keeps the share target): no
        # route, service worker or offline page of its own
        for name in ('webmanifest', 'service_worker', 'offline', '_get_service_worker_content',
                     '_icon_path', 'scoped_app_manifest'):
            self.assertNotIn(name, vars(CrmWebManifest))
        self.assertEqual((manifest['background_color'], manifest['theme_color']), ('#714B67', '#714B67'))
        self.assertEqual(manifest['share_target']['action'], '/odoo?share_target=trigger')

    def test_webmanifest_no_crm_shortcuts_without_crm_access(self):
        """ No CRM shortcut or icon for anonymous visitors (no shortcut at all, as
        in web) nor for internal users the CRM app isn't listed for. """
        manifest = self._manifest()
        self.assertEqual(manifest['shortcuts'], [])
        self.assertEqual(manifest['icons'][0]['src'], '/web/static/img/odoo-icon-192x192.png')

        # an internal user with apps (Discuss) but not CRM
        user = mail_new_test_user(
            self.env, login='user_without_crm', groups='base.group_user,base.group_user_regular',
        )
        self.authenticate(user.login, user.login)
        manifest = self._manifest()
        shortcuts = manifest['shortcuts']
        self.assertTrue(shortcuts, "the parent's shortcuts (Discuss) are kept")
        # nor CRM's icon: the parent's manifest icon
        self.assertEqual(manifest['icons'][0]['src'], '/web/static/img/odoo-icon-192x192.png')
        crm_menus = self.env.ref('crm.crm_menu_root') + self.env.ref('crm.menu_crm_opportunities')
        for shortcut in shortcuts:
            self.assertNotIn(shortcut['name'], ('CRM', 'My Pipeline', 'New Lead'))
            self.assertFalse(any('menu_id=%s' % menu.id in shortcut['url'] for menu in crm_menus))

    @contextmanager
    def _tour_network_switch(self):
        """ Lets crm_offline_tour switch the test browser's network off and on:
        when a step logs one of TOUR_NETWORK_SIGNALS, the browser gets the
        DevTools offline network emulation (as DevTools' "Offline": every page
        request fails, navigator.onLine turns false and 'offline' / 'online'
        events fire). """
        handle_console = ChromeBrowser._handle_console

        def _handle_console(browser, **params):
            handle_console(browser, **params)
            message = (params.get('args') or [{}])[0].get('value')
            if (offline := TOUR_NETWORK_SIGNALS.get(message)) is not None:
                # the emulation applies once the network domain is enabled
                browser._websocket_send('Network.enable')
                browser._websocket_send('Network.emulateNetworkConditions', params={
                    'offline': offline,
                    'latency': 0,
                    'downloadThroughput': -1,
                    'uploadThroughput': -1,
                })

        with patch.object(ChromeBrowser, '_handle_console', _handle_console):
            yield

    def test_crm_offline_tour(self):
        """ KICKOFF's browser tour, at the mobile preset's size with touch: the
        pipeline and a lead visited online; with the network off, an edit of that
        lead, a mobile quick create, an activity scheduled and Won, all queued;
        back online, every change reaches the server through the replay. """
        lead = self.env['crm.lead'].create({
            'name': 'Offline tour opportunity',
            'type': 'opportunity',
            'user_id': self.user_admin.id,
            'expected_revenue': 1000,
        })
        stage = lead.stage_id
        self.assertFalse(stage.is_won)

        self.browser_size = '375x667'
        self.touch_enabled = True
        with self._tour_network_switch():
            self.start_tour('/odoo/crm', 'crm_offline_tour', login='admin')

        # the edit, then Won
        self.assertRecordValues(lead, [{
            'expected_revenue': 2500,
            'won_status': 'won',
            'probability': 100,
            'active': True,
        }])
        self.assertTrue(lead.stage_id.is_won)
        # the quick create, in the stage it was created in
        created = self.env['crm.lead'].search([('name', '=', 'Lead created offline')])
        self.assertRecordValues(created, [{
            'contact_name': 'Alex Rivera',
            'phone': '+32 470 12 34 56',
            'email_from': 'alex.rivera@example.com',
            'expected_revenue': 4200,
            'stage_id': stage.id,
            'type': 'opportunity',
            'user_id': self.user_admin.id,
        }])
        # the activity, linked to the lead
        activity = self.env['mail.activity'].search([
            ('res_model', '=', 'crm.lead'),
            ('res_id', '=', lead.id),
            ('summary', '=', 'Call back about the offer'),
        ])
        self.assertRecordValues(activity, [{
            'activity_type_id': self.env.ref('mail.mail_activity_data_call').id,
            'user_id': self.user_admin.id,
        }])
        self.assertTrue(activity.date_deadline)

    def test_offline_disabled_buttons_in_crm_archs(self):
        """ Inventory rows enforced by the framework's rule (a <button> without
        data-available-offline is disabled offline, re-enabled online: JS33) are
        such buttons in the archs crm ships: team form and stat button (B71/C22,
        B72/C23), partner stat button (B89), campaign form (B91), settings (B92,
        B93, B94), the lost and scoring wizards (B96, B98). """
        pls_update_action = self.env.ref('crm.crm_lead_pls_update_action')
        cases = [
            ('sales_team.crm_team_view_form', ['action_assign_leads', 'action_open_opportunities']),
            ('base.view_partner_form', ['action_view_opportunity']),
            ('utm.utm_campaign_view_form', ['action_redirect_to_leads_opportunities']),
            ('base.res_config_settings_view_form', [
                'crm.crm_recurring_plan_action', str(pls_update_action.id), 'action_crm_assign_leads',
            ]),
            ('crm.crm_lead_lost_view_form', ['action_lost_reason_apply']),
            ('crm.crm_lead_pls_update_view_form', ['action_update_crm_lead_probabilities']),
        ]
        for view_xmlid, names in cases:
            arch = etree.fromstring(self.env.ref(view_xmlid).get_combined_arch())
            for name in names:
                with self.subTest(view=view_xmlid, button=name):
                    nodes = arch.xpath(f"//*[@name='{name}'][@type]")
                    self.assertTrue(nodes)
                    for node in nodes:
                        self.assertEqual(node.tag, 'button')
                        self.assertIsNone(node.get('data-available-offline'))
