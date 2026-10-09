# The run: autonomous

This run has no human review between milestones. These rules replace
the "Stop after this milestone for my review" line and the "Before you
plan" section of .eval/KICKOFF.md. Everything else in KICKOFF.md and
CLAUDE.md still applies.

Branch: eval/claude-code-crm-offline. Commit and push only to this
branch.

1. Read CLAUDE.md, .eval/KICKOFF.md, and .eval/ANSWERS.md in full first.
2. Don't ask questions. If something is unclear, use ANSWERS.md. If
   ANSWERS.md doesn't cover it, choose the option that keeps to
   CLAUDE.md section 4, and record the decision in
   .eval/state/decisions.md. Copy every decision into the PR
   description.
3. Plan first. Use subagents to explore addons/web and addons/crm, so
   your own context stays small. Check the facts KICKOFF.md states about
   the existing code, and record any mismatch in decisions.md. Write
   .eval/state/PLAN.md with a design summary, a validation contract that
   maps each of the 14 acceptance checks to the command or test that
   proves it, and milestones in the order KICKOFF.md gives. Write every
   planned test to .eval/state/tests.json with a status. Never remove
   or weaken a test in tests.json to make progress.
4. Do milestone 1 (the inventory) fully before any code change. Ask the
   crm-offline-reviewer subagent to check it against KICKOFF.md and the
   8 known defects, fix what it finds, then continue. Don't pause.
5. For each milestone: write its tests first; implement; run
   scripts/dev/rebuild-assets.sh, the test commands the milestone
   touches, and scripts/dev/check.sh scope; for any UI change, test
   while actually offline with the odoo-offline-qa skill and check the
   server after reconnect. Then ask the crm-offline-reviewer subagent to
   review the milestone diff. Fix the gaps that affect correctness or an
   acceptance check; list the rest in progress.md as optional.
   Append to .eval/state/progress.md: what changed, commands and
   results, open issues, and a short handoff. Commit and push.
6. If your context is compacted or you start fresh, first read PLAN.md,
   tests.json, progress.md, decisions.md, and git log --oneline -20.
7. If a test fails three times for the same reason, write the root
   cause in progress.md, try one different approach, and if that fails,
   record it as a known limit and move on.
8. Finish: run scripts/dev/check.sh full. Write the PR description to
   .eval/state/PR.md: the design, the 8 defect fixes, every decision
   from decisions.md, known limits, and the result of every test
   command. Open a PR from eval/claude-code-crm-offline to eval/base
   (gh pr create, or the session's Create PR button in a cloud session).
9. Show evidence, not claims: for every check you report as met, show
   the command you ran and its output.
