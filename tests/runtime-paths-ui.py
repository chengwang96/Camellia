"""Verify local runtime path controls through real desktop IPC with isolated storage."""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
picker_result = {'canceled': True}
python_state = {}
runtime_calls = []
runtime_updated = False


def rpc(method, payload=None):
    global runtime_updated
    if method == 'pickFile':
        return picker_result
    # Exercise the renderer's install/update delegation without downloading
    # packages or changing any real installation.
    if method == 'runtimeEnsure':
        runtime_calls.append((method, payload))
        return {'ok': True}
    if method == 'runtimeCheckUpdates':
        runtime_calls.append((method, payload))
        return {'ok': True, 'engines': [{**row, 'checkable': True, 'installed': True,
            'updateAvailable': row['id'] == 'dsh' and not runtime_updated, 'latest': '9.9.9'}
            for row in rpc('runtimeState')['engines']]}
    if method == 'runtimeUpdate':
        runtime_calls.append((method, payload))
        runtime_updated = True
        return {'ok': True, 'engine': payload['engine'], 'changed': True, 'to': '9.9.9'}
    # Python is a global setting reported separately from the engine cards.
    if method == 'runtimePythonState':
        return {'ok': True, 'python': python_state}
    if method == 'runtimeSetPython':
        if payload and payload.get('file'):
            python_state.update({'file': payload['file'], 'version': '3.12.4', 'antigravitySdk': False, 'configured': True})
        else:
            # Clearing the override falls back to auto-detection, which is
            # reported separately from a saved choice.
            python_state.clear()
            python_state.update({'file': '/usr/bin/python3', 'version': '3.11.9', 'antigravitySdk': True, 'configured': False, 'source': 'Detected automatically'})
        return {'ok': True, 'python': dict(python_state)}
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']


try:
    with tempfile.TemporaryDirectory(prefix='camellia-path-ui-') as temporary, sync_playwright() as playwright:
        script = Path(temporary) / 'local cli.js'
        script.write_text('console.log("fixture 1.2.3")', encoding='utf-8')
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 850})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script("""window.runtimeListeners = [];
          window.dshDesktop = new Proxy({}, {get: (_, method) =>
          method === 'onRuntimeState' ? callback => { window.runtimeListeners.push(callback); return () => {}; } :
          method.startsWith('on') ? () => () => {} : payload => window.testRpc(method, payload)});""")
        url = (repo / 'src/renderer/settings/api-settings.html').as_uri()
        # Legacy download links preserve the engine after merging the pages.
        page.goto(url + '?page=runtimes&engine=dsh')
        page.wait_for_load_state('networkidle')
        # One shared Python field plus one path per engine (Antigravity keeps
        # only its subscription CLI). Derive the engine count from the real
        # runtime state so adding an engine cannot silently stale this line.
        engine_count = len(rpc('runtimeState')['engines'])
        expect(page.locator('.runtime-path')).to_have_count(1 + engine_count)
        expect(page.locator('#pageTitle')).to_have_text('Engine Settings')
        expect(page.locator('#runtime-path-python')).to_be_hidden()
        expect(page.locator('#runtimeCards .runtime-card:visible')).to_have_count(1)
        expect(page.locator('#runtime-path-antigravity-api')).to_have_count(0)
        # Home reminders deep-link to the engine and immediately check updates.
        page.goto(url + '?page=engines&engine=dsh&focus=updates', wait_until='networkidle')
        expect(page.locator('[data-update=dsh]')).to_be_visible()
        assert ('runtimeCheckUpdates', None) in runtime_calls
        page.locator('[data-engine=antigravity]').click()
        expect(page.locator('#runtime-path-antigravity-subscription')).to_be_visible()
        # API's interpreter and the subscription CLI must each show their own
        # resolved path, even when the last conversation used API mode.
        conflict_rows = rpc('runtimeState')['engines']
        antigravity_row = next(row for row in conflict_rows if row['id'] == 'antigravity')
        python_path = r'C:\Users\fixture\miniconda3\envs\torch124\python.exe'
        cli_path = r'C:\Users\fixture\AppData\Local\agy\bin\agy.exe'
        antigravity_row.update({'mode': 'api', 'status': 'ready', 'version': '0.1.20',
            'file': python_path, 'source': 'Installed by Camellia', 'external': False,
            'subscriptionRuntime': {'id': 'antigravity', 'name': 'Antigravity', 'mode': 'subscription',
                'status': 'ready', 'version': '1.2.14', 'file': cli_path, 'source': 'Available locally', 'external': True}})
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', conflict_rows)
        card = page.locator('#runtimeCards .runtime-card:visible')
        expect(card.locator(':scope > .runtime-installation-path')).to_contain_text('Python interpreter (API)')
        expect(card.locator(':scope > .runtime-installation-path code')).to_have_text(python_path)
        cli_section = card.locator('.runtime-subscription')
        expect(cli_section.locator('h3')).to_have_text('Google subscription CLI')
        expect(cli_section.locator('.runtime-installation-path code')).to_have_text(cli_path)
        expect(cli_section.locator('[data-cli-status]')).to_contain_text('Update this CLI')
        assert cli_section.count() == 1
        # Re-rendering the path controls must not accumulate CLI summaries.
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', conflict_rows)
        expect(card.locator('.runtime-subscription')).to_have_count(1)
        (repo / 'dist/runtime-paths-qa').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(repo / 'dist/runtime-paths-qa/antigravity-api-and-cli.png'), full_page=True)
        # A real Node executable must fail the CLI identity check rather than
        # become a saved runtime just because its version looks valid.
        unrelated = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
        cli_section.locator('input').fill('"' + unrelated + '"')
        cli_section.locator('[data-path-action="save"]').click()
        expect(page.locator('#status')).to_contain_text('Choose the Antigravity CLI')
        expect(page.locator('#runtime-path-antigravity-subscription')).to_have_value('"' + unrelated + '"')
        antigravity_row['subscriptionRuntime'] = {'id': 'antigravity', 'name': 'Antigravity',
            'mode': 'subscription', 'status': 'error', 'customPath': unrelated,
            'message': 'Choose the Antigravity CLI (agy), not Python or the Antigravity desktop application'}
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', conflict_rows)
        expect(card.locator('.runtime-subscription [data-cli-status]')).to_have_text('CLI path unavailable')
        expect(card.locator('.runtime-subscription [data-install=antigravity]')).to_have_count(0)
        antigravity_row['subscriptionRuntime'] = {'id': 'antigravity', 'name': 'Antigravity',
            'mode': 'subscription', 'status': 'missing'}
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', conflict_rows)
        card.locator('.runtime-subscription [data-install=antigravity]').click()
        expect(page.locator('#status')).to_contain_text('Runtime ready')
        assert ('runtimeEnsure', {'engine': 'antigravity', 'mode': 'subscription'}) in runtime_calls
        # The API install action uses the opposite mode and never changes the
        # subscription selection implicitly.
        antigravity_row.update({'status': 'missing', 'file': ''})
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', conflict_rows)
        card.locator(':scope > .runtime-header [data-install=antigravity]').click()
        expect(page.locator('#status')).to_contain_text('Runtime ready')
        assert ('runtimeEnsure', {'engine': 'antigravity', 'mode': 'api'}) in runtime_calls
        page.locator('[data-engine=dsh]').click()
        field = page.locator('.runtime-path[data-runtime="dsh"]')
        page.evaluate('rows => {rows.find(row => row.id === "dsh").status = "missing"; window.runtimeListeners.forEach(callback => callback(rows));}', rpc('runtimeState')['engines'])
        page.locator('[data-install=dsh]').click()
        expect(page.locator('.runtime-card:visible [data-runtime-status]')).to_have_text('Installed')
        expect(page.locator('[data-install=dsh]')).to_have_count(0)
        assert ('runtimeEnsure', {'engine': 'dsh'}) in runtime_calls
        page.locator('#checkRuntimeUpdates').click()
        expect(page.locator('[data-update=dsh]')).to_be_visible()
        page.locator('[data-update=dsh]').click()
        expect(page.locator('#status')).to_contain_text('Updated DeepSeek Harness to v9.9.9')
        expect(page.locator('[data-update=dsh]')).to_have_count(0)
        assert ('runtimeUpdate', {'engine': 'dsh'}) in runtime_calls
        picker_result = {'canceled': False, 'path': str(script)}
        field.locator('[data-path-action="browse"]').click()
        expect(field.locator('input')).to_have_value(str(script))
        assert not next(row for row in rpc('runtimeState')['engines'] if row['id'] == 'dsh')['customPath']
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', rpc('runtimeState')['engines'])
        expect(field.locator('input')).to_have_value(str(script))
        page.locator('[data-engine=codex]').click()
        expect(field).to_be_hidden()
        page.locator('[data-engine=dsh]').click()
        expect(field.locator('input')).to_have_value(str(script))
        field.locator('[data-path-action="save"]').click()
        expect(page.locator('#status')).to_contain_text('Runtime path saved')
        assert next(row for row in rpc('runtimeState')['engines'] if row['id'] == 'dsh')['customPath'] == str(script)
        page.reload(wait_until='networkidle')
        expect(field.locator('input')).to_have_value(str(script))
        picker_result = {'canceled': True}
        field.locator('[data-path-action="browse"]').click()
        expect(field.locator('input')).to_have_value(str(script))

        # The shared Python interpreter is saved globally and warns when the
        # Antigravity SDK is missing, without blocking other harnesses.
        page.goto(url + '?page=general', wait_until='networkidle')
        python_field = page.locator('#pythonPath')
        python_field.locator('input').fill(str(script))
        python_field.locator('[data-path-action="save"]').click()
        expect(page.locator('#status')).to_contain_text('Python path saved')
        expect(page.locator('#pythonBadge')).to_contain_text('Antigravity SDK not found')
        assert python_state['file'] == str(script)
        page.reload(wait_until='networkidle')
        expect(python_field.locator('input')).to_have_value(str(script))
        python_field.locator('[data-path-action="reset"]').click()
        expect(page.locator('#pythonBadge')).to_contain_text('Detected automatically')
        expect(python_field.locator('input')).to_have_value('')
        assert python_state['configured'] is False
        page.locator('[data-view=engines]').click()
        page.locator('[data-engine=dsh]').click()
        field.locator('input').fill('not-an-absolute-path')
        field.locator('[data-path-action="save"]').click()
        expect(page.locator('#status')).to_have_class('error')
        expect(field.locator('input')).to_have_value('not-an-absolute-path')
        assert next(row for row in rpc('runtimeState')['engines'] if row['id'] == 'dsh')['customPath'] == str(script)
        field.locator('[data-path-action="reset"]').click()
        expect(page.locator('#status')).to_contain_text('Runtime path saved')
        expect(field.locator('input')).to_have_value('')
        page.set_viewport_size({'width': 720, 'height': 850})
        assert page.locator('.runtime-path-actions').evaluate_all(
            'elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)')
        rpc('workbenchSaveSettings', {'language': 'zh-CN'})
        page.reload(wait_until='networkidle')
        expect(page.locator('#pythonPath label')).to_have_text('Python 可执行文件')
        expect(page.locator('#runtime-path-python')).to_have_attribute('placeholder', '自动检测')
        page.locator('[data-view=engines]').click()
        page.locator('[data-engine=antigravity]').click()
        expect(page.locator('.runtime-path[data-runtime="antigravity"][data-mode="subscription"] label')).to_have_text('Antigravity CLI 路径（Google 订阅）')
        page.set_viewport_size({'width': 1100, 'height': 950})
        (repo / 'dist/runtime-paths-qa').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(repo / 'dist/runtime-paths-qa/settings.png'), full_page=True)
        assert not errors, errors
        browser.close()
        print('Runtime path UI: engine tabs, legacy links, General Python, drafts, save, persistence, validation, reset and layout passed')
finally:
    driver.terminate()
    driver.wait(timeout=10)
