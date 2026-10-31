"""Runtime update state survives navigation, redraws and reopening Settings."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/claude-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
updating = set()
versions = {'claude': '1.0.0', 'kimi': '1.0.0', 'antigravity': '1.2.14'}
calls = []
cli_error = None
cli_check_mode = 'subscription'
check_calls = 0
update_info = {}


def rpc(method, payload=None):
    global check_calls, update_info
    if method == 'testBeginUpdate':
        calls.append(payload['engine'])
        updating.add(payload['engine'])
        return {'ok': True}
    if method == 'testFinishUpdate':
        engine = payload['engine']
        updating.discard(engine)
        if payload.get('fail'):
            return {'ok': False, 'error': 'Fixture update failed'}
        versions[engine] = '2.0.0'
        return {'ok': True, 'engine': engine, 'changed': True, 'to': '2.0.0'}
    if method == 'runtimeCheckUpdates':
        check_calls += 1
        engines = [dict(id=engine, mode=cli_check_mode if engine == 'antigravity' else 'api',
            checkable=True, installed=version, latest=None if engine == 'antigravity' and cli_error else '2.0.0',
            error=cli_error if engine == 'antigravity' else None,
            updateAvailable=version != '2.0.0' and not (engine == 'antigravity' and cli_error)) for engine, version in versions.items()]
        update_info = {row['id']: row for row in engines}
        return {'ok': True, 'engines': engines}
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    result = response['result']
    if method == 'runtimeState':
        for row in result['engines']:
            row['updating'] = row['id'] in updating
            if row['id'] in versions:
                row.update(status='ready', version=versions[row['id']])
            if row['id'] == 'antigravity':
                row.update(mode='subscription', external=False, file='C:/fixture/agy.exe')
                row['subscriptionRuntime'] = dict(row)
            info = update_info.get(row['id'])
            row['updateInfo'] = info if info and info['installed'] == row.get('version') and info['mode'] == row.get('mode', 'api') else None
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
          window.updateResolvers = {};
          window.redrawRuntimes = async () => {
            const result = await testRpc('runtimeState');
            runtimeListeners.forEach(listener => listener(result.engines));
          };
          window.finishUpdate = async (engine, fail = false) => {
            const result = await testRpc('testFinishUpdate', {engine, fail});
            await redrawRuntimes();
            updateResolvers[engine]?.(result);
          };
          window.dshDesktop = new Proxy({}, {get: (_, method) => {
            if (method === 'onRuntimeState') return callback => { runtimeListeners.push(callback); return () => {}; };
            if (method === 'onSettingsNavigate') return callback => { window.settingsNavigate = callback; return () => {}; };
            if (method.startsWith('on')) return () => () => {};
            if (method === 'runtimeState') return async payload => {
              const result = await testRpc(method, payload);
              window.runtimeStateReads = (window.runtimeStateReads || 0) + 1;
              return result;
            };
            if (method === 'runtimeCheckUpdates') return payload => {
              window.runtimeCheckCalls = (window.runtimeCheckCalls || 0) + 1;
              return testRpc(method, payload);
            };
            if (method === 'runtimeUpdate') return async payload => {
              const result = new Promise(resolve => { updateResolvers[payload.engine] = resolve; });
              await testRpc('testBeginUpdate', payload);
              await redrawRuntimes();
              return result;
            };
            return payload => testRpc(method, payload);
          }});
        """)
        url = (repo / 'src/renderer/settings/api-settings.html').as_uri()
        # Home has already checked before displaying its update reminder.
        rpc('runtimeCheckUpdates')
        page.goto(url + '?page=engines&engine=claude&focus=updates', wait_until='networkidle')
        expect(page.locator('.engine-runtime > .download-save .hint')).to_have_text(
            'Updating temporarily pauses this engine.')
        claude = page.locator('[data-update=claude]')
        kimi = page.locator('[data-update=kimi]')
        expect(claude).to_be_enabled()
        assert check_calls == 1, 'New Settings must reuse the Home check'
        page.locator('[data-view=general]').click()
        state_reads = page.evaluate('runtimeStateReads')
        page.evaluate("settingsNavigate({page: 'engines', engine: 'claude', focus: 'updates'})")
        page.wait_for_function(f'runtimeStateReads > {state_reads}')
        expect(claude).to_be_enabled()
        assert check_calls == 1, 'An already open Settings window must also reuse the check'
        claude.click()
        expect(claude).to_be_disabled()
        expect(claude).to_have_text('Updating…')
        expect(page.locator('[data-install=claude]')).to_have_count(0)
        expect(page.locator('#runtime-path-claude-api')).to_be_disabled()
        expect(page.locator('.runtime-card:visible [data-runtime-status]')).to_have_text('Updating…')
        page.locator('[data-engine=kimi]').click()
        expect(kimi).to_be_enabled()
        kimi.click()
        expect(kimi).to_be_disabled()
        page.locator('[data-engine=claude]').click()
        expect(claude).to_be_visible()
        expect(claude).to_be_disabled()
        expect(claude).to_have_text('Updating…')
        page.locator('#checkRuntimeUpdates').click()
        expect(page.locator('#checkRuntimeUpdates')).to_be_enabled()
        assert check_calls == 2, 'The explicit check button must still refresh'
        expect(claude).to_be_disabled()
        page.evaluate('redrawRuntimes()')
        expect(claude).to_have_text('Updating…')
        assert calls == ['claude', 'kimi'], calls
        page.evaluate("finishUpdate('claude')")
        expect(claude).to_have_count(0)
        page.locator('[data-engine=kimi]').click()
        expect(kimi).to_have_text('Updating…')
        expect(kimi).to_be_disabled()
        page.evaluate("finishUpdate('kimi', true)")
        expect(kimi).to_be_enabled()
        expect(page.locator('#status')).to_have_text('Fixture update failed')
        kimi.click()
        expect(kimi).to_be_disabled()
        page.wait_for_function("!!updateResolvers.kimi")
        page.evaluate('redrawRuntimes()')
        assert 'kimi' in updating
        page.reload(wait_until='networkidle')
        page.locator('[data-engine=kimi]').click()
        expect(kimi).to_be_visible()
        expect(kimi).to_be_disabled()
        expect(kimi).to_have_text('Updating…')
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(kimi).to_have_text('正在更新…')
        expect(page.locator('.engine-runtime > .download-save .hint')).to_have_text(
            '更新期间此引擎会暂停使用。')
        page.evaluate("finishUpdate('kimi')")
        expect(kimi).to_have_count(0)
        assert calls == ['claude', 'kimi', 'kimi'], calls
        page.evaluate("CamelliaI18n.setLanguage('en')")
        page.locator('[data-engine=antigravity]').click()
        cli = page.locator('[data-update=antigravity]')
        expect(cli).to_be_visible()
        expect(page.locator('.runtime-card:visible')).to_contain_text('Google subscription')
        cli.click()
        expect(cli).to_have_text('Updating…')
        expect(cli).to_be_disabled()
        page.evaluate("finishUpdate('antigravity')")
        expect(cli).to_have_count(0)
        expect(page.locator('.runtime-card:visible')).to_contain_text('Up to date')
        versions['antigravity'] = '1.2.14'
        cli_error = 'TLS connection failed'
        page.evaluate('redrawRuntimes()')
        page.locator('#checkRuntimeUpdates').click()
        expect(page.locator('.runtime-card:visible')).to_contain_text('Update check failed')
        expect(page.locator('.runtime-card:visible')).to_contain_text('TLS connection failed')
        expect(cli).to_have_count(0)
        cli_error = None
        cli_check_mode = 'api'
        page.locator('#checkRuntimeUpdates').click()
        expect(page.locator('.runtime-card:visible')).to_contain_text('Installed')
        expect(cli).to_have_count(0)
        cli_check_mode = 'subscription'
        page.locator('#checkRuntimeUpdates').click()
        expect(cli).to_be_visible()
        # A cold update link can still check when no completed result exists.
        previous_checks = check_calls
        window_checks = page.evaluate('window.runtimeCheckCalls || 0')
        update_info = {}
        page.evaluate("settingsNavigate({page: 'engines', engine: 'antigravity', focus: 'updates'})")
        page.wait_for_function(f"window.runtimeCheckCalls > {window_checks} && !document.getElementById('checkRuntimeUpdates').disabled && !!document.querySelector('[data-update=antigravity]')")
        expect(cli).to_be_enabled()
        assert check_calls == previous_checks + 1
        screenshots = repo / 'dist/antigravity-updates-qa'
        screenshots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshots / 'settings-en.png'), full_page=True)
        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        page.screenshot(path=str(screenshots / 'settings-zh.png'), full_page=True)
        assert calls == ['claude', 'kimi', 'kimi', 'antigravity'], calls
        assert not errors, errors
        browser.close()
        print('Runtime updates UI: navigation, updates, native CLI errors, SDK/CLI mode isolation and translation passed')
finally:
    driver.terminate()
    driver.wait(timeout=10)
