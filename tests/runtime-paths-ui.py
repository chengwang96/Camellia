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


def rpc(method, payload=None):
    if method == 'pickFile':
        return picker_result
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
        expect(page.locator('.runtime-path')).to_have_count(6)
        expect(page.locator('#runtime-path-antigravity-api')).to_be_visible()
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
        expect(page.locator('.runtime-path[data-runtime="antigravity"][data-mode="api"] label')).to_have_text('Python 路径（Antigravity API）')
        page.set_viewport_size({'width': 1100, 'height': 950})
        (repo / 'dist/runtime-paths-qa').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(repo / 'dist/runtime-paths-qa/settings.png'), full_page=True)
        assert not errors, errors
        browser.close()
        print('Runtime path UI: six controls, save, persistence, canceled picker, validation, reset and layout passed')
finally:
    driver.terminate()
    driver.wait(timeout=10)
