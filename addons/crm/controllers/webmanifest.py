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
        if not crm_app or '/odoo?menu_id=%s' % crm_app.id not in [s['url'] for s in shortcuts]:
            return shortcuts
        pipeline_menu = request.env.ref('crm.menu_crm_opportunities')
        pipeline_action = request.env.ref('crm.crm_lead_action_pipeline')
        icons = [{
            'sizes': '100x100',
            'src': CRM_ICON,
            'type': mimetypes.guess_type(CRM_ICON)[0] or 'image/png',
        }]
        return shortcuts + [{
            'name': request.env._('My Pipeline'),
            'url': '/odoo?menu_id=%s' % pipeline_menu.id,
            'description': request.env._('Your opportunities, stage by stage'),
            'icons': icons,
        }, {
            'name': request.env._('New Lead'),
            'url': '/odoo?menu_id=%s&action=%s&view_type=form' % (pipeline_menu.id, pipeline_action.id),
            'description': request.env._('Create a lead in your pipeline'),
            'icons': icons,
        }]
