"""External CLI reinstall: immediate visibility, cancellation, busy state and managed updates."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
external = True
reinstalling = False
calls = []
previews = []
original = r'C:\CLI\npm-cache\_npx\cached-cli\node_modules\@moonshot-ai\kimi-code\dist\main.mjs'
managed = r'C:\Camellia\runtimes\kimi\node_modules\@moonshot-ai\kimi-code\dist\main.mjs'


def rpc(method, payload=None):
    global external, reinstalling
    if method == 'runtimeReinstallPreview':
        previews.append(payload)
        return {'ok': True, 'engine': 'kimi', 'name': 'Kimi Code', 'token': f'preview-{len(previews)}',
                'file': original, 'destination': r'C:\Camellia\runtimes\kimi'}
    if method == 'testFinishReinstall':
        reinstalling = False
        if payload.get('canceled'):
            return {'ok': True, 'canceled': True}
        if payload.get('fail'):
            return {'ok': False, 'error': 'Fixture reinstall failed'}
        external = False
        return {'ok': True, 'engine': 'kimi', 'changed': True, 'to': '2.0.0'}
    if method == 'testBeginReinstall':
        calls.append(payload)
        reinstalling = True
        return {'ok': True}
    if method == 'runtimeCheckUpdates':
        return {'ok': True, 'engines': [{'id': 'kimi', 'external': external, 'checkable': not external,
            'installed': '1.0.0' if external else '2.0.0', 'latest': '2.1.0', 'updateAvailable': not external}]}
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    result = response['result']
    if method == 'runtimeState':
        row = next(row for row in result['engines'] if row['id'] == 'kimi')
        row.update(status='ready', external=external, updating=reinstalling, reinstalling=reinstalling,
                   version='1.0.0' if external else '2.0.0', file=original if external else managed,
                   source='Custom local path' if external else 'Installed by Camellia',
                   customPath=original if external else '', paths={'api': original if external else ''})
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
            const result = await testRpc('runtimeState');
            runtimeListeners.forEach(listener => listener(result.engines));
          };
          window.finishReinstall = async (options = {}) => {
            const result = await testRpc('testFinishReinstall', options);
            await redrawRuntimes();
            window.reinstallResolver?.(result);
          };
          window.dshDesktop = new Proxy({}, {get: (_, method) => {
            if (method === 'onRuntimeState') return callback => { runtimeListeners.push(callback); return () => {}; };
            if (method.startsWith('on')) return () => () => {};
            if (method === 'runtimeReinstall') return async payload => {
              const pending = new Promise(resolve => { window.reinstallResolver = resolve; });
              await testRpc('testBeginReinstall', payload);
              await redrawRuntimes();
              return pending;
            };
            return payload => testRpc(method, payload);
          }});
        """)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=engines&engine=kimi',
                  wait_until='networkidle')
        button = page.locator('[data-reinstall=kimi]')
        path_input = page.locator('#runtime-path-kimi-api')
        expect(button).to_be_visible()
        expect(button).to_be_enabled()
        expect(button).to_have_text('Use Camellia')
        expect(path_input).to_have_value(original)
        expect(page.locator('[data-reinstall=codex]')).to_have_count(0)
        page.locator('#checkRuntimeUpdates').click()
        expect(button).to_be_enabled()
        expect(page.locator('.runtime-external-update:visible')).to_contain_text('Update this CLI using its original installer')
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(button).to_have_text('交给 Camellia')
        (repo / 'dist/engine-settings-qa').mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(repo / 'dist/engine-settings-qa/runtime-reinstall.png'), full_page=True)
        for width in [1100, 700, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            expect(button).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        page.set_viewport_size({'width': 1100, 'height': 900})
        dialog = page.locator('#runtimeReinstallDialog')
        confirm = page.locator('#confirmRuntimeReinstall')
        cancel = dialog.locator('.runtime-reinstall-actions [value=cancel]')
        button.click()
        expect(dialog).to_be_visible()
        expect(page.locator('#runtimeReinstallTitle')).to_have_text('重新安装 Kimi Code')
        expect(page.locator('#runtimeReinstallOriginal')).to_have_text(original)
        expect(page.locator('#runtimeReinstallDestination')).to_have_text(r'C:\Camellia\runtimes\kimi')
        expect(dialog).to_contain_text('会话和账号设置会保留。')
        expect(cancel).to_be_focused()
        assert not calls, 'Opening the dialog cannot start installation'
        assert page.evaluate("""(() => {
          const dialog = getComputedStyle(document.querySelector('#runtimeReinstallDialog'));
          const existing = getComputedStyle(document.querySelector('#addDialog'));
          return dialog.borderRadius === existing.borderRadius && dialog.borderRadius === '18px'
            && dialog.fontFamily === getComputedStyle(document.body).fontFamily;
        })()"""), 'Reinstall dialog shares Camellia typography and surface styling'
        for scheme in ['light', 'dark']:
            page.emulate_media(color_scheme=scheme)
            page.screenshot(path=str(repo / f'dist/engine-settings-qa/runtime-reinstall-dialog-{scheme}.png'), full_page=True)
        for width in [700, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            bounds = dialog.bounding_box()
            assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width, (width, bounds)
            assert dialog.evaluate('d => d.scrollWidth <= d.clientWidth'), width
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.emulate_media(color_scheme='light')
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        expect(button).to_be_enabled()
        expect(button).to_be_focused()
        expect(path_input).to_have_value(original)
        assert not calls
        button.click()
        expect(dialog).to_be_visible()
        dialog.locator('.dialog-head button').click()
        expect(dialog).not_to_be_visible()
        expect(button).to_be_enabled()
        assert not calls
        button.click()
        expect(dialog).to_be_visible()
        cancel.click()
        expect(dialog).not_to_be_visible()
        expect(button).to_be_enabled()
        assert not calls
        button.click()
        expect(dialog).to_be_visible()
        confirm.click()
        expect(dialog).not_to_be_visible()
        expect(button).to_be_disabled()
        expect(button).to_have_text('正在重新安装…')
        expect(path_input).to_be_disabled()
        page.evaluate('finishReinstall({fail: true})')
        expect(button).to_be_enabled()
        expect(page.locator('#status')).to_have_text('Fixture reinstall failed')
        # Escape after a previous confirmation must still cancel.
        button.click()
        expect(dialog).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        expect(button).to_be_enabled()
        assert len(calls) == 1
        # An unsaved draft must not reappear after the override is cleared.
        path_input.fill('C:\\unsaved-cli.mjs')
        button.click()
        expect(dialog).to_be_visible()
        expect(page.locator('#runtimeReinstallOriginal')).to_have_text(original)
        confirm.click()
        expect(dialog).not_to_be_visible()
        expect(button).to_be_disabled()
        page.locator('[data-engine=codex]').click()
        page.locator('[data-engine=kimi]').click()
        expect(button).to_be_disabled()
        page.evaluate('redrawRuntimes()')
        expect(button).to_have_text('正在重新安装…')
        page.evaluate('finishReinstall()')
        expect(button).to_have_count(0)
        expect(path_input).to_have_value('')
        expect(page.locator('.runtime-card:visible')).to_contain_text('由 Camellia 安装')
        expect(page.locator('.runtime-installation-path:visible code')).to_have_text(managed)
        expect(page.locator('[data-update=kimi]')).to_be_enabled()
        expect(page.locator('#status')).to_have_text('已由 Camellia 重新安装，后续可在此更新。')
        page.reload(wait_until='networkidle')
        expect(button).to_have_count(0)
        expect(path_input).to_have_value('')
        assert calls == [{'engine': 'kimi', 'token': 'preview-4'}, {'engine': 'kimi', 'token': 'preview-6'}], calls
        assert not errors, errors
        browser.close()
        print('Runtime reinstall UI: themed light/dark dialog, long paths, responsive layout, Escape/close/cancel, confirmation, failure, busy state and managed updates passed')
finally:
    driver.terminate()
    driver.wait(timeout=10)
