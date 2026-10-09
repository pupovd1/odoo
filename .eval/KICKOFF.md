# Goal
Add an offline-capable, mobile-first CRM experience to the crm addon.
A salesperson on a phone with no connectivity must be able to open the
pipeline, read leads and opportunities they previously visited online,
edit them, create new leads, log and complete activities, and look up
contacts. Every write made offline must be queued and replayed
automatically when connectivity returns.

Repo: this checkout. The branch for this run is named in the prompt; it
is based on eval/base (20.0).

Read CLAUDE.md in full first. It holds this project's standing rules
(changes only under addons/crm/, never a second offline engine,
unchanged conflict semantics, the offline-availability attribute, no
new dependencies, the wiring rules) plus a map of the existing offline
and PWA framework and the test commands. This fork already has a
complete offline framework, active for every CRM list, kanban, and
form view. Every part of your plan must extend it, and must follow
CLAUDE.md; if the plan contains a new queue, store, worker, cache, or
resolver, the plan is wrong. Follow the addon's one-directory-per-
component convention: new mobile front-end code goes under
addons/crm/static/src/mobile/, and the new Python test class is named
TestCrmOffline. Bump the crm manifest version by one minor increment.

# Milestone 1: offline surface inventory (no code changes)
Sweep addons/crm/ for every entry point that needs a live server:
every JS call to the ORM, to rpc, to the action service, or to a user
group/access-right probe; every view, wizard, and report button with a
server side effect; and every public method on crm.lead, crm.stage, and
crm.team reachable from a button. Record each in
addons/crm/static/src/mobile/offline_inventory.md with file path, line
number, the call, one classification, and a one-line justification,
plus a count per classification. Apply these rules in order:
- QUEUE: a write on crm.lead, crm.stage, crm.team, or a lead's
  mail.activity whose full argument list is resolvable on the client.
  Offline it queues and the UI updates optimistically.
- SKIP: a read that's only decorative or advisory (a tooltip, a visual
  effect, a promotional hint, a group probe that only toggles display).
  Offline it's skipped silently: no call, no error, no notification.
  Never queued, because a replay would fire the effect detached from
  the action that caused it.
- DISABLE: everything else, including transient-model wizards, module
  installation, paid external lookups, server-computed reports, access
  probes gating destructive UI, and navigation to anything unavailable
  offline. Offline the control is disabled and unreachable by click,
  keyboard, hotkey, or programmatic call.
Anything that needs a server onchange, a transient-model wizard, or an
id produced by another call is DISABLE, never QUEUE. Stop after this
milestone for my review; everything after it is implemented against
the reviewed inventory.

# Known defects in existing CRM code (confirmed; fix all)
1. Post-save rainbowman lookup: on a stage change, the form save calls
   a server method for a rainbowman message. Offline, the save queues
   fine and then this lookup raises a connection-lost error. Offline,
   skip the lookup entirely and don't queue it; the save must still
   complete. Online behavior stays the same.
2. Email and phone force-save: the same save copies the lead's email
   and phone into the change set when the partner-sync flags are set,
   so the server's inverse methods run. Those copied values must be in
   the queued offline write too, or offline lead-to-partner
   propagation silently differs from online (an existing test asserts
   this).
3. Team switcher: offline, skip the sales-manager group probe and
   treat it as false, render the dropdown disabled, and make
   manage-teams unreachable. The selected team must stay visible as a
   search facet; the search model already does this, don't regress it.
4. Lead generation dropdown: disabled offline, with no module lookup or
   access-right probe issued.
5. Recurring-revenue progress aggregate: skip its group probe offline
   and hide the aggregate. Don't show zero; a zero reads as real data.
6. Predictive-scoring tooltip button: disabled offline, no lookup.
7. CRM entry in the activity menu: disabled offline.
8. Chatter on the lead form: read-only offline, no uncaught error,
   achieved from inside addons/crm/.

# Offline data coverage
- Leads, stages, teams: already covered by the framework. Verify and
  prove it; don't reimplement it. Offline creates, edits, stage moves,
  and mark-won queue and replay. Mark-won shows the lead as won
  immediately and doesn't attempt the rainbowman lookup. A lead never
  visited online can't be opened offline; show the offline action
  helper instead of an empty form.
- Activities on a lead visited online: log a call, schedule a
  follow-up, mark one done. Extend mail.activity from the existing
  CRM-side inherit. Scheduling queues a create with a fully
  client-resolved argument list: related model, record id, activity
  type, summary, deadline, assignee. Activity types come from the
  offline cache; if none is cached, disable the control rather than
  show an empty picker. Marking done queues only the state change.
  Creating a calendar event from an activity is unreachable offline.
  Activities queued offline appear in the lead's activity list
  immediately, visibly marked as pending sync.
- Contact lookup: the lead's partner field resolves names and searches
  offline through the existing relational-field cache. Don't add a
  second partner cache, and don't allow creating a new contact offline,
  since a queued lead write can't reference a contact whose id only
  exists after replay.

# Mobile-first UI (small screens only)
- Mobile pipeline: one stage at a time filling the viewport width,
  horizontal navigation between adjacent stages, and a fixed header
  with stage name, lead count, and revenue sum. Reuse the existing CRM
  kanban model, arch parser, and search model; don't define a second
  kanban model. Works offline for every cached stage; an uncached stage
  shows the offline action helper.
- Mobile lead card: touch targets at least 44x44 CSS pixels; shows lead
  name, partner name, expected revenue, and a pending-sync indicator
  read from the framework's queue, not a dirty flag the card keeps.
- Mobile quick create: a bottom sheet using the framework's existing
  bottom-sheet option, capturing exactly lead name, contact name,
  phone, email, expected revenue, and stage. Works offline and queues
  a create; every field carries the offline-availability attribute.
- Shared offline hooks: one module exposing the offline predicates the
  mobile components share. Every mobile component consumes these
  hooks rather than resolving the offline plugin on its own.
- View arch: extend the addon's existing mobile kanban arch; don't add
  a parallel view record.
- Wire every new view and component per the wiring rules in CLAUDE.md,
  with a test for each wiring point.

# PWA packaging
Extend the addon's existing web-manifest controller only.
- Append two CRM shortcuts, "My Pipeline" and "New Lead", to the
  parent's result in the same shape the parent builds. Keep the
  parent's own shortcuts; CRM is already listed as an app, so this adds
  deep links, it doesn't re-add the app.
- Point the manifest icon at the addon's existing icon asset.
- Don't override the service worker, the manifest route, or the
  offline page route, and don't change the background or theme color.
  Keep the share target enabled.

# Out of scope (disabled or degraded, never left to fail)
Offline chatter beyond read-only; calendar.event (scheduling a meeting
offline is disabled); the mark-lost, mass convert-to-opportunity,
merge-opportunities, and predictive-scoring-update wizards; predictive
lead scoring, the forecast views, graph and pivot views, and the
activity view; lead generation and in-app module installation; push
notifications, background sync, and geolocation; any data-model
change; multi-company and multi-currency behavior changes.

# What to test
Commands and conventions are in CLAUDE.md.
- Python: the manifest override returns the parent's shortcuts plus
  the two CRM shortcuts with a valid shape and an openable icon path;
  applying the exact write a queued offline edit produces gives the
  same lead state as the online write, including the email and phone
  propagation; replaying the queued mark-won leaves the lead won;
  replaying an offline activity create links the activity to the lead.
- JS unit, desktop and mobile presets: offline, the form save completes
  with no rainbowman lookup and no error; online, the rainbowman lookup
  IS issued on a stage change (this guards against fixing offline by
  deleting the feature); each DISABLE control is disabled offline and
  re-enabled online; each SKIP call isn't issued offline and raises
  nothing; quick create queues a create offline and shows the
  pending-sync indicator; the mobile pipeline renders a cached stage
  offline and the offline action helper for an uncached one; an
  uncached lead opened offline shows the offline action helper, not an
  empty form or an error; two offline writes to one lead replay in
  order with no conflict dialog; a rejected replay is parked with its
  error and no CRM-specific error UI appears. Test every new mobile
  component under the mobile preset, not only the desktop one.
- Browser tour, in one run: load the pipeline online, open a lead, go
  offline, edit that lead, create a new lead through mobile quick
  create, schedule an activity, mark the lead won, reconnect, and
  assert every change reached the server.

# Acceptance checks (your validation contract must cover every one)
Each check holds only if it's demonstrated by its verification; a check
that can't be demonstrated by a command, a test, or a review isn't met.
Run every command from the repo root. There's no CI, so every command
must be run, must pass, and must have its result reported. The five
test commands (in CLAUDE.md) are: the crm Python suite, the
TestCrmOffline class, the desktop JS preset, the mobile JS preset, and
the forbidden-statement guard.
1. The inventory classifies every swept entry point as exactly one of
   QUEUE, SKIP, or DISABLE, with a justification per row and counts.
   Verify: read the inventory.
2. The diff touches only paths under addons/crm/.
   Verify: git diff --name-only eval/base..HEAD | grep -v '^addons/crm/'
   is empty.
3. requirements.txt and the addon's security files are unchanged.
   Verify: git diff --name-only eval/base..HEAD | grep -E
   'requirements.txt|security/' is empty.
4. No parallel offline stack was built.
   Verify: grep -rn "indexedDB\|new IndexedDB\|navigator.locks\|caches.open"
   addons/crm/ shows no new occurrences.
5. The crm manifest version is bumped one minor increment.
   Verify: read the manifest.
6. The full offline write-and-replay cycle reaches the server on
   reconnect: an edit, a create, an activity schedule, and mark-won.
   Verify: the browser tour.
7. Every DISABLE control is disabled offline and re-enabled online;
   every SKIP call isn't issued offline and raises nothing.
   Verify: JS unit tests.
8. Queue semantics are unchanged: ordered replay, later write wins, a
   rejected replay parked in the existing systray, no conflict dialog,
   no CRM-specific error UI. Verify: JS unit tests.
9. An uncached lead opened offline shows the offline action helper,
   not an empty form or an error. Verify: JS unit tests.
10. Desktop, online: CRM behaves exactly as before.
    Verify: the existing crm Python suite and the desktop JS preset pass
    unchanged.
11. Every existing CRM test passes unchanged: none deleted, skipped,
    retagged, or weakened. Verify: all five test commands pass, and no
    existing test file is modified other than the tests package __init__.
12. New JS unit tests pass under both the desktop and mobile presets.
    Verify: the desktop and mobile JS preset commands.
13. No .test.js file in the diff contains only( or debug(.
    Verify: the forbidden-statement guard command.
14. Statement coverage of each new mobile JS file is at least 80%, and
    every new wiring point and component is exercised by a new test.
    Verify: review the new tests against the new source.

# Git
Commit your work to this run's branch as you go. After each milestone
passes its checks, push the branch to origin. Don't push to any other
branch, and don't force-push. Commit only files under addons/crm/.
Keep run state (plan, test list, progress notes, screenshots) in
.eval/state/, which is ignored by git. Don't change CLAUDE.md, .claude/,
.eval/*.md, or scripts/dev/.

# Deliverables
The code, the tests, the inventory at
addons/crm/static/src/mobile/offline_inventory.md, and a PR
description that summarizes the design (including the defect fixes
and any known limits) and reports the result of every test command.

# Before you plan
Ask me whatever you need to remove ambiguity. In the plan, include a
short design summary, the validation contract, and milestones ordered
so the inventory comes first, fixes to existing code paths come before
new mobile UI, and PWA packaging and the full test lanes are validated
last. Pause for my review after milestone 1.
