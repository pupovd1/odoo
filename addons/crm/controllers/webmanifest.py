# Part of Odoo. See LICENSE file for full copyright and licensing details.

import mimetypes

from odoo.http import request

from odoo.addons.web.controllers import webmanifest

CRM_ICON = '/crm/static/description/icon.png'


class WebManifest(webmanifest.WebManifest):

    def _has_share_target(self):
        return True

    def _get_shortcuts(self):
        """ Two deep links into CRM, after the parent's shortcuts: the pipeline
        and a new lead. Only for users the parent lists the CRM app for. """
        shortcuts = super()._get_shortcuts()
        crm_app = request.env.ref('crm.crm_menu_root', raise_if_not_found=False)
        pipeline_menu = request.env.ref('crm.menu_crm_opportunities', raise_if_not_found=False)
        pipeline_action = request.env.ref('crm.crm_lead_action_pipeline', raise_if_not_found=False)
        crm_app_url = crm_app and '/odoo?menu_id=%s' % crm_app.id
        if not (pipeline_menu and pipeline_action) or crm_app_url not in [s['url'] for s in shortcuts]:
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
            'url': '/odoo?menu_id=%s&action=%s&view_type=form' % (pipeline_menu.id, pipeline_action.id),
            'description': request.env._('Create a lead in your pipeline'),
            'icons': [dict(icon)],
        }]
