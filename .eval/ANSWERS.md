# Answers to likely questions

Use these answers. If a question isn't covered here, use your judgment,
keep to CLAUDE.md section 4, and record the decision in the PR
description.

## Planning
- Conflict policy when the server changed a record too: don't design
  one. Ordered replay, last write wins, failed calls parked in the
  existing systray.
- A code path needs a server onchange offline: it belongs to something
  out of scope (a wizard, a scoring recompute). DISABLE it.
- Add a small cache for one field or lookup? No. Reuse the framework's
  relational-field cache. Don't add a second cache anywhere.
- Browsers and viewport: current Chrome and Firefox. Test mainly at the
  mobile preset (375x667) and also at desktop, gated by the existing
  small-screen signal.
- Multi-company or multi-currency edge cases: out of scope; don't
  change this behavior.
- Change Python code outside addons/crm/? No. Use _inherit, controller
  subclassing, or XML inheritance from inside addons/crm/.
- The framework seems to miss something this feature needs: don't
  build it. Name the gap in the PR description and scope the feature
  around it.
- Where do the inventory and design notes go? The inventory goes in
  addons/crm/static/src/mobile/offline_inventory.md. Design notes go in
  the PR description. Run state goes in .eval/state/.
- An entry point doesn't fit QUEUE, SKIP, or DISABLE cleanly: apply the
  rules in order. If it needs an onchange, a wizard, or another call's
  id, it's DISABLE.
- Can a write depend on a record created offline in the same session?
  Only through the queue as it is today. The queue does no id
  remapping, so a call that needs another queued call's id is DISABLE.
- Which models can queue writes? crm.lead, crm.stage, crm.team, and
  mail.activity on a lead. Everything else is SKIP or DISABLE.
- "One minor increment" from manifest version 1.9: 1.10.
- Quick create "contact name": the free-text contact_name field, not a
  partner picker. Partner lookup stays on the lead form.
- How to deliver the PR description: as .eval/state/PR.md, used as the
  PR body.
- Browser QA per milestone: yes, for every milestone that changes UI,
  with the odoo-offline-qa skill, a real offline switch, and a
  server-side check. Run one browser test at a time on port 8069.
- Mobile pipeline wiring: the pipeline uses crm_case_kanban_view_leads,
  not the "mobile" kanban arch. Add a small-screen branch inside the
  existing crm_kanban renderer: no new view, action, or js_class.
- Mobile-only? Gate only the mobile UI (bottom sheet, mobile card,
  mobile pipeline) on small screens. Offline data behavior (mark-won,
  activities) works at every size.
- Mark an activity done: queue action_done, so the replay matches Mark
  Done online. "Done & Schedule Next" is DISABLE offline.
- Log a call offline: create a completed Call in one queued call (a
  small crm.lead method, no sudo), or DISABLE it if one call can't do it.
- May tests stop the dev server, use crm_offline, write test data, and
  reset it? Yes. Start and stop Odoo only with the dev scripts, use only
  crm_offline, and reset only between test runs.
- Per-milestone test gate: run test-py.sh TestCrmOffline only from the
  milestone that creates the class; the script fails a run that
  collects zero tests.

## During execution
- Controls the framework doesn't support offline (stage delete or
  reorder, card menus, list multi-edit and cell editing): DISABLE them
  offline and list them as known limits. Don't extend the framework.
- Anything tied to predictive lead scoring: DISABLE; it's out of scope.
- QUEUE rows the framework already queues beyond the kickoff's
  workflows (restoring lost leads, the action menu): keep QUEUE and add
  a test per row that it queues and replays. Make destructive admin
  actions such as group deletes DISABLE.
- A framework call that is tried offline and fails (the partner
  autocomplete lookup): a known limit only if it fails silently and
  cached results still show; otherwise SKIP it and fix it from
  addons/crm/.
- A gap in CRM's own new code (an offline reload loses the cached
  pipeline, a synced card disappears): fix it with the framework's
  existing cache and signals, with a test and a browser check.
- A check that can't pass without changing addons/web (an offline cold
  start of the installed app): reword the check to the strongest case
  CRM can meet, and record the web gap as a known limit.
