"""Unified native settings with real IPC handlers and the real DSH web runtime."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n'); driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response: raise RuntimeError(response['error'])
    return response['result']

bridge = """window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on') ? () => () => {} : payload => window.testRpc(method, payload)});"""
try:
    rpc('configureTestApi')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width':1160,'height':900})
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc); page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=engines&engine=claude'); page.wait_for_load_state('networkidle')
        expect(page.locator('[data-engine=claude]')).to_have_attribute('aria-selected','true')
        expect(page.locator('.global-notice')).to_contain_text("overwrites the CLI's global settings")
        page.locator('[data-field=language]').fill('Chinese')
        page.locator('[data-field="permissions.defaultMode"]').select_option('plan')
        page.locator('#nativeDocuments summary').click()
        page.locator('#engineDocument').select_option('mcp')
        page.locator('#engineSource').fill('{"fixture":{"command":"fixture-mcp"}}')
        page.locator('#saveEngine').click(); expect(page.locator('#status')).to_contain_text('Global settings saved')
        saved=rpc('engineSettingsGet',{'engine':'claude'})
        assert json.loads(saved['files'][0]['text'])['language']=='Chinese'
        assert json.loads(next(f for f in saved['files'] if f['id']=='mcp')['text'])['fixture']['command']=='fixture-mcp'
        page.locator('#engineSource').fill('{invalid')
        page.locator('#saveEngine').click(); expect(page.locator('#status')).to_have_class('error')
        page.locator('#reloadEngine').click(); expect(page.locator('#saveEngine')).to_be_disabled()
        page.locator('[data-engine=kimi]').click(); expect(page.locator('#engineContext')).to_be_visible()
        page.locator('[data-field="loop_control.max_attempts_per_step"]').fill('8')
        page.locator('#engineContext').fill('196608')
        page.locator('#saveEngine').click(); expect(page.locator('#status')).to_contain_text('Global settings saved')
        assert rpc('engineSettingsGet',{'engine':'kimi'})['desktop']['contextWindow']==196608
        (repo/'dist/engine-settings-qa').mkdir(exist_ok=True)
        for scheme in ['light','dark']:
            page.emulate_media(color_scheme=scheme)
            page.screenshot(path=str(repo/f'dist/engine-settings-qa/kimi-{scheme}.png'),full_page=True)
        page.locator('[data-view=runtimes]').click(); expect(page.locator('.runtime-card')).to_have_count(3)
        expect(page.locator('#runtimeCards')).to_contain_text('Ready')
        page.locator('[data-view=engines]').click()
        page.locator('[data-engine=dsh]').click()
        native_url=rpc('dshSettingsUrl')['url']
        native=browser.new_page(viewport={'width':920,'height':680})
        native.add_init_script("window.name='workbench-settings'")
        native.on('pageerror',lambda error:errors.append(str(error)))
        native.goto(native_url); native.wait_for_load_state('domcontentloaded')  # DSH keeps its event connection open; wait for the panel below.
        expect(native.locator('.workbench-native-settings')).to_be_visible(timeout=60000)
        nav=native.locator('.workbench-native-nav')
        print('DSH native sections:',nav.inner_text())
        expect(nav).to_contain_text('Providers & Keys')
        native.screenshot(path=str(repo/'dist/engine-settings-qa/dsh-native.png'),full_page=True)
        native.close()
        assert errors==[],errors
        browser.close()
    print('PASS: Claude/Kimi settings, MCP, validation, runtime status, DSH native settings and unified API navigation')
finally:
    try: rpc('cleanup')
    finally: driver.terminate(); driver.wait(timeout=10)
