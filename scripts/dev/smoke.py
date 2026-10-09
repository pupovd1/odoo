"""Browser smoke check for the dev server; run it through smoke.sh.

Drives headless Chrome/Chromium over the DevTools protocol (websocket-client,
installed by setup.sh): logs in, opens the CRM pipeline and checks that it
renders with records, in the expected database, in a secure context, without
JavaScript errors. Writes a screenshot.
"""
import argparse
import base64
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

PIPELINE_INFO = """(async () => {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    const controller = document.querySelector('.o_action_manager .o_view_controller');
    return {
        url: location.href,
        isSecureContext: window.isSecureContext,
        db: window.odoo && odoo.info && odoo.info.db,
        serverVersion: window.odoo && odoo.info && odoo.info.server_version,
        breadcrumb: (document.querySelector('.o_breadcrumb') || {}).innerText,
        view: controller ? [...controller.classList].filter(c => /^o_.*_view$/.test(c)) : [],
        columns: [...document.querySelectorAll('.o_kanban_group')].map(
            g => ((g.querySelector('.o_column_title') || g).innerText || '').split('\\n')[0].trim()),
        records: document.querySelectorAll('.o_kanban_record:not(.o_kanban_ghost)').length,
        serviceWorker: reg ? (reg.active ? 'active' : 'registering') : 'none',
    };
})()"""


class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.last_id = 0
        self.events = []

    def send(self, method, **params):
        self.last_id += 1
        self.ws.send(json.dumps({'id': self.last_id, 'method': method, 'params': params}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') == self.last_id:
                if 'error' in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get('result', {})
            self.events.append(message)

    def evaluate(self, expression):
        result = self.send('Runtime.evaluate', expression=expression, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'].get('text', 'evaluation failed'))
        return result['result'].get('value')

    def wait_for(self, expression, what, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                value = self.evaluate(expression)
            except (RuntimeError, websocket.WebSocketTimeoutException):
                value = None  # page navigating: no execution context yet
            if value:
                return value
            time.sleep(0.25)
        raise TimeoutError(f"timed out after {timeout:.0f}s waiting for {what}")

    def js_errors(self):
        errors = []
        for event in self.events:
            params = event.get('params', {})
            if event.get('method') == 'Runtime.consoleAPICalled' and params.get('type') == 'error':
                errors.append(' '.join(str(arg.get('value', arg.get('description', ''))) for arg in params.get('args', [])))
            elif event.get('method') == 'Runtime.exceptionThrown':
                details = params.get('exceptionDetails', {})
                errors.append(details.get('exception', {}).get('description') or details.get('text', 'exception'))
        return errors


def devtools_ws_url(profile, timeout=30):
    port_file = pathlib.Path(profile, 'DevToolsActivePort')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_file.exists() and port_file.read_text().strip():
            port = port_file.read_text().split()[0]
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=10) as response:
                targets = json.load(response)
            return next(t['webSocketDebuggerUrl'] for t in targets if t['type'] == 'page')
        time.sleep(0.1)
    raise TimeoutError("Chrome did not open its DevTools port")


def log_in(args, page):
    page.send('Page.navigate', url=f'{args.url}/web/login?redirect=/odoo/crm')
    page.wait_for("document.readyState === 'complete' && !!document.querySelector('form.oe_login_form')",
                  'the login form', args.timeout)
    # The page's scripts un-hide the form once they are initialized; on a cold
    # server a submission made before that can get lost, so wait for them.
    try:
        page.wait_for("!document.querySelector('form.oe_login_form').classList.contains('d-none')",
                      'the login page scripts', 20)
    except TimeoutError:
        pass
    submit = f"""(() => {{
        const form = document.querySelector('form.oe_login_form');
        form.querySelector('input[name=login]').value = {json.dumps(args.login)};
        form.querySelector('input[name=password]').value = {json.dumps(args.password)};
        const button = form.querySelector('button[type=submit]');
        button ? button.click() : form.requestSubmit();
        return true;
    }})()"""
    for _attempt in range(2):
        page.evaluate(submit)
        try:
            return page.wait_for(
                "location.pathname !== '/web/login' || !!document.querySelector('.oe_login_form .alert-danger')",
                'the login to complete', 30)
        except TimeoutError:
            continue  # still on the login page without an error: submit again
    raise TimeoutError("submitting the login form never left /web/login")


def run(args, page):
    page.send('Runtime.enable')
    page.send('Page.enable')
    log_in(args, page)
    state = page.wait_for(
        "document.querySelector('.o_kanban_renderer .o_kanban_record') ? 'pipeline'"
        " : document.querySelector('.oe_login_form .alert-danger') ? 'login failed' : ''",
        'the CRM pipeline', args.timeout)
    if state == 'login failed':
        raise RuntimeError(f"login as {args.login} failed")
    time.sleep(1)  # let the remaining columns and the service worker settle
    info = page.evaluate(PIPELINE_INFO)
    shot = page.send('Page.captureScreenshot', format='png')
    pathlib.Path(args.screenshot).write_bytes(base64.b64decode(shot['data']))
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--browser', required=True)
    parser.add_argument('--screenshot', required=True)
    parser.add_argument('--login', default='admin')
    parser.add_argument('--password', default='admin')
    parser.add_argument('--timeout', type=float, default=180)
    args = parser.parse_args()

    profile = tempfile.mkdtemp(prefix='odoo-smoke-')
    chrome = subprocess.Popen([
        args.browser, '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--window-size=1366,768',
        '--remote-debugging-port=0', f'--user-data-dir={profile}', 'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    started = time.monotonic()
    try:
        page = Page(devtools_ws_url(profile))
        info = run(args, page)
        errors = page.js_errors()
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}")
        return 1
    finally:
        chrome.terminate()
        try:
            chrome.wait(10)
        except subprocess.TimeoutExpired:
            chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)

    print(json.dumps(info, indent=2))
    problems = []
    if info['isSecureContext'] is not True:
        problems.append("window.isSecureContext is false: Odoo disables its offline features")
    if info['db'] != args.db:
        problems.append(f"web client is on database {info['db']!r}, expected {args.db!r}")
    if not info['columns'] or not info['records']:
        problems.append("the pipeline has no stages or no leads (demo data missing?)")
    problems += [f"JavaScript error: {error}" for error in errors]
    print(f"screenshot: {args.screenshot}")
    print(f"took {time.monotonic() - started:.1f}s")
    if problems:
        print("FAILED:\n  - " + "\n  - ".join(problems))
        return 1
    print(f"OK: logged in as {args.login} and opened the CRM pipeline "
          f"({len(info['columns'])} stages, {info['records']} leads) in a secure context")
    return 0


if __name__ == '__main__':
    sys.exit(main())
