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
        page = browser.new_page(viewport={'width':1160,'height':900},reduced_motion='reduce')
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
        # Pi must work through the real desktop settings bridge, including direct
        # navigation, persisted defaults and the instruction document.
        assert set(page.locator('.engine-tabs [data-engine]').evaluate_all('els => els.map(el => el.dataset.engine)')) == {row['id'] for row in rpc('runtimeState')['engines']}
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri()+'?page=engines&engine=pi',wait_until='networkidle')
        expect(page.locator('[data-engine=pi]')).to_have_attribute('aria-selected','true')
        expect(page.locator('#engineScopeTitle')).to_have_text('Pi in Camellia')
        page.locator('[data-field=permissionMode]').select_option('auto')
        page.locator('[data-field=thinkingBudget]').select_option('high')
        page.locator('[data-field=contextWindow]').fill('131072')
        page.locator('#nativeDocuments summary').click()
        page.locator('#engineSource').fill('Follow project conventions.\n保留中文说明。')
        page.locator('#saveEngine').click(); expect(page.locator('#status')).to_contain_text('Pi settings saved')
        saved=rpc('engineSettingsGet',{'engine':'pi'})
        assert saved['desktop']['permissionMode']=='auto'
        assert saved['desktop']['thinkingBudget']=='high'
        assert int(saved['desktop']['contextWindow'])==131072
        assert saved['files'][0]['text']=='Follow project conventions.\n保留中文说明。'
        page.reload(wait_until='networkidle')
        expect(page.locator('[data-field=thinkingBudget]')).to_have_value('high')
        expect(page.locator('[data-field=contextWindow]')).to_have_value('131072')
        page.locator('[data-field=thinkingBudget]').select_option('')
        page.locator('#saveEngine').click(); expect(page.locator('#saveEngine')).to_be_disabled()
        assert rpc('engineSettingsGet',{'engine':'pi'})['desktop']['thinkingBudget']==''
        for language in ['en','zh-CN']:
            page.evaluate('language => CamelliaI18n.setLanguage(language)',language)
            for width in [1160,850,700,390,320]:
                page.set_viewport_size({'width':width,'height':900})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(language,width,'Pi overflow')
                save=page.locator('#saveEngine').bounding_box(); rail=page.locator('.engine-save').bounding_box()
                assert abs(save['x']+save['width']-rail['x']-rail['width'])<2,(language,width,'Pi save alignment')
                expect(page.locator('[data-engine=pi]')).to_be_visible()
        page.set_viewport_size({'width':1160,'height':900})
        for scheme in ['light','dark']:
            page.emulate_media(color_scheme=scheme)
            page.screenshot(path=str(repo/f'dist/engine-settings-qa/pi-{scheme}.png'),full_page=True)
        page.evaluate("CamelliaI18n.setLanguage('en')")
        # Each tab shows only its own installation controls; Python is shared
        # and belongs to General. All engine cards track runtime state updates.
        expect(page.locator('.runtime-card')).to_have_count(1 + len(rpc('runtimeState')['engines']), timeout=30000)
        expect(page.locator('#runtimeCards')).to_contain_text('Installed')
        for row in rpc('runtimeState')['engines']:
            page.locator(f'[data-engine={row["id"]}]').click()
            expect(page.locator('#runtimeCards .runtime-card:visible')).to_have_count(1)
            expect(page.locator('#runtimeCards .runtime-card:visible [data-runtime-status]')).to_be_visible()
            if row['status'] == 'ready':
                expect(page.locator(f'[data-install={row["id"]}]')).to_have_count(0)
            else:
                expect(page.locator(f'[data-install={row["id"]}]')).to_be_visible()
        expect(page.locator('#pythonCard')).to_be_hidden()
        page.locator('[data-view=general]').click()
        expect(page.locator('#pythonCard')).to_be_visible()
        expect(page.locator('#runtimeCards')).to_be_hidden()
        page.locator('[data-view=engines]').click()
        page.locator('[data-engine=dsh]').click()
        native_url=rpc('dshSettingsUrl')['url']
        native=browser.new_page(viewport={'width':920,'height':680})
        native.add_init_script("window.name='workbench-settings'")
        native.on('pageerror',lambda error:errors.append(str(error)))
        native.goto(native_url); native.wait_for_load_state('domcontentloaded')  # DSH keeps its event connection open; wait for the panel below.
        expect(native.locator('.workbench-native-settings')).to_be_visible(timeout=60000)
        assert native.locator('.workbench-native-settings').evaluate('el => el.parentElement === document.body')
        native.set_viewport_size({'width':560,'height':480})
        expect(native.locator('.workbench-native-nav')).to_be_visible()
        # Native sidebar animations must not clip or hide the embedded surface.
        native.locator('body').evaluate("el => {for (const child of el.children) if (!child.classList.contains('workbench-native-settings') && child.tagName !== 'STYLE') {child.style.opacity='0';child.style.overflow='hidden';child.style.transform='translateX(-100%)';}}")
        expect(native.locator('.workbench-native-settings')).to_be_visible()
        assert native.locator('.workbench-native-settings').evaluate('el => document.elementFromPoint(50,50)?.closest(".workbench-native-settings") === el')
        nav=native.locator('.workbench-native-nav')
        print('DSH native sections:',nav.inner_text())
        expect(nav).to_contain_text('Providers & Keys')
        native.screenshot(path=str(repo/'dist/engine-settings-qa/dsh-native.png'),full_page=True)
        # The desktop composition uses Camellia's language without changing the
        # standalone DSH preference or exposing a second language selector.
        rpc('workbenchSaveSettings', {'language':'zh-CN','theme':'system','autoRefreshBalances':False})
        native.expose_function('testPreferences', lambda: rpc('workbenchSettings'))
        native.add_init_script("""window.nativeLanguageListeners=[];
          window.dshDesktop={settingsEmbedded:true,nativeSettingsReady:()=>{},openSettingsWindow:()=>{},
            workbenchSettings:()=>window.testPreferences(),
            onLanguageChanged:fn=>{nativeLanguageListeners.push(fn);return()=>{};}};""")
        native.reload(wait_until='domcontentloaded')
        expect(native.locator('.workbench-native-nav')).to_contain_text('通用设置', timeout=60000)
        expect(native.locator('.workbench-native-nav')).to_contain_text('供应商与 Key')
        native.evaluate("nativeLanguageListeners.forEach(fn=>fn('en'))")
        expect(native.locator('.workbench-native-nav')).to_contain_text('General')
        expect(native.locator('.workbench-native-content').get_by_text('Language',exact=True)).to_have_count(0)
        native.close()
        assert errors==[],errors
        browser.close()
    print('PASS: Claude/Kimi/Pi settings, Pi persistence and instructions, responsive action alignment, MCP, validation, runtime status, DSH native settings and unified API navigation')
finally:
    try: rpc('cleanup')
    finally: driver.terminate(); driver.wait(timeout=10)
