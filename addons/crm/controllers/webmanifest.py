# Part of Odoo. See LICENSE file for full copyright and licensing details.

import mimetypes

from odoo.http import request

from odoo.addons.web.controllers import webmanifest

CRM_ICON = '/crm/static/description/icon.png'
# the addon's existing icons, as the manifest lists them (an installable web
# app needs one of at least 144 px)
CRM_MANIFEST_ICONS = [
    {'src': '/crm/static/description/icon_hi.png', 'sizes': '512x512', 'type': 'image/png'},
    {'src': CRM_ICON, 'sizes': '100x100', 'type': 'image/png'},
]


class WebManifest(webmanifest.WebManifest):

    def _has_share_target(self):
        return True

    def _get_webmanifest(self):
        """ For the users the parent lists the CRM app for, the manifest's icon
        is the addon's existing icon (the parent's otherwise). Nothing else of
        the parent's manifest changes. """
        manifest = super()._get_webmanifest()
        if self._get_crm_app_url() in [s['url'] for s in manifest['shortcuts']]:
            manifest['icons'] = [dict(icon) for icon in CRM_MANIFEST_ICONS]
        return manifest

    def _get_crm_app_url(self):
        crm_app = request.env.ref('crm.crm_menu_root', raise_if_not_found=False)
        return crm_app and '/odoo?menu_id=%s' % crm_app.id

    def _get_shortcuts(self):
        """ Two deep links into CRM, after the parent's shortcuts: the pipeline
        and a new lead. Only for users the parent lists the CRM app for. """
        shortcuts = super()._get_shortcuts()
        pipeline_menu = request.env.ref('crm.menu_crm_opportunities', raise_if_not_found=False)
        pipeline_action = request.env.ref('crm.crm_lead_action_pipeline', raise_if_not_found=False)
        if not (pipeline_menu and pipeline_action) or self._get_crm_app_url() not in [s['url'] for s in shortcuts]:
            return shortcuts
        icon = {
            'sizes': '100x100',
            'src': CRM_ICON,
            'type': mimetypes.guess_type(CRM_ICON)[0] or 'image/png',
        }
        return shortcuts + [{
            'name': request.env._('My Pipeline'),
            'url': '/odoo?menu_id=%s' % pipeline_menu.id,
            'description': request.env._('Your opportunities, stage by stage'),
            'icons': [dict(icon)],
        }, {
            'name': request.env._('New Lead'),
            # the pipeline action's route, on a new record
            'url': '/odoo/action-%s/new' % pipeline_action.id,
            'description': request.env._('Create a lead in your pipeline'),
            'icons': [dict(icon)],
        }]
