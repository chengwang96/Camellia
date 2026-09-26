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


def rpc(method, payload=None):
    if method == 'pickFile':
        return picker_result
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
        url = (repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=runtimes'
        page.goto(url)
        page.wait_for_load_state('networkidle')
        # One shared Python field plus one path per engine (Antigravity keeps
        # only its subscription CLI): 1 + 5 = 6 controls.
        expect(page.locator('.runtime-path')).to_have_count(6)
        expect(page.locator('#runtime-path-python')).to_be_visible()
        expect(page.locator('#runtime-path-antigravity-api')).to_have_count(0)
        expect(page.locator('#runtime-path-antigravity-subscription')).to_be_visible()
        field = page.locator('.runtime-path[data-runtime="dsh"]')
        picker_result = {'canceled': False, 'path': str(script)}
        field.locator('[data-path-action="browse"]').click()
        expect(field.locator('input')).to_have_value(str(script))
        assert not next(row for row in rpc('runtimeState')['engines'] if row['id'] == 'dsh')['customPath']
        page.evaluate('rows => window.runtimeListeners.forEach(callback => callback(rows))', rpc('runtimeState')['engines'])
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
        expect(page.locator('.runtime-path[data-runtime="antigravity"][data-mode="subscription"] label')).to_have_text('Antigravity CLI 路径（Google 订阅）')
        page.set_viewport_size({'width': 1100, 'height': 950})
        (repo / 'dist/runtime-paths-qa').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(repo / 'dist/runtime-paths-qa/settings.png'), full_page=True)
        assert not errors, errors
        browser.close()
        print('Runtime path UI: six controls, save, persistence, canceled picker, validation, reset and layout passed')
finally:
    driver.terminate()
    driver.wait(timeout=10)
