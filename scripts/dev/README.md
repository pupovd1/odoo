# Dev environment: Odoo 20.0 + crm

Run everything from the repository root. Database `crm_offline`, server
http://localhost:8069, login `admin` / password `admin`.

```sh
scripts/dev/setup.sh                    # system + Python deps, PostgreSQL, headless Chromium (idempotent)
scripts/dev/start.sh                    # serve http://localhost:8069 (creates crm_offline if missing); Ctrl-C stops
scripts/dev/start.sh --background       # same, detached; stop with scripts/dev/stop.sh
scripts/dev/smoke.sh                    # headless: log in as admin, open the CRM pipeline, check secure context
scripts/dev/test-py.sh                  # all crm tests (recreates crm_offline)
scripts/dev/test-py.sh TestCrmOffline   # one test class (or Class.test_method)
scripts/dev/test-js.sh desktop          # crm JS unit tests, desktop preset
scripts/dev/test-js.sh mobile           # crm JS unit tests, mobile preset (375x667, touch)
scripts/dev/test-guard.sh               # fails if a .test.js file uses only( or debug(
scripts/dev/rebuild-assets.sh           # regenerate JS/CSS bundles: after any front-end change, before re-testing
scripts/dev/reset-db.sh                 # drop and recreate crm_offline (crm, mail, demo data)
scripts/dev/check.sh scope              # acceptance checks on the changes since eval/base (no tests, < 1 s)
scripts/dev/check.sh full               # scope, rebuild-assets.sh, the five test commands, summary table
npm ci --prefix scripts/dev             # once per container: Playwright for the browser checks below
node scripts/dev/offline-smoke.mjs      # with the server up: mobile browser goes offline, reloads from cache
```

## What runs

The scripts print every command. All `odoo-bin` calls run with `.venv/bin/python`
and `-c scripts/dev/odoo.conf` (database role, addons path, data dir, listen on
127.0.0.1). Test runs add `--http-port=8070` so they never clash with a server on 8069.

| Script | `odoo-bin` arguments |
|---|---|
| `start.sh` | `-d crm_offline --http-port=8069`, after `-d crm_offline -i crm,mail --with-demo --stop-after-init` if the database is missing |
| `test-py.sh` | `db drop crm_offline`, then `-d crm_offline -i crm --test-enable --test-tags /crm --stop-after-init --log-level=test --with-demo` |
| `test-py.sh <Class>` | `-d crm_offline -u crm --test-enable --test-tags /crm:<Class> --stop-after-init --log-level=test` |
| `test-js.sh desktop` | `-d crm_offline -u crm --stop-after-init`, then `-d crm_offline --test-enable --test-tags /crm:WebSuite.test_unit_desktop --stop-after-init --log-level=test` |
| `test-js.sh mobile` | the same with `/crm:MobileWebSuite.test_unit_mobile` |
| `test-guard.sh` | `-d crm_offline -u crm --stop-after-init`, then `-d crm_offline --test-enable --test-tags /web:HootSuite.test_check_suite --stop-after-init --log-level=test` |
| `reset-db.sh` | `db drop crm_offline`, then `-d crm_offline -i crm,mail --with-demo --stop-after-init` |
| `rebuild-assets.sh` | `shell -d crm_offline`: delete the `/web/assets/` attachments, clear the `assets` cache (a running server is notified), regenerate the bundles |

Why these differ from the one-line commands they replace (each of which exits 0
having run **zero** tests):

- `-i crm` on a database where crm is already installed installs nothing, so no
  test runs. `test-py.sh` therefore drops `crm_offline` and lets `-i crm` recreate it.
- With `-u crm`, `odoo-bin` only collects tests of the modules it updated.
  `WebSuite`, `MobileWebSuite` and `HootSuite` are defined in `web`, so
  `-u crm --test-tags /web:...` finds nothing. The JS and guard scripts update crm
  first, then run the suite without `-u`.
- `WebSuite` and `MobileWebSuite` are cross-module tests: the module in the tag
  selects whose JS tests they run. `/crm:` runs crm's; `/web:` would run web's
  own suite (thousands of tests). `/crm` alone (`test-py.sh`) also runs both, for crm.
- Demo data is opt-in in 20.0 (`--with-demo`).

## Pass or fail

A test script passes only if `odoo-bin` exits 0, at least one test ran, no test
was skipped (without Chrome, Odoo skips browser tests and still exits 0),
nothing was logged at ERROR or CRITICAL level, and, for `test-js.sh`, hoot
reports more than zero passed JS tests. Each script ends with the test counts,
wall time and peak memory. Full output is in `logs/test-py.log`,
`logs/test-js-<preset>.log` and `logs/test-guard.log`.

## Acceptance checks: `check.sh`

`scope` compares eval/base (its merge base with HEAD; `CHECK_BASE=<ref>` to
change it) with the working tree: commits, staged, unstaged and untracked
changes. Ignored files don't count. It prints PASS or FAIL per check, with the
paths that fail, and exits non-zero if any check fails:

1. Every changed path is under `addons/crm/` (acceptance check 2).
2. `requirements.txt` and every `security/` path are unchanged (check 3).
3. No new `indexedDB`, `new IndexedDB`, `navigator.locks` or `caches.open` under `addons/crm/` (check 4).
4. No existing test file (in a `tests/` directory, `test_*.py`, `*.test.js`) changed,
   except `addons/crm/tests/__init__.py` (check 11, file part).
5. No `.test.js` file in the change set contains `only(` or `debug(` (check 13, static part).

`full` runs `scope`, `rebuild-assets.sh`, `test-py.sh`, `test-py.sh TestCrmOffline`,
`test-js.sh desktop`, `test-js.sh mobile` and `test-guard.sh`, then prints a table
(command, result, test count, time; also saved to `logs/check-summary.txt`). It fails
if any step fails or runs zero tests. Until the `TestCrmOffline` class exists, its
row reads `not yet created` and `full` fails. It takes about 5 minutes and, through
`test-py.sh`, recreates `crm_offline`.

Measured on 4 vCPU / 16 GB (Ubuntu 24.04, Chromium 141); peak memory is odoo-bin plus Chrome:

| Command | Wall time | Peak memory |
|---|---|---|
| `setup.sh` (all present / new `.venv`) | 3 s / 28 s | |
| `start.sh` (database present / created) | 2 s / 48 s | server ~270 MiB |
| `test-py.sh` (139 tests) | 3 min 06 s | 1.3 GiB |
| `test-py.sh TestLeadConvert` (18 tests) | 10 s | 160 MiB |
| `test-js.sh desktop` / `mobile` (26 / 13 JS tests) | 17 s / 17 s | 1.2 / 1.1 GiB |
| `test-guard.sh` | 11 s | 150 MiB |
| `rebuild-assets.sh` / `reset-db.sh` / `smoke.sh` | 16 s / 42 s / 11 s | |

## Offline browser checks

`offline-smoke.mjs` runs headless Chromium (Playwright 1.56.1, pinned in `package.json`, built
for the preinstalled Chromium 141) in a 375x667 touch context on http://localhost:8069. It logs
in, opens the CRM pipeline, goes offline, reloads offline and checks that the pipeline renders
from cache without a page request reaching the server, then goes back online. It exits 1 on any
failed check; screenshot and console log go to `.eval/state/smoke/`. Its helpers are the basis
of the `odoo-offline-qa` skill (`.claude/skills/odoo-offline-qa/SKILL.md`), which covers driving
flows offline and checking the server after reconnect.

## Notes

- **Secure context.** Odoo turns its offline features off when
  `window.isSecureContext` is false. The server listens on 127.0.0.1 and is opened
  as http://localhost:8069, which browsers treat as secure. From another machine,
  tunnel (`ssh -L 8069:localhost:8069 <host>`) and still open
  http://localhost:8069; plain `http://<host>:8069` is not a secure context.
- The test scripts and `reset-db.sh` stop a dev server started by `start.sh`,
  since they change the database it serves. Restart it afterwards. Scripts that
  change `crm_offline` wait for each other.
- Server log: `logs/odoo.log`. Smoke screenshot: `logs/smoke-crm-pipeline.png`.
  `.venv/`, `.odoo-data/` (filestore) and `logs/` are not tracked by git
  (the scripts add `/logs/` to `.git/info/exclude`).
- `requirements.txt` is unchanged. `setup.sh` also installs `websocket-client==1.7.0`
  and `phonenumbers==8.12.57` (the Ubuntu 24.04 versions), which it lacks.
- Overrides: `ODOO_HTTP_PORT` (8069), `ODOO_TEST_HTTP_PORT` (8070), `ODOO_DB`
  (`crm_offline`), `ODOO_BROWSER_BIN`, and `PYTHON` for `setup.sh` (default `python3.12`).
