"""Engine uninstall confirmation, cancellation, busy state and responsive translations."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
installed = True
busy = False
fail = False
calls = []
original = r'C:\Camellia\runtimes\kimi\node_modules\@moonshot-ai\kimi-code\dist\main.mjs'


def rpc(method, payload=None):
    global installed, busy, fail
    if method == 'runtimeUninstallPreview':
        return {'ok': True, 'engine': 'kimi', 'name': 'Kimi Code', 'token': 'reviewed-installation',
                'file': original, 'targets': [r'C:\Camellia\runtimes\kimi\node_modules']}
    if method == 'testBeginUninstall':
        calls.append(payload)
        busy = True
        return {'ok': True}
    if method == 'testFinishUninstall':
        busy = False
        if fail:
            return {'ok': False, 'error': 'Package files are locked'}
        installed = False
        return {'ok': True, 'engine': 'kimi'}
    if method == 'runtimeCheckUpdates':
        return {'ok': True, 'engines': []}
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    result = response['result']
    if method == 'runtimeState':
        row = next(row for row in result['engines'] if row['id'] == 'kimi')
        row.update(status='ready' if installed else 'missing', file=original if installed else '',
                   version='1.0.0' if installed else '', source='Installed by Camellia', external=False,
                   updating=busy, uninstalling=busy, customPath='', paths={'api': ''}, updateInfo=None)
    return result


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script("""
          window.runtimeListeners = [];
          window.redrawRuntimes = async () => {
            const state = await testRpc('runtimeState');
            runtimeListeners.forEach(listener => listener(state.engines));
          };
          window.finishUninstall = async () => {
            const result = await testRpc('testFinishUninstall');
            await redrawRuntimes();
            window.uninstallResolver(result);
          };
          window.dshDesktop = new Proxy({}, {get: (_, method) => {
            if (method === 'onRuntimeState') return callback => { runtimeListeners.push(callback); return () => {}; };
            if (method.startsWith('on')) return () => () => {};
            if (method === 'runtimeUninstall') return async payload => {
              const pending = new Promise(resolve => { window.uninstallResolver = resolve; });
              await testRpc('testBeginUninstall', payload);
              await redrawRuntimes();
              return pending;
            };
            return payload => testRpc(method, payload);
          }});
        """)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=kimi', wait_until='networkidle')
        page.evaluate("CamelliaI18n.setLanguage('en')")
        button = page.locator('[data-uninstall=kimi]')
        dialog = page.locator('#runtimeUninstallDialog')
        confirm = page.locator('#confirmRuntimeUninstall')
        expect(button).to_be_visible()
        expect(button).to_have_text('Uninstall')
        button.click()
        expect(dialog).to_be_visible()
        expect(page.locator('#runtimeUninstallOriginal')).to_have_text(original)
        expect(dialog).to_contain_text('Your conversations, accounts and settings are kept.')
        expect(dialog.locator('[autofocus]')).to_be_focused()
        assert not calls, 'Opening the review cannot remove anything'
        for language in ['en', 'zh-CN']:
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
            expect(confirm).to_have_text('Uninstall' if language == 'en' else '卸载')
            for width in [1100, 700, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 900})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, width)
                assert dialog.evaluate('el => el.scrollWidth <= el.clientWidth'), (language, width)
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        expect(button).to_be_focused()
        assert not calls
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.evaluate("CamelliaI18n.setLanguage('en')")
        button.click()
        dialog.locator('.dialog-head button').click()
        expect(dialog).not_to_be_visible()
        assert not calls
        # A failed removal keeps the button available for a retry.
        fail = True
        button.click()
        confirm.click()
        expect(button).to_be_disabled()
        expect(button).to_have_text('Uninstalling…')
        expect(page.locator('#runtime-path-kimi-api')).to_be_disabled()
        page.evaluate('finishUninstall()')
        expect(page.locator('#status')).to_contain_text('Package files are locked')
        expect(button).to_be_enabled()
        fail = False
        button.click()
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            output = repo / 'dist/engine-settings-qa'
            output.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output / f'runtime-uninstall-{scheme}.png'), full_page=True)
        confirm.click()
        expect(button).to_have_text('Uninstalling…')
        page.evaluate('finishUninstall()')
        expect(page.locator('[data-install=kimi]')).to_be_visible()
        expect(button).to_have_count(0)
        expect(page.locator('#status')).to_contain_text('Engine uninstalled')
        assert calls == [{'engine': 'kimi', 'token': 'reviewed-installation'}] * 2
        assert errors == [], errors
        browser.close()
    print('PASS: uninstall confirmation/cancellation, failure/retry, busy controls, download after removal, translations and responsive dialog')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
