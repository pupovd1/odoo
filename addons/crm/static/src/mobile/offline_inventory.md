# CRM offline surface inventory

Every entry point of the crm addon that needs a live server, with what it does offline.

## Scope and rules

Swept (KICKOFF milestone 1): every JavaScript call in `addons/crm/static/src` to the ORM, to `rpc`,
to the action service or to a group/access-right probe (section A); every view, wizard and report
control declared in crm XML with a server side effect (section B); every public method of
`crm.lead`, `crm.stage` and `crm.team` reachable from a button (section C). Section D lists the entry
points this work adds. Line numbers point at the current code (checked at every milestone).

Classification, rules applied in order:

1. **QUEUE**: a write on `crm.lead`, `crm.stage`, `crm.team`, or a lead's `mail.activity` whose full
   argument list is resolvable on the client. Offline it is queued in the framework's queue
   (`OfflinePlugin.scheduleORM`) and the UI updates optimistically; it is replayed on reconnect.
2. **SKIP**: a read that is only decorative or advisory (tooltip, visual effect, promotional hint,
   a group probe that only toggles display). Offline it is not sent: no call, no error, no
   notification. Never queued.
3. **DISABLE**: everything else, including transient-model wizards, module installation, paid
   external lookups, server-computed reports, access probes gating destructive UI, writes on other
   models, and navigation to anything unavailable offline. Offline the control is disabled and
   unreachable by click, keyboard, hotkey or programmatic call. Anything that needs a server
   onchange, a transient-model wizard or an id produced by another call is DISABLE, never QUEUE.

Reads of data the user already visited online (a lead form, the pipeline, the team switcher's teams)
are answered offline by the framework's RPC disk cache; the corresponding rows say so. A lead, a
view or a stage that was never loaded online is unavailable offline: DISABLE, with the offline
action helper shown in its place.

"Enforced by" names who makes the row hold offline: **framework** (addons/web already does it:
`<button>` elements without `data-available-offline` are disabled, action/cog menu items without
`availableOffline` are greyed out, unavailable views and menus are disabled, record saves, deletes
and (un)archives are queued) or **crm** (code or data in addons/crm, with the milestone).
"Test" names the test that proves the row; the "Tests" section at the end maps each id to its
test file and test name.

## Counts

| Classification | Rows |
|---|---|
| QUEUE | 31 |
| SKIP | 8 |
| DISABLE | 148 |
| Total | 187 |

## A. JavaScript calls (addons/crm/static/src)

| # | File:line | Call | Class | Enforced by | Justification | Test |
|---|---|---|---|---|---|---|
| A1 | addons/crm/static/src/activity_menu_patch.js:56 | `this.action.loadAction("crm.crm_lead_action_my_activities")` (CRM row of the activity systray) | DISABLE | crm (M2) | Navigation to a computed search (late / today / future) that is not cached; KICKOFF defect 7: the CRM row is disabled offline and `openActivityGroup` returns early for crm.lead. | JS09 |
| A2 | addons/crm/static/src/activity_menu_patch.js:62 | `this.action.doAction(action, {` (opens My Activities) | DISABLE | crm (M2) | Same control as A1. | JS09 |
| A3 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:151 | `.searchRead(` on `ir.module.module` (first open of Generate) | DISABLE | crm (M2) | Module lookup feeding the module-installation choices; KICKOFF defect 4: Generate is disabled offline and no lookup is issued. | JS06 |
| A4 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:177 | `await user.checkAccessRight(model, "create")` | DISABLE | crm (M2) | Access probe gating the install / access-request UI; defect 4: not issued offline. | JS06 |
| A5 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:221 | `await this.orm.silent.call("ir.module.module", "button_immediate_install", [` | DISABLE | crm (M2) | Module installation (crm_iap_mine is a paid lookup service). | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A6 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:224 | `location.reload();` | DISABLE | crm (M2) | Part of module installation. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A7 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:227 | `this.dialogs.add(ErrorDialog, { message: error });` | DISABLE | crm (M2) | Part of module installation. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A8 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:234 | `this.dialogs.add(ConfirmationDialog, dialogProps);` | DISABLE | crm (M2) | Install confirmation, leads to A5. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A9 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:249 | `this.dialogs.add(PromoteMailPluginsDialog, {` | DISABLE | crm (M2) | Not SKIP: it is not a read but a dialog the user opens, whose content (external links, a video) needs the network; only reachable from the disabled Generate dropdown. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A10 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:256 | `this.action.doAction({` (client action `import`) | DISABLE | crm (M2) | CSV import: file upload and server-side parsing. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A11 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:272 | `this.action.doAction({` (`base.module.install.request`, target new) | DISABLE | crm (M2) | Transient-model wizard. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| A12 | addons/crm/static/src/components/team_switcher/team_switcher.js:76 | `await user.hasGroup("sales_team.group_sale_manager")` | SKIP | crm (M2) | Group probe that only toggles the display of "Manage Teams"; KICKOFF defect 3: not issued offline and treated as false; probed when back online. | JS05 |
| A13 | addons/crm/static/src/components/team_switcher/team_switcher.js:83 | `this.actionService.doAction("sales_team.crm_team_action_config")` | DISABLE | crm (M2) | Navigation to team configuration; defect 3: Manage Teams is unreachable offline (not rendered, handler returns early). | JS05 |
| A14 | addons/crm/static/src/components/team_switcher/team_switcher.js:97 | `this.env.searchModel._updateSwitcherSelection(teamId);` | DISABLE | crm (M2) | Switching team reloads the pipeline with a domain that is not cached; defect 3: the dropdown is disabled offline and the handler returns early. The selected team stays visible as a search facet (CrmSearchModel.getCurrentSearch). | JS05 |
| A15 | addons/crm/static/src/views/check_rainbowman_message.js:2 | `orm.call("crm.lead", "get_rainbowman_message", [[recordId]])` | SKIP | crm (M2) | Visual effect lookup (rule 2 example); its callers skip it offline and it is never queued (a replay would fire the effect detached from the save). | JS01, JS04 |
| A16 | addons/crm/static/src/views/crm_form/crm_form.js:69 | `const res = await super._save(...arguments);` (lead form save, web_save) | QUEUE | framework (record `_offlineSave`) | Write on crm.lead with client-resolvable values; queued and replayed in order. The email and phone that CrmFormRecord force-saves for partner sync are part of the queued write (KICKOFF defect 2). | JS03, PY01 |
| A17 | addons/crm/static/src/views/crm_form/crm_form.js:71 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);` | SKIP | crm (M2) | Rainbowman after a stage change; KICKOFF defect 1: skipped offline, the save still completes; still issued online. | JS01, JS02 |
| A18 | addons/crm/static/src/views/crm_form/crm_pls_tooltip_button.js:57 | `await this.props.record.save();` (before the PLS tooltip) | DISABLE | crm (M2) | Only runs when the predictive-scoring tooltip opens; predictive lead scoring is out of scope; KICKOFF defect 6: the button is disabled offline, no lookup. | JS08 |
| A19 | addons/crm/static/src/views/crm_form/crm_pls_tooltip_button.js:64 | `const tooltipData = await this.orm.call(` (`prepare_pls_tooltip_data`) | DISABLE | crm (M2) | Recomputes and writes server-computed probabilities (out of scope); defect 6. | JS08 |
| A20 | addons/crm/static/src/views/crm_form/crm_pls_tooltip_button.js:70 | `await this.props.record.load();` | DISABLE | crm (M2) | Reload after A19, same control. | JS08 |
| A21 | addons/crm/static/src/views/crm_kanban/crm_kanban_model.js:33 | `await super.moveRecords(...arguments);` (drag between stages) | QUEUE | framework (dynamic list `_saveRecords`) | web_save {stage_id} per moved lead, client-resolvable; queued and replayed (desktop: the small-screen kanban has no drag and drop). | JS04 |
| A22 | addons/crm/static/src/views/crm_kanban/crm_kanban_model.js:42 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, movedLeads[0].resId);` | SKIP | crm (M2) | Rainbowman after a stage move; defect 1. | JS04 |
| A23 | addons/crm/static/src/views/crm_kanban/crm_column_progress.js:40 | `await user.hasGroup("crm.group_use_recurring_revenues")` | SKIP | crm (M2) | Group probe that only toggles the recurring-revenue aggregate; KICKOFF defect 5: not issued offline and the aggregate is hidden (a zero would read as real data). | JS07 |
| A24 | addons/crm/static/src/views/crm_search_model.js:130 | `const { available, teams } = await this.orm` (`get_team_switcher_data`, disk cache) | DISABLE | crm (M2) + framework (RPC disk cache) | Feeds the team switcher, whose control is disabled offline (defect 3). The read is answered from the framework's RPC disk cache, so the selected team's domain and facet survive offline; a pipeline never loaded online is unavailable offline (offline action helper). | JS05 |
| A25 | addons/crm/static/src/views/forecast_kanban/forecast_kanban_renderer.js:55 | `await this.props.list.load();` ("add next period" column) | DISABLE | crm (M2) | A new read with an expanded period, never cached; the forecast's add-column control is hidden offline. | JS39 |
| A26 | addons/crm/static/src/views/forecast_kanban/forecast_kanban_column_quick_create.js:20 | `this.props.onValidate();` (unfolding creates the column) | DISABLE | crm (M2) | Same control as A25 (its outer element is a div, not a button, so the framework doesn't disable it). | JS39 |
| A27 | addons/crm/static/src/webclient/share_target/crm_share_target_item.js:46 | `this.state.teams = await this.orm` (`webSearchRead("crm.team", ...)`) | DISABLE | crm (M2) | "Share to Lead" needs a file upload, a name_create and an attachment write on the new id (an id produced by another call); the CRM share item is disabled offline and reads no teams. | JS40 |
| A28 | addons/crm/static/src/webclient/share_target/crm_share_target_item.js:62 | `this.updateTeams();` (company change) | DISABLE | crm (M2) | Same flow as A27. | JS40 |
| A29 | addons/crm/static/src/webclient/share_target/crm_share_target_item.js:105 | `registry.category("share_target_items").add("crm", CrmShareTargetItem);` (the Share to Lead item; its inherited `process()` uploads files, name_creates the lead, writes the attachments) | DISABLE | crm (M2) | Same flow as A27. | JS40 |

## B. View, wizard and report controls (crm XML)

| # | File:line | Call | Class | Enforced by | Justification | Test |
|---|---|---|---|---|---|---|
| B1 | addons/crm/views/crm_lead_views.xml:7 | `js_class="crm_form"` (opening a lead: web_read) | DISABLE | crm (M3) | Reading a lead needs the server unless it was visited online (then the RPC cache serves it); a lead never visited online can't be opened offline: crm_form shows the offline action helper instead of an empty form or an error. | JS13 |
| B2 | addons/crm/views/crm_lead_views.xml:11 | `name="action_set_won_rainbowman"` (Won) | QUEUE | crm (M3) | Mark won: write on crm.lead with args [[id]]; offline crm queues `action_set_won` (the rainbowman part is SKIP, A15) and shows the lead won at once, also when it is opened again before the replay. One Won button (sale_crm's view targets it by name): a lead created offline has no id, so its Won button (`data-crm-offline-needs-id`) is disabled offline until synced (crm ViewButton patch). | JS11, JS12, JS55, JS66, PY02, PY14 |
| B3 | addons/crm/views/crm_lead_views.xml:15 | `name="action_convert_to_opportunity"` | DISABLE | framework (`<button>`) | Converts and matches or creates a res.partner on the server: a write outside the queueable models. | JS33 |
| B4 | addons/crm/views/crm_lead_views.xml:17 | `name="action_restore"` (Restore a lost lead) | QUEUE | crm (M3) | Write on crm.lead with args [[id]]; offline crm queues `action_restore` and shows the lead as no longer lost. | JS35, JS65, JS66, PY14 |
| B5 | addons/crm/views/crm_lead_views.xml:19 | `name="%(crm.crm_lead_lost_action)d"` (Lost) | DISABLE | framework (`<button>`) | Opens the crm.lead.lost wizard (transient model; out of scope). | JS33 |
| B6 | addons/crm/views/crm_lead_views.xml:21 | `widget="crm_statusbar"` (stage bar) | QUEUE | crm (M3) + framework (web_save) | Stage move from the form: web_save {stage_id}, client-resolvable; crm marks the lead form's stage buttons available offline and the save is queued. | JS14 |
| B7 | addons/crm/views/crm_lead_views.xml:36 | `name="action_schedule_meeting"` (Meeting stat button) | DISABLE | framework (`<button>`) | Calendar navigation (calendar.event out of scope). | JS33 |
| B8 | addons/crm/views/crm_lead_views.xml:45 | `name="action_show_potential_duplicates"` (Similar Leads) | DISABLE | framework (`<button>`) | Navigation built by a server call (duplicate ids). | JS33 |
| B9 | addons/crm/views/crm_lead_views.xml:93 | `name="action_set_automated_probability"` (AI link, desktop block) | DISABLE | crm (M2) | Predictive lead scoring (out of scope; recomputed server-side). An `<a>` is not disabled by the framework, so crm disables it offline. | JS42 |
| B10 | addons/crm/views/crm_lead_views.xml:102 | `<widget name="pls_tooltip_button" class="d-inline-block"` | DISABLE | crm (M2) | KICKOFF defect 6: predictive-scoring tooltip button disabled offline, no lookup. | JS08 |
| B11 | addons/crm/views/crm_lead_views.xml:134 | `<widget name="pls_tooltip_button" invisible=` (touch block) | DISABLE | crm (M2) | KICKOFF defect 6 (touch block of the form): disabled offline, no lookup. | JS08 |
| B12 | addons/crm/views/crm_lead_views.xml:142 | `name="action_set_automated_probability"` (AI link, touch block) | DISABLE | crm (M2) | Predictive lead scoring, touch block (out of scope); an `<a>` is not disabled by the framework, so crm disables it offline. | JS42 |
| B13 | addons/crm/views/crm_lead_views.xml:170 | `<field name="partner_id" widget="res_partner_many2one"` (Create / Create and edit a contact) | DISABLE | framework (no Create option offline) | Creating a contact produces an id that a queued lead write would reference (an id produced by another call); offline the framework's autocomplete offers no Create. Picking an existing contact is saved by A16; the contact search itself is a framework read (Not classified). On small screens, offline, the lead form's relational fields use that autocomplete instead of the search dialog (crm patch, decision D22). | JS23 |
| B14 | addons/crm/views/crm_lead_views.xml:215 | `name="mail_action_blacklist_remove"` | DISABLE | framework (`<button>`) | Opens the mail.blacklist.remove wizard. | JS33 |
| B15 | addons/crm/views/crm_lead_views.xml:228 | `name="phone_action_blacklist_remove"` | DISABLE | framework (`<button>`) | Opens the phone.blacklist.remove wizard. | JS33 |
| B16 | addons/crm/views/crm_lead_views.xml:245 | `<field name="priority" widget="priority" nolabel="1"` (also :246, kanban cards :373, :546) | QUEUE | framework (opted-in stars, web_save) | Write on crm.lead, client-resolvable; queued. | JS34, JS63 |
| B17 | addons/crm/views/crm_lead_views.xml:248 | `<field name="tag_ids" widget="many2many_tags"` (pick existing tags) | QUEUE | framework (web_save) | Write on crm.lead (many2many commands with known ids); creating a tag is not offered offline. | JS34 |
| B18 | addons/crm/views/crm_lead_views.xml:248 | `'on_tag_click': 'edit_color'` (tag color) | DISABLE | framework (ColorList `<button>`) | Writes crm.tag, outside the queueable models. | rule shown by JS33 (framework: every `<button>` without the attribute) |
| B19 | addons/crm/views/crm_lead_views.xml:252 | `<field name="lead_properties" nolabel="1"` | DISABLE | framework (properties read-only offline) | Property values and definitions (definitions are written on crm.team) can't be edited offline. | JS69 (read-only offline, editable online) |
| B20 | addons/crm/views/crm_lead_views.xml:257 | `<field name="description" placeholder=` | QUEUE | framework (web_save) | Write on crm.lead (html); live collaboration is unavailable offline. | JS34 |
| B21 | addons/crm/views/crm_lead_views.xml:304 | `<chatter reload_on_post="True"/>` | DISABLE | crm (M2) | Messages, notes, followers, attachments and activity scheduling go through mail routes, uploads and wizards; KICKOFF defect 8: the chatter is read-only offline, with no uncaught error. | JS10 |
| B22 | addons/crm/views/crm_lead_views.xml:7 | `js_class="crm_form"` (New: create a lead) | QUEUE | framework (web_save [], vals) | Create on crm.lead with client-resolved values (defaults from the cached onchange); replay creates it. | JS34 |
| B23 | addons/crm/views/crm_lead_views.xml:7 | `js_class="crm_form"` (action menu: Archive / Unarchive) | QUEUE | framework (`action_archive` / `action_unarchive`) | Write on crm.lead with ids; Unarchive restores lost leads (C5). | JS34 |
| B24 | addons/crm/views/crm_lead_views.xml:7 | `js_class="crm_form"` (action menu: Delete) | QUEUE | framework (`web_unlink`) | Write on crm.lead with ids (C4). | JS34 |
| B25 | addons/crm/views/crm_lead_views.xml:7 | `js_class="crm_form"` (action menu: Duplicate) | DISABLE | crm (M2) + framework (greyed out) | The copy's id would come from another call; the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 |
| B26 | addons/crm/views/crm_lead_views.xml:680 | `<record id="action_lead_mail_compose" model="ir.actions.act_window">` (Send email, action menu) | DISABLE | crm (M2) + framework (greyed out) | mail.compose.message wizard; the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 (greyed items inert offline: shown with Duplicate, same guard for every item) |
| B27 | addons/crm/views/crm_lead_views.xml:692 | `<record id="action_lead_mass_mail" model="ir.actions.act_window">` (Send email, list/kanban action menu) | DISABLE | crm (M2) + framework (greyed out) | mail.compose.message wizard (mass mail); the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 (greyed items inert offline: shown with Duplicate, same guard for every item) |
| B28 | addons/crm/views/crm_lead_views.xml:1273 | `<record id="mail_followers_edit_action_from_lead" model="ir.actions.act_window">` | DISABLE | crm (M2) + framework (greyed out) | mail.followers.edit wizard; the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 (greyed items inert offline: shown with Duplicate, same guard for every item) |
| B29 | addons/crm/wizard/crm_lead_lost_views.xml:22 | `<record id="crm_lead_lost_action" model="ir.actions.act_window">` (Mark Lost, action menu) | DISABLE | crm (M2) + framework (greyed out) | crm.lead.lost wizard; the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 (greyed items inert offline: shown with Duplicate, same guard for every item) |
| B30 | addons/crm/wizard/crm_merge_opportunities_views.xml:41 | `<record id="action_merge_opportunities" model="ir.actions.act_window">` (Merge) | DISABLE | crm (M2) + framework (greyed out) | crm.merge.opportunity wizard (out of scope, destructive); the framework only greys the item (still selectable with the keyboard), crm blocks its selection offline. | JS44 (greyed items inert offline: shown with Duplicate, same guard for every item) |
| B31 | addons/crm/views/crm_lead_views.xml:324 | `<list string="Leads" sample="1" multi_edit="1" js_class="crm_list"` (cell and multi-record edit) | DISABLE | crm (M2) | List multi-edit and cell editing are not supported offline by the framework (ANSWERS): disabled offline, leads are edited from their form. | JS38 |
| B32 | addons/crm/views/crm_lead_views.xml:327 | `name="%(action_crm_send_mass_convert)d"` | DISABLE | framework (`<button>`) | Mass convert wizard (out of scope). | JS38 |
| B33 | addons/crm/views/crm_lead_views.xml:328 | `name="%(crm.crm_lead_lost_action)d" type="action" string="Mark Lost"` (leads list) | DISABLE | framework (`<button>`) | Opens the crm.lead.lost wizard (transient model). | JS38 |
| B34 | addons/crm/views/crm_lead_views.xml:713 | `<list string="Opportunities" sample="1" multi_edit="1" js_class="crm_list"` (cell and multi-record edit) | DISABLE | crm (M2) | List multi-edit and cell editing are not supported offline by the framework (ANSWERS): disabled offline. | JS38 |
| B35 | addons/crm/views/crm_lead_views.xml:716 | `name="%(crm.crm_lead_lost_action)d" type="action" string="Mark Lost"` (opportunities list) | DISABLE | framework (`<button>`) | Opens the crm.lead.lost wizard (transient model). | JS38 |
| B36 | addons/crm/views/crm_lead_views.xml:717 | `name="%(crm.action_lead_mass_mail)d"` | DISABLE | framework (`<button>`) | Mass mail wizard. | JS38 |
| B37 | addons/crm/views/crm_lead_views.xml:765 | `<widget name="mail_activity_mixin_list_reschedule_dropdown"/>` | DISABLE | framework (`<button>` toggler) | Every choice moves "my next activity", which the server picks at call time (it is not in the argument list), and today / tomorrow / next week are computed server-side; it goes through call_button. | JS38 |
| B38 | addons/crm/views/crm_lead_views.xml:766 | `name="%(crm.action_lead_mail_compose)d"` (row Email) | DISABLE | framework (`<button>`) | Mail composer wizard. | JS38 |
| B39 | addons/crm/views/crm_lead_views.xml:507 | `on_create="quick_create" quick_create_view="crm.quick_create_opportunity_form"` (kanban quick create) | QUEUE | framework (web_save [], vals) | Create on crm.lead with client-resolved values (defaults from the onchange cached online); queued and replayed. | JS37 |
| B40 | addons/crm/views/crm_lead_views.xml:412 | `<field name="partner_id"` (quick create contact field) | DISABLE | framework (Create hidden offline) | Creating a contact produces an id another queued write would need; picking an existing contact is A16/B13. | JS37 |
| B41 | addons/crm/views/crm_lead_views.xml:507 | `default_group_by="stage_id"` (column quick create: add a stage) | DISABLE | crm (M2) | crm.stage name_create whose id is used at once (column, fold, resequence): an id produced by another call. The add-column control is hidden offline. | JS36 |
| B42 | addons/crm/views/crm_lead_views.xml:507 | `default_group_by="stage_id"` (column settings: Edit stage) | DISABLE | framework (`<button>` toggler) | Stage configuration from the pipeline (ANSWERS); opens a crm.stage form dialog. | JS36 |
| B43 | addons/crm/views/crm_lead_views.xml:507 | `default_group_by="stage_id"` (column settings: Delete stage) | DISABLE | framework (`<button>` toggler) | Destructive admin action (ANSWERS: group deletes). | JS36 |
| B44 | addons/crm/views/crm_lead_views.xml:507 | `default_group_by="stage_id"` (drag columns: reorder stages) | DISABLE | crm (M2) | Stage reorder (ANSWERS); web_resequence has no offline fallback. Column drag is off offline. | JS36 |
| B45 | addons/crm/views/crm_lead_views.xml:509 | `"group_by_tooltip": {"requirements": "Description"}` (stage column tooltip) | SKIP | crm (M2) | Decorative tooltip (crm.stage read on hover); not read offline. | JS36 |
| B46 | addons/crm/views/crm_lead_views.xml:516 | `<progressbar field="activity_state"` (filter a column by activity state) | DISABLE | framework (bar inert to the pointer) + crm (M2) | A read with a new domain, never cached; the framework makes the bar inert to the pointer, crm short-circuits the bar and rotting filters offline. | JS36 |
| B47 | addons/crm/views/crm_lead_views.xml:521 | `<a role="menuitem" type="open" class="dropdown-item">Edit</a>` (card menu) | DISABLE | framework (`<button>` toggler) | Card menus are not supported offline (ANSWERS); the card itself opens the lead (B1). | JS36 |
| B48 | addons/crm/views/crm_lead_views.xml:522 | `<a role="menuitem" type="delete" class="dropdown-item">Delete</a>` (card menu) | DISABLE | framework (`<button>` toggler) | Card menu (ANSWERS); deleting stays available from the form's action menu (B24). | JS36 |
| B49 | addons/crm/views/crm_lead_views.xml:524 | `<field name="color" widget="kanban_color_picker"/>` (card menu) | DISABLE | framework (`<button>` toggler) | Card menu (ANSWERS). | JS36 |
| B50 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Schedule; also :374, list :735) | DISABLE | framework (`<button>` toggler) | mail.activity.schedule wizard; the popover reads its activities from /mail/store, never cached. Offline, activities are scheduled from the lead form instead (KICKOFF offline data coverage, milestone M3). | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B51 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Mark Done) | DISABLE | framework (`<button>` toggler) | The popover can't load offline (see B50); offline, an activity is marked done from the lead form instead (KICKOFF offline data coverage, milestone M3). | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B52 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Done & Schedule Next) | DISABLE | framework (`<button>` toggler) | Opens the schedule wizard (ANSWERS: DISABLE offline). | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B53 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Edit) | DISABLE | framework (`<button>` toggler) | mail.activity form dialog, never cached. | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B54 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Assign) | DISABLE | framework (`<button>` toggler) | The popover can't load offline (see B50). | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B55 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: Upload document) | DISABLE | framework (`<button>` toggler) | Needs the attachment id produced by the upload. | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B56 | addons/crm/views/crm_lead_views.xml:551 | `<field name="activity_ids" widget="kanban_activity"/>` (popover: mail activity) | DISABLE | framework (`<button>` toggler) | Mail composer wizard. | JS79 (the popover's `<button>` toggler disabled offline, enabled online) |
| B57 | addons/crm/views/crm_lead_views.xml:578 | `<attribute name="js_class">forecast_kanban</attribute>` (drag between months, quick create) | QUEUE | framework (web_save) | Write / create on crm.lead with client-resolvable values (date_deadline); the forecast itself is out of scope and only shown when cached. | JS39, JS64 |
| B58 | addons/crm/views/crm_lead_views.xml:393 | `js_class="crm_calendar"` (calendar view) | DISABLE | framework (view never available offline) | Calendar out of scope. | JS41 |
| B59 | addons/crm/views/crm_lead_views.xml:477 | `<activity string="Leads or Opportunities" js_class="crm_activity">` | DISABLE | framework (view never available offline) | Activity view out of scope (no disk cache). | JS41 |
| B60 | addons/crm/views/crm_lead_views.xml:843 | `<graph string="Opportunities" js_class="crm_graph" sample="1">` | DISABLE | framework (view never available offline) | Server-computed aggregates. | JS41 |
| B61 | addons/crm/views/crm_lead_views.xml:862 | `<graph string="Opportunities Forecast" sample="1" js_class="forecast_graph">` | DISABLE | framework (view never available offline) | Server-computed aggregates. | JS41 |
| B62 | addons/crm/views/crm_lead_views.xml:883 | `<pivot string="Pipeline Analysis" js_class="crm_pivot" sample="1">` | DISABLE | framework (view never available offline) | Server-computed aggregates. | JS41 |
| B63 | addons/crm/views/crm_lead_views.xml:904 | `<pivot string="Forecast Analysis" sample="1" js_class="forecast_pivot">` | DISABLE | framework (view never available offline) | Server-computed aggregates. | JS41 |
| B64 | addons/crm/report/crm_opportunity_report_views.xml:21 | `<pivot string="Pipeline Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B65 | addons/crm/report/crm_opportunity_report_views.xml:42 | `<pivot string="Leads Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B66 | addons/crm/report/crm_opportunity_report_views.xml:62 | `<graph string="Pipeline Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B67 | addons/crm/report/crm_opportunity_report_views.xml:83 | `<graph string="Leads Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B68 | addons/crm/report/crm_activity_report_views.xml:8 | `<graph string="Activities Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B69 | addons/crm/report/crm_activity_report_views.xml:19 | `<pivot string="Activities Analysis" sample="1">` | DISABLE | framework (view never available offline) | Server-computed report. | JS41 |
| B70 | addons/crm/report/crm_activity_report_views.xml:31 | `action="action_open_lead"` (activities report list, row click) | DISABLE | crm data (M2) | Row click calls `action_open_lead` through call_button. crm opts the activity report actions out of the offline cache, so the report is unavailable offline (its menu is disabled). | PY10, JS41 |
| B71 | addons/crm/views/crm_team_views.xml:144 | `name="action_assign_leads"` (team form) | DISABLE | framework (`<button>`) | Server-side batch assignment over a domain, no client-resolvable result. | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B72 | addons/crm/views/crm_team_views.xml:206 | `name="action_open_opportunities"` (team stat button) | DISABLE | framework (`<button>`) | Navigation built by a server call. | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B73 | addons/crm/views/crm_team_views.xml:252 | `<record id="sales_team.crm_team_action_pipeline" model="ir.actions.act_window">` (Teams dashboard: card click and every link) | DISABLE | crm data (M2) | Manager overview built from server reads; its links and card click are `<a>` / div actions the framework doesn't disable. crm opts this action out of the offline cache, so the dashboard is unavailable offline. | PY10 |
| B74 | addons/crm/views/crm_team_views.xml:277 | `name="action_open_unassigned_opportunities"` (dashboard `<a type="object">`) | DISABLE | crm data (M2) | On the Teams dashboard, unavailable offline (B73). | PY10 |
| B75 | addons/crm/views/crm_team_views.xml:287 | `name="%(crm_case_form_view_salesteams_lead)d"` (dashboard Leads) | DISABLE | crm data (M2) | On the Teams dashboard, unavailable offline (B73). | PY10 |
| B76 | addons/crm/views/crm_team_views.xml:292 | `name="%(crm_case_form_view_salesteams_opportunity)d"` (dashboard Opportunities) | DISABLE | crm data (M2) | On the Teams dashboard, unavailable offline (B73). | PY10 |
| B77 | addons/crm/views/crm_team_views.xml:303 | `name="%(crm_lead_action_open_lead_form)d"` (dashboard New Lead) | DISABLE | crm data (M2) | On the Teams dashboard, unavailable offline (B73); offline, leads are created from the pipeline (B39, and the mobile quick create of milestone M4). | PY10 |
| B78 | addons/crm/views/crm_team_views.xml:308 | `name="%(action_opportunity_form)d"` (dashboard New Opportunity) | DISABLE | crm data (M2) | On the Teams dashboard, unavailable offline (B73). | PY10 |
| B79 | addons/crm/views/crm_team_views.xml:319 | `name="%(action_report_crm_lead_salesteam)d"` (dashboard report) | DISABLE | crm data (M2) | Server-computed report on the Teams dashboard (B73). | PY10 |
| B80 | addons/crm/views/crm_team_views.xml:324 | `name="%(action_report_crm_opportunity_salesteam)d"` (dashboard report) | DISABLE | crm data (M2) | Server-computed report on the Teams dashboard (B73). | PY10 |
| B81 | addons/crm/views/crm_team_views.xml:332 | `name="%(crm.crm_activity_report_action_team)d"` (dashboard report) | DISABLE | crm data (M2) | Server-computed report on the Teams dashboard (B73). | PY10 |
| B82 | addons/crm/views/crm_stage_views.xml:22 | `<list string="Stages" multi_edit="1" js_class="crm_stage_list">` (cell and multi-record edit) | DISABLE | crm (M2) | List multi-edit and cell editing (ANSWERS); stages are edited from their form (B84). | JS43 |
| B83 | addons/crm/views/crm_stage_views.xml:23 | `<field name="sequence" widget="handle"/>` (reorder stages) | DISABLE | crm (M2) | Stage reorder (ANSWERS); web_resequence has no offline fallback. | JS43 |
| B84 | addons/crm/views/crm_stage_views.xml:37 | `<form string="Stage">` (save) | QUEUE | framework (web_save) | Write on crm.stage, client-resolvable; its only onchange is an advisory warning. | JS59 |
| B85 | addons/crm/views/crm_lost_reason_views.xml:22 | `name="action_lost_leads"` (lost reason stat button) | DISABLE | framework (`<button>`) | Navigation built by a server call. | PY10 (its screen, Lost Reasons, is never available offline) |
| B86 | addons/crm/views/crm_lost_reason_views.xml:49 | `<list string="Channel" editable="bottom">` (lost reasons) | DISABLE | crm data (M2) | Writes crm.lost.reason, outside the queueable models; crm opts the Lost Reasons action out of the offline cache, so it is unavailable offline. | PY10 |
| B87 | addons/crm/views/crm_recurring_plan_views.xml:8 | `<list editable="bottom">` (recurring plans) | DISABLE | crm data (M2) | Writes crm.recurring.plan, outside the queueable models; action opted out of the offline cache. | PY10 |
| B88 | addons/crm/views/crm_recurring_plan_views.xml:9 | `<field name="sequence" widget="handle"/>` (reorder plans) | DISABLE | crm data (M2) | Same view as B87. | PY10 |
| B89 | addons/crm/views/res_partner_views.xml:12 | `type="object"` (partner Opportunities stat button) | DISABLE | framework (`<button>`) | Navigation built by a server call. | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B90 | addons/crm/views/utm_campaign_views.xml:19 | `name="action_redirect_to_leads_opportunities"` (campaign kanban `<a type="object">`) | DISABLE | crm (M2) | Navigation built by a server call; an `<a>` is not disabled by the framework, so crm disables it offline. | JS42 |
| B91 | addons/crm/views/utm_campaign_views.xml:36 | `<button name="action_redirect_to_leads_opportunities"` (campaign form) | DISABLE | framework (`<button>`) | Navigation built by a server call. | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B92 | addons/crm/views/res_config_settings_views.xml:16 | `name="crm.crm_recurring_plan_action"` (settings) | DISABLE | framework (`<button>`) | Settings form (transient model). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B93 | addons/crm/views/res_config_settings_views.xml:47 | `name="%(crm_lead_pls_update_action)d"` (Update Probabilities) | DISABLE | framework (`<button>`) | PLS update wizard (out of scope). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B94 | addons/crm/views/res_config_settings_views.xml:64 | `name="action_crm_assign_leads"` (assign now) | DISABLE | framework (`<button>`) | Settings + server batch assignment. | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B95 | addons/crm/views/res_config_settings_views.xml:14 | `<field name="group_use_recurring_revenues"/>` (CRM settings, applied by Save) | DISABLE | framework (`<button>` Save) | Group changes, crons, module installs including paid IAP services. | rule shown by JS33 (framework: every `<button>` without the attribute) |
| B96 | addons/crm/wizard/crm_lead_lost_views.xml:15 | `name="action_lost_reason_apply"` | DISABLE | framework (`<button>`) | Lost wizard (transient model; only opened from disabled controls). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B97 | addons/crm/wizard/crm_lead_lost_views.xml:16 | `special="cancel"` (Lost wizard) | DISABLE | framework | Part of the wizard, which can't open offline. | unreachable: its wizard's opener is disabled offline (JS33) |
| B98 | addons/crm/wizard/crm_lead_pls_update_views.xml:18 | `name="action_update_crm_lead_probabilities"` | DISABLE | framework (`<button>`) | PLS wizard (out of scope). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| B99 | addons/crm/wizard/crm_lead_pls_update_views.xml:20 | `special="cancel"` (PLS wizard) | DISABLE | framework | Part of the wizard, which can't open offline. | unreachable: its wizard's opener is disabled offline (JS33) |
| B100 | addons/crm/wizard/crm_lead_to_opportunity_mass_views.xml:55 | `name="action_apply"` (mass convert) | DISABLE | framework (`<button>`) | Mass convert wizard (out of scope). | unreachable: its wizard's opener is disabled offline (JS38, JS44) |
| B101 | addons/crm/wizard/crm_lead_to_opportunity_mass_views.xml:56 | `special="cancel"` (mass convert wizard) | DISABLE | framework | Part of the wizard, which can't open offline. | unreachable: its wizard's opener is disabled offline (JS38, JS44) |
| B102 | addons/crm/wizard/crm_merge_opportunities_views.xml:34 | `name="action_merge"` | DISABLE | framework (`<button>`) | Merge wizard (out of scope, destructive). | unreachable: its wizard's opener is disabled offline (JS38, JS44) |
| B103 | addons/crm/wizard/crm_merge_opportunities_views.xml:35 | `special="cancel"` (merge wizard) | DISABLE | framework | Part of the wizard, which can't open offline. | unreachable: its wizard's opener is disabled offline (JS38, JS44) |
| B104 | addons/crm/static/src/components/team_switcher/team_switcher.xml:6 | `<button class="o_cp_team_switcher` (team switcher toggler) | DISABLE | crm (M2) | KICKOFF defect 3: dropdown disabled offline (explicitly, not only by the framework). | JS05 |
| B105 | addons/crm/static/src/components/team_switcher/team_switcher.xml:12 | `onSelected="() => this.onSelect()"` (All Teams) | DISABLE | crm (M2) | Switching team needs a reload with a domain that is not cached (A14): disabled offline. | JS05 |
| B106 | addons/crm/static/src/components/team_switcher/team_switcher.xml:16 | `onSelected="() => this.onSelect(team.id)"` (one per team) | DISABLE | crm (M2) | Switching team needs a reload with a domain that is not cached (A14): disabled offline. | JS05 |
| B107 | addons/crm/static/src/components/team_switcher/team_switcher.xml:23 | `onSelected="() => this.onClickManageTeams()"` (Manage Teams) | DISABLE | crm (M2) | Navigation to team configuration (A13): unreachable offline. | JS05 |
| B108 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.xml:5 | `<button t-on-click="this.toggleDropdown" accesskey="c"` (Generate) | DISABLE | crm (M2) | KICKOFF defect 4. | JS06 |
| B109 | addons/crm/static/src/components/lead_generation_dropdown/lead_generation_dropdown.xml:16 | `onSelected="() => this.onClickAction(element)"` (Generate choices) | DISABLE | crm (M2) | Install, mail plugins, import, access request (A3-A11). | JS06 |
| B110 | addons/crm/static/src/components/promote_mail_plugins_dialog/promote_mail_plugins_dialog.xml:17 | `href=` (documentation, video and marketplace links) | DISABLE | crm (M2) | External content; the dialog is only reachable from the disabled Generate dropdown. | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| B111 | addons/crm/static/src/views/crm_form/crm_pls_tooltip_button.xml:4 | `<button t-attf-class="o_crm_pls_tooltip_button` | DISABLE | crm (M2) | KICKOFF defect 6. | JS08 |
| B112 | addons/crm/static/src/views/crm_form/crm_pls_tooltip_button.xml:70 | `<a role="button" class="ms-2 btn-link"` (Learn More) | DISABLE | crm (M2) | External documentation inside the PLS tooltip, which can't open offline. | JS08 (inside the tooltip: can't open offline, closes when the connection drops) |
| B113 | addons/crm/static/src/views/forecast_kanban/forecast_kanban_renderer.xml:6 | `<ForecastKanbanColumnQuickCreate` | DISABLE | crm (M2) | The forecast's add-period column (A25, a read never cached) is hidden offline. | JS39 |
| B114 | addons/crm/static/src/webclient/share_target/crm_share_target_item.xml:8 | `<Field id="'team'" name="'team'"` (Share to Lead: team) | DISABLE | crm (M2) | Share to Lead needs an upload and an id produced by another call (A27): disabled offline. | JS40 |
| B115 | addons/crm/views/crm_lead_views.xml:779 | `<attribute name="js_class">forecast_list</attribute>` (cell and multi-record edit, inherited from the opportunities list) | DISABLE | crm (M2) | List multi-edit and cell editing are not supported offline by the framework (ANSWERS): the forecast list uses the crm list model, read-only offline. | JS48 |
| B116 | addons/crm/views/crm_team_member_views.xml:69 | `<record id="sales_team.crm_team_member_action" model="ir.actions.act_window">` (Teams Members screen) | DISABLE | crm data (M2) | Writes crm.team.member, outside the queueable models; crm opts this action out of the offline cache, so the screen is unavailable offline. | PY10 |
| B117 | addons/crm/views/crm_team_member_views.xml:4 | `<record id="crm_team_member_view_tree" model="ir.ui.view">` (member assignment settings) | DISABLE | crm data (M2) | Writes crm.team.member; only reachable through B116, unavailable offline. | PY10 |
| B118 | addons/crm/views/crm_team_member_views.xml:56 | `widget="domain"` (member assignment domains) | DISABLE | crm data (M2) | Domain editors writing crm.team.member; only reachable through B116, unavailable offline. | PY10 |
| B119 | addons/crm/views/mail_activity_views.xml:3 | `<record id="sales_team.mail_activity_type_action_config_sales" model="ir.actions.act_window">` (Activity Types) | DISABLE | crm data (M2) | Writes mail.activity.type, outside the queueable models; action opted out of the offline cache, so the screen is unavailable offline. | PY10 |
| B120 | addons/crm/views/mail_activity_plan_views.xml:4 | `<record id="mail_activity_plan_action_lead" model="ir.actions.act_window">` (Activity Plans) | DISABLE | crm data (M2) | Writes mail.activity.plan, outside the queueable models; action opted out of the offline cache, so the screen is unavailable offline. | PY10 |

## C. Public methods reachable from a button (crm.lead, crm.stage, crm.team)

| # | File:line | Call | Class | Enforced by | Justification | Test |
|---|---|---|---|---|---|---|
| C1 | addons/crm/models/crm_lead.py:729 | `def create(self, vals_list):` (New, quick create) | QUEUE | framework (web_save [], vals) | Create with client-resolved values; replay creates the lead (no id remapping needed: nothing else references it offline). | JS34, JS37 |
| C2 | addons/crm/models/crm_lead.py:760 | `def write(self, vals):` (every lead save, stage move, priority) | QUEUE | framework (web_save) | Client-resolvable writes; replayed in timestamp order, last write wins. | JS03, JS15, PY01 |
| C3 | addons/crm/models/crm_lead.py:954 | `def copy_data(self, default=None):` (Duplicate) | DISABLE | crm (M2) + framework (greyed out) | The copy's id would come from another call; the item is only greyed by the framework, crm blocks its selection offline. | JS44 |
| C4 | addons/crm/models/crm_lead.py:971 | `def unlink(self):` (action menu Delete) | QUEUE | framework (web_unlink) | Write on crm.lead with known ids. | JS34 |
| C5 | addons/crm/models/crm_lead.py:1031 | `def action_unarchive(self):` (action menu Unarchive: restores lost leads) | QUEUE | framework (action_unarchive) | Write on crm.lead with known ids. | JS34 |
| C6 | addons/crm/models/crm_lead.py:1042 | `def action_restore(self):` (Restore) | QUEUE | crm (M3) | Args [[id]]; queued by the crm form offline (B4). | JS35 |
| C7 | addons/crm/models/crm_lead.py:1051 | `def action_set_lost(self, **additional_values):` | DISABLE | framework | Only reachable through the Lost wizard (transient model, out of scope). | JS33 |
| C8 | addons/crm/models/crm_lead.py:1057 | `def action_set_won(self):` | QUEUE | crm (M3) | What the Won button queues offline (args [[id]]); the won stage is picked server-side at replay. | JS11, PY02 |
| C9 | addons/crm/models/crm_lead.py:1083 | `def action_set_automated_probability(self):` | DISABLE | crm (M2) | Predictive lead scoring (out of scope); B9, B12. | JS42 |
| C10 | addons/crm/models/crm_lead.py:1089 | `def action_set_won_rainbowman(self):` | QUEUE | crm (M3) | Won online; offline its write part is queued as C8 and its rainbowman part skipped (A15). | JS11, JS12 |
| C11 | addons/crm/models/crm_lead.py:1105 | `def get_rainbowman_message(self):` | SKIP | crm (M2) | Decorative effect lookup (A15). | JS01, JS02 |
| C12 | addons/crm/models/crm_lead.py:1197 | `def action_schedule_meeting(self, smart_calendar=True):` | DISABLE | framework (`<button>`) | Calendar navigation (B7). | JS33 |
| C13 | addons/crm/models/crm_lead.py:1330 | `def action_show_potential_duplicates(self):` | DISABLE | framework (`<button>`) | Navigation built by a server call (B8). | JS33 |
| C14 | addons/crm/models/crm_lead.py:1343 | `def action_convert_to_opportunity(self):` | DISABLE | framework (`<button>`) | May create a res.partner (outside the queueable models) and matches partners server-side (B3). | JS33 |
| C15 | addons/crm/models/crm_lead.py:1528 | `def merge_opportunity(self, user_id=False, team_id=False, auto_unlink=True):` | DISABLE | framework | Only reached through the merge and mass convert wizards. | JS38 |
| C16 | addons/crm/models/crm_lead.py:1854 | `def convert_opportunity(self, partner, user_ids=False, team_id=False):` | DISABLE | framework | Takes a res.partner recordset (not replayable as JSON); reached through C14 and the mass convert wizard. | JS33 |
| C17 | addons/crm/models/crm_lead.py:2170 | `def get_import_templates(self):` | DISABLE | crm (M2) | CSV import (A10). | JS06 (inside Generate: can't open offline, closes when the connection drops) |
| C18 | addons/crm/models/crm_lead.py:2817 | `def prepare_pls_tooltip_data(self):` | DISABLE | crm (M2) | Predictive lead scoring (A19). | JS08 |
| C19 | addons/crm/models/crm_stage.py:70 | `def write(self, vals):` (stage form save) | QUEUE | framework (web_save) | Write on crm.stage, client-resolvable (B84). | JS59 |
| C20 | addons/crm/models/crm_team.py:120 | `def write(self, vals):` (team form save) | QUEUE | framework (web_save) | Write on crm.team, client-resolvable. | JS60 |
| C21 | addons/crm/models/crm_team.py:131 | `def unlink(self):` (team Delete) | DISABLE | crm (M2) | Destructive admin action (ANSWERS); crm makes Delete unavailable offline for crm.team (and for crm.stage). | JS43 |
| C22 | addons/crm/models/crm_team.py:211 | `def action_assign_leads(self):` | DISABLE | framework (`<button>`) | Server-side batch assignment (B71, B94). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| C23 | addons/crm/models/crm_team.py:762 | `def action_open_opportunities(self):` | DISABLE | framework (`<button>`) | Navigation built by a server call (B72). | PY15 (a `<button>` without the attribute in the shipped arch); rule shown by JS33 |
| C24 | addons/crm/models/crm_team.py:770 | `def action_open_unassigned_opportunities(self):` | DISABLE | crm data (M2) | Teams dashboard, unavailable offline (B73, B74). | PY10 |
| C25 | addons/crm/models/crm_team.py:783 | `def action_primary_channel_button(self):` (Teams dashboard card click) | DISABLE | crm data (M2) | Teams dashboard, unavailable offline (B73). | PY10 |
| C26 | addons/crm/models/crm_team.py:794 | `def get_team_switcher_data(self):` | DISABLE | crm (M2) + framework (RPC disk cache) | Feeds the team switcher, disabled offline (A24); answered from the framework's RPC disk cache. | JS05 |
| C27 | addons/crm/models/mail_activity.py:26 | `def action_create_calendar_event(self):` | DISABLE | framework (`<button>`) | calendar.event is out of scope; the buttons that reach it (activity form, meeting activities in the chatter) are `<button>`s disabled offline, and the lead chatter is read-only offline (B21). | JS10 (the chatter's activity buttons are disabled offline) |

## D. Entry points added by this work

Added with milestones M3 to M5 (activities offline, mobile quick create, offline mark won and
restore, the lead properties' access probe); each is listed here with its class when it lands.

| # | File:line | Call | Class | Enforced by | Justification | Test |
|---|---|---|---|---|---|---|
| D1 | addons/crm/static/src/views/crm_form/crm_form.js:108 | `this._scheduleOffline("action_set_won");` (Won, offline) | QUEUE | crm (M3) | Write on crm.lead with its id only: `action_set_won` picks the won stage of the lead's team at replay. The form shows the lead won at once; no rainbowman (it would show detached from the action). A lead created offline has no id yet: Won stays disabled offline on it (`data-crm-offline-needs-id`, decision D24). | JS11, JS55, JS66, PY02 |
| D2 | addons/crm/static/src/views/crm_form/crm_form.js:117 | `this._scheduleOffline("action_restore");` (Restore, offline) | QUEUE | crm (M3) | Write on crm.lead with its id only; the form shows the lead as not lost at once (probability back to the automated one). | JS35, JS65, JS66 |
| D3 | addons/crm/static/src/mobile/offline_activities/offline_activities.js:179 | `schedule() {` (offline activity panel: Schedule) | QUEUE | crm (M3) | A lead's mail.activity create with a fully client-resolved argument list (model name, record id, type, summary, deadline, assignee); the type comes from the activity types cached online, and with none cached the control is disabled. Meeting types are not offered (a calendar event is unreachable offline). Shown at once as pending sync. | JS18, JS19, JS67, PY03 |
| D4 | addons/crm/static/src/mobile/offline_activities/offline_activities.js:202 | `logCall() {` (offline activity panel: Log a call) | QUEUE | crm (M3) | One crm.lead call with the lead's id and the call summary (D6); shown at once as pending sync. | JS21, PY05 |
| D5 | addons/crm/static/src/mobile/offline_activities/offline_activities.js:217 | `markDone(activity) {` (offline activity panel: Mark done) | QUEUE | crm (M3) | `mail.activity.action_done` with the activity's id: only the state change; the activity shows "Done · Pending sync". | JS20, PY04 |
| D6 | addons/crm/models/crm_lead.py:1299 | `def action_log_call(self, summary=False, feedback=False):` | QUEUE | crm (M3) | Public method added for D4: creates a Call activity on each lead and marks it done in one call, as the user (no sudo: access rights apply). Replayed verbatim from the queue. | JS21, PY05 |
| D7 | addons/crm/models/mail_activity.py:11 | `def create(self, vals_list):` (mail.activity, crm side) | QUEUE | crm (M3) | Receives D3's create: resolves the model name crm.lead to its ir.model id on the server, so the client needs no id produced by another call. Other models are untouched. | PY03 |
| D8 | addons/crm/static/src/mobile/mobile_pipeline/mobile_pipeline.js:225 | `this.crmOffline.scheduleCall("crm.lead", "create", [[values]], { context }, {` (small-screen quick create, bottom sheet) | QUEUE | crm (M4) | Create on crm.lead with exactly the six values captured (name, contact name, phone, email, expected revenue, stage) and the pipeline's defaults in the context; online it is `orm.create` (line 206). Shown at once in its stage as a pending card; once replayed, the stage reloads with the real lead. No contact picker (ANSWERS: contact name is free text). | JS28, JS29, JS30, PY06 |
| D9 | addons/crm/static/src/mobile/mobile_pipeline/mobile_pipeline.js:157 | `await group.toggle();` (small-screen pipeline: a folded stage shown) | DISABLE | crm (M4) + framework (RPC disk cache) | Reads the stage's leads: answered from the framework's cache when loaded online; a stage never loaded online is unavailable offline: the offline action helper is shown instead, and the stage loads once the connection is back. | JS26 |
| D10 | addons/crm/static/src/mobile/mobile_pipeline/mobile_pipeline.js:182 | `return list.load({ limit:` (small-screen pipeline: Load more) | DISABLE | framework (`<button>`) | Reads more leads of the stage than were loaded online (never cached): the button has no offline-availability attribute. | JS78; rule shown by JS33 (framework: every `<button>` without the attribute) |
| D11 | addons/crm/static/src/views/crm_form/properties_field_patch.js:16 | `return await super.checkDefinitionWriteAccess(...arguments);` (web's properties field on the lead form: `user.checkAccessRight("crm.team", "write")` for the definition) | SKIP | framework (read-only offline: no probe) + crm (M5) | An access probe that only toggles the editing of the property definitions. Offline the field is read-only, so the probe isn't sent; for a lead, a probe lost with the connection (a late answer can mark the app online while the network is down) counts as no access: no uncaught error, which web's user cache would otherwise re-throw at each reconnection, switching the app offline again and again (decision D27). | JS69, PY09 |

The offline activity panel's reads (the lead's activities and the activity types,
`offline_activities.js:134`) and the small-screen relational search of the lead form (decision D22)
are reads answered by the framework's caches: see "Not classified".

## Not classified

- Menus in `views/crm_menu_views.xml` are navigation, not calls or buttons: offline the framework's
  navbar disables a menu unless a view of its action was loaded online (then it opens that cached
  view). The actions crm opts out of the offline cache (B70, B73, B86, B87, B116, B119, B120) are
  never available offline, so their menus are always disabled offline.
- Relational-field searches (the lead's contact, salesperson with crm's context from
  `many2one_avatar_leader_user.js:15`, tags) are the framework's Many2XAutocomplete reads: offline it
  still sends web_name_search, swallows the connection error and answers from its relational-field
  (many2x) cache, without Create / Search More. On small screens the framework opens a search dialog
  instead, which can't search offline: offline, the lead form's relational fields use the
  autocomplete there too (crm patch of Many2XAutocomplete, scoped to the lead form, decision D22). With partner_autocomplete installed, the contact
  field also tries its IAP lookup (`res.partner.autocomplete_by_field`) and swallows the failure;
  crm can't change that module (not a dependency). Known limit (ANSWERS: the call fails silently and
  cached results still show).
- Configuration of other apps reached from CRM menus keeps their own offline behavior: Tags
  (`sales_team.sales_team_crm_tag_action`, crm.tag) and Customers (`base.action_partner_form`,
  res.partner) are shared with Sales and Contacts, so crm does not change them; once visited online,
  the framework queues their saves. Known limit.
- The offline activity panel (D3 to D5) reads the lead's activities and the activity types through
  the framework's RPC disk cache (`orm.cache({ type: "disk" })`): refreshed whenever the lead form
  loads online, read from memory once offline. A lead whose panel never loaded online lists no
  activity and offers no Schedule (no cached type); Log a call still works.
- View data loads (pipeline, lists, forms, forecast) go through the framework's RelationalModel and
  its RPC disk cache; a view never loaded online shows the offline action helper.
- Client-only checks with no server call: `user.isAdmin` in lead_generation_dropdown.js; the team
  facet kept by `CrmSearchModel.applySearch` / `getCurrentSearch` (crm_search_model.js:218, :236).
- Public crm.lead methods with no UI caller: `action_reschedule_meeting`,
  `redirect_lead_opportunity_view`, `log_meeting` (called server-side on calendar.event create),
  `message_new` (mail gateway); `search_fetch` and `get_empty_list_help` (read path of the views).
- E-mail link routes in controllers/main.py (`/lead/case_mark_won`, `/lead/case_mark_lost`,
  `/lead/convert`) are outside `/odoo` and not used by the web client.

## Tests

The ids in the Test column above, as they landed (test id, file, name, JS presets it runs
under; "server" for Python).

| Test | File | Name | Presets |
|---|---|---|---|
| JS01 | static/tests/crm_offline_form.test.js | [Offline] a stage change saved offline completes without the rainbowman lookup | desktop, mobile |
| JS02 | static/tests/crm_offline_form.test.js | [Online] a stage change saved online still looks up the rainbowman | desktop, mobile |
| JS03 | static/tests/crm_offline_form.test.js | [Offline] the queued save carries the email and phone force-saved for partner sync | desktop, mobile |
| JS04 | static/tests/crm_offline_kanban.test.js | [Offline] dragging a lead to another stage queues its save, with no rainbowman lookup | desktop |
| JS05 | static/tests/crm_offline_controls.test.js | [Offline] team switcher: no group probe, dropdown disabled, Manage Teams unreachable, team kept as a facet | desktop, mobile |
| JS06 | static/tests/crm_offline_controls.test.js | [Offline] lead generation: Generate is disabled offline, with no module lookup or access probe | desktop, mobile |
| JS07 | static/tests/crm_offline_kanban.test.js | [Offline] the recurring-revenue aggregate is not probed offline and is hidden | desktop, mobile |
| JS08 | static/tests/crm_offline_form.test.js | [Offline] the predictive-scoring tooltip button is disabled offline, with no lookup | desktop, mobile |
| JS09 | static/tests/crm_offline_mail.test.js | [Offline] the CRM entry of the activity menu is disabled offline | desktop, mobile |
| JS10 | static/tests/crm_offline_mail.test.js | [Offline] the lead chatter is read-only offline, with no uncaught error | desktop, mobile |
| JS33 | static/tests/crm_offline_form.test.js | [Offline] lead form buttons that need the server are disabled offline, enabled online | desktop |
| JS36 | static/tests/crm_offline_kanban.test.js | [Offline] pipeline: stage configuration, card menus, progress bar and stage tooltip are unavailable | desktop |
| JS38 | static/tests/crm_offline_controls.test.js | [Offline] lead lists: no cell or multi-record editing, server buttons disabled | desktop |
| JS39 | static/tests/crm_offline_kanban.test.js | [Offline] forecast: the next-period column is hidden offline, moves between periods are queued | desktop |
| JS40 | static/tests/crm_offline_controls.test.js | [Offline] Share to Lead is disabled offline and reads no teams | desktop, mobile |
| JS41 | static/tests/crm_offline_controls.test.js | [Offline] calendar, graph and pivot views are not available offline | desktop |
| JS42 | static/tests/crm_offline_form.test.js | [Offline] <a> view buttons marked data-crm-offline-disable are disabled and unreachable | desktop, mobile |
| JS43 | static/tests/crm_offline_controls.test.js | [Offline] stages and teams: stage list read-only, no reorder, no delete offline | desktop |
| JS44 | static/tests/crm_offline_controls.test.js | [Offline] action menu items the framework greys out can't be run offline, even from the keyboard | desktop |
| JS45 | static/tests/crm_offline_form.test.js | [Offline] after a partner change offline, the stale sync flags force-save nothing | desktop |
| JS46 | static/tests/crm_offline_form.test.js | [Online] after a partner change online, the sync flags still force-save | desktop |
| JS47 | static/tests/crm_offline_kanban.test.js | [Online] dragging a lead to the won stage still looks up the rainbowman | desktop |
| JS48 | static/tests/crm_offline_controls.test.js | [Offline] the forecast list is not editable offline either | desktop |
| PY01 | tests/test_crm_offline.py | TestCrmOffline.test_offline_edit_write_matches_online | server |
| PY10 | tests/test_crm_offline.py | TestCrmOffline.test_offline_wiring_and_unavailable_actions | server |
| PY11 | tests/test_crm_offline.py | TestCrmOffline.test_offline_markers_in_crm_archs | server |
| PY12 | tests/test_crm_offline.py | TestCrmOffline.test_offline_partner_change_write_matches_online | server |
| JS11 | static/tests/crm_offline_form.test.js | [Offline] mark won queues action_set_won and shows the lead as won at once, without the rainbowman | desktop, mobile |
| JS12 | static/tests/crm_offline_form.test.js | [Online] mark won still calls the server button and shows the rainbowman | desktop, mobile |
| JS13 | static/tests/crm_offline_form.test.js | [Offline] a lead never opened online shows the offline action helper, then opens once online | desktop, mobile |
| JS13 | static/tests/crm_offline_form.test.js | [Offline] the pager skips the leads never opened online | desktop, mobile |
| JS14 | static/tests/crm_offline_form.test.js | [Offline] a stage move from the stage bar is saved offline (queued web_save) | desktop, mobile |
| JS15 | static/tests/crm_offline_queue.test.js | [Offline] two offline writes to one lead replay in order, the later one wins, no conflict dialog | desktop, mobile |
| JS16 | static/tests/crm_offline_queue.test.js | [Offline] a rejected replay is parked in the offline systray with its error, no CRM error UI | desktop, mobile |
| JS17 | static/tests/crm_offline_queue.test.js | [Offline] the offline systray labels the calls crm queues | desktop, mobile |
| JS18 | static/tests/crm_offline_activities.test.js | [Offline] schedule an activity: one queued create with client-resolved values, shown as pending sync | desktop, mobile |
| JS19 | static/tests/crm_offline_activities.test.js | [Offline] no activity type was cached: Schedule is disabled, not an empty picker | desktop, mobile |
| JS20 | static/tests/crm_offline_activities.test.js | [Offline] mark an activity done: only action_done is queued, shown done and pending sync | desktop, mobile |
| JS21 | static/tests/crm_offline_activities.test.js | [Offline] log a call: one queued crm.lead call, listed as pending sync | desktop, mobile |
| JS22 | static/tests/crm_offline_activities.test.js | [Online] the offline activity panel renders nothing online and keeps its data cached | desktop, mobile |
| JS23 | static/tests/crm_offline_partner.test.js | [Offline] the lead's contact search answers from the relational-field cache, without Create | desktop, mobile |
| JS34 | static/tests/crm_offline_queue.test.js | [Offline] lead edits (priority, contact, tags, description) are queued as one web_save and replayed | desktop, mobile |
| JS34 | static/tests/crm_offline_queue.test.js | [Offline] a lead created with New offline is queued without an id and created on replay | desktop, mobile |
| JS34 | static/tests/crm_offline_queue.test.js | [Offline] Archive from the lead form's action menu is queued and replayed | desktop, mobile |
| JS34 | static/tests/crm_offline_queue.test.js | [Offline] Unarchive of a lost lead from the action menu is queued and replayed | desktop, mobile |
| JS34 | static/tests/crm_offline_queue.test.js | [Offline] Delete from the lead form's action menu is queued and replayed | desktop, mobile |
| JS35 | static/tests/crm_offline_form.test.js | [Offline] restore a lost lead: action_restore queued, shown as not lost at once | desktop, mobile |
| JS37 | static/tests/crm_offline_kanban.test.js | [Offline] a lead quick-created offline is queued in its column's stage and replayed; no contact creation | desktop, mobile |
| JS49 | static/tests/crm_offline_form.test.js | [Offline] after a partner change made online, an offline save keeps the force-saved values | desktop |
| JS50 | static/tests/crm_offline_controls.test.js | [Offline] lead form cog menu: Duplicate can't be run offline, Delete still can | desktop, mobile |
| JS51 | static/tests/crm_offline_controls.test.js | [Offline] unsaved lead cog menu: the framework greys every item, crm makes them inert | desktop, mobile |
| JS52 | static/tests/crm_offline_controls.test.js | [Offline] stage form cog menu: Delete can't be run offline | desktop, mobile |
| JS53 | static/tests/crm_offline_kanban.test.js | [Offline] the rotting badge of a column doesn't filter it offline | desktop, mobile |
| JS54 | static/tests/crm_offline_mail.test.js | [Offline] files dropped on the lead chatter aren't uploaded offline | desktop, mobile |
| JS55 | static/tests/crm_offline_form.test.js | [Offline] a lead created offline (no id yet) can't be marked won offline | desktop, mobile |
| JS56 | static/tests/crm_offline_form.test.js | [Online] the lead stage bar keeps the layout of mail's stage bar | desktop, mobile |
| JS57 | static/tests/crm_offline_partner.test.js | [Online] the lead's contact search offers Create and Search more online | desktop, mobile |
| JS58 | static/tests/crm_offline_partner.test.js | [Offline] on a small screen, the lead's relational fields search the cache only while offline | mobile |
| JS59 | static/tests/crm_offline_controls.test.js | [Offline] a crm.stage form save is queued and replayed | desktop, mobile |
| JS60 | static/tests/crm_offline_controls.test.js | [Offline] a crm.team form save is queued and replayed | desktop, mobile |
| PY02 | tests/test_crm_offline.py | TestCrmOffline.test_offline_mark_won_replay | server |
| PY03 | tests/test_crm_offline.py | TestCrmOffline.test_offline_activity_create_replay | server |
| PY04 | tests/test_crm_offline.py | TestCrmOffline.test_offline_activity_done_replay | server |
| PY05 | tests/test_crm_offline.py | TestCrmOffline.test_offline_log_call_replay | server |
| JS24 | static/tests/crm_mobile_pipeline.test.js | [Mobile] the pipeline shows one stage at a time, with its name, lead count and revenue | mobile |
| JS25 | static/tests/crm_mobile_pipeline.test.js | [Mobile] previous / next buttons and horizontal swipes move to the adjacent stages | mobile |
| JS26 | static/tests/crm_mobile_pipeline.test.js | [Offline] [Mobile] a stage loaded online renders offline, a stage never loaded shows the offline action helper | mobile |
| JS27 | static/tests/crm_mobile_pipeline.test.js | [Mobile] lead card: 44 px touch target, name, contact, revenue and a pending-sync badge read from the queue | mobile |
| JS28 | static/tests/crm_mobile_pipeline.test.js | [Mobile] quick create: a bottom sheet with exactly name, contact, phone, email, revenue and stage, all available offline | mobile |
| JS29 | static/tests/crm_mobile_pipeline.test.js | [Offline] [Mobile] quick create queues one create and shows the lead at once as pending sync; replayed online | mobile |
| JS30 | static/tests/crm_mobile_pipeline.test.js | [Mobile] quick create online creates the lead and shows it in its stage | mobile |
| JS31 | static/tests/crm_mobile_pipeline.test.js | [Desktop] the pipeline keeps the standard kanban | desktop |
| JS32 | static/tests/crm_offline_hooks.test.js | [Offline] shared offline hooks: connectivity, queued calls, pending sync, pending creates, scheduling | desktop, mobile |
| JS61 | static/tests/crm_mobile_pipeline.test.js | [Mobile] a kanban of leads not grouped by stage keeps the standard kanban | mobile |
| JS62 | static/tests/crm_mobile_pipeline.test.js | [Mobile] a crm kanban whose arch isn't the pipeline's (no mobile_pipeline) keeps the standard kanban | mobile |
| JS63 | static/tests/crm_offline_kanban.test.js | [Offline] a lead's priority set from its pipeline card is queued and replayed | desktop, mobile |
| JS64 | static/tests/crm_offline_kanban.test.js | [Offline] forecast: a lead quick-created offline is queued and replayed | desktop |
| JS65 | static/tests/crm_offline_queue.test.js | [Offline] the offline systray labels a queued Restore, and any call it has no status for | desktop, mobile |
| JS66 | static/tests/crm_offline_form.test.js | [Offline] a lead marked won or restored offline still shows it when opened again offline | desktop, mobile |
| JS67 | static/tests/crm_offline_activities.test.js | [Offline] schedule an activity for the lead's salesperson: the queued create carries that assignee | desktop, mobile |
| JS68 | static/tests/crm_mobile_pipeline.test.js | [Mobile] arrow keys move through the stage's leads, without breaking the kanban's navigation | mobile |
| JS69 | static/tests/crm_offline_properties.test.js | [Offline] lead properties: a definition access probe lost with the connection doesn't switch the app offline again | desktop, mobile |
| JS70 | static/tests/crm_mobile_pipeline.test.js | [Mobile] a long stage scrolls under its header, down to its last lead | mobile |
| JS71 | static/tests/crm_mobile_pipeline.test.js | [Mobile] quick create in an empty pipeline leaves the sample data: the new lead shows and opens | mobile |
| JS72 | static/tests/crm_mobile_pipeline.test.js | [Offline] [Mobile] quick create offline in an empty pipeline: the pending lead shows, then the real one | mobile |
| JS73 | static/tests/crm_mobile_pipeline.test.js | [Mobile] quick create online: a reload lost with the connection doesn't queue the created lead again | mobile |
| JS74 | static/tests/crm_mobile_pipeline.test.js | [Mobile] quick create reads the expected revenue in the user's number format, and refuses an invalid one | mobile |
| JS75 | static/tests/crm_mobile_pipeline.test.js | [Mobile] coming back from a lead shows the stage it was opened from | mobile |
| JS76 | static/tests/crm_mobile_pipeline.test.js | [Mobile] a folded stage shown stays loaded when the pipeline reloads (team switcher) | mobile |
| JS77 | static/tests/crm_mobile_pipeline.test.js | [Offline] [Mobile] after the pipeline reloads offline, a stage never loaded still shows the offline action helper | mobile |
| PY06 | tests/test_crm_offline.py | TestCrmOffline.test_offline_quick_create_replay | server |
| PY07 | tests/test_crm_offline.py | TestCrmOffline.test_webmanifest_crm_shortcuts | server |
| PY08 | tests/test_crm_offline.py | TestCrmOffline.test_webmanifest_no_crm_shortcuts_without_crm_access | server |
| PY09 | tests/test_crm_offline.py | TestCrmOffline.test_crm_offline_tour | server |
| PY13 | tests/test_crm_offline.py | TestCrmOffline.test_mobile_pipeline_wiring | server |
| PY14 | tests/test_crm_offline.py | TestCrmOffline.test_offline_wiring_of_the_lead_form | server |
| JS78 | static/tests/crm_mobile_pipeline.test.js | [Offline] [Mobile] Load more reads the rest of a long stage online; offline it is disabled | mobile |
| JS79 | static/tests/crm_offline_activity_button.test.js | [Offline] a lead card's activity button (its popover: schedule, mark done, edit...) is disabled offline, enabled online | desktop, mobile |
| PY15 | tests/test_crm_offline.py | TestCrmOffline.test_offline_disabled_buttons_in_crm_archs | server |
