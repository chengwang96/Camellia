"""Real desktop IPC + Chromium + loopback model service; no external API calls."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

repo=Path(__file__).resolve().parents[1]
driver=subprocess.Popen(['node',str(repo/'tests/claude-ui-driver.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
def rpc(method,payload=None):
    driver.stdin.write(json.dumps({'method':method,'payload':payload})+'\n');driver.stdin.flush()
    line=driver.stdout.readline()
    if not line: raise RuntimeError(driver.stderr.read())
    response=json.loads(line)
    if 'error' in response: raise RuntimeError(response['error'])
    return response
bridge=r"""(() => {
  let onRouter=()=>{},onEvent=()=>{},onGoal=()=>{},onInsights=()=>{};
  window.testEmitInsights=data=>onInsights(data);
  window.testCall=async(method,payload)=>{
    const r=await window.testRpc(method,payload);
    for(const e of r.events||[]){if(e.channel==='dsh:api-router-state')onRouter(e.data);if(e.channel==='dsh:claude-event')onEvent(e.data);if(e.channel==='dsh:claude-goal')onGoal(e.data);if(e.channel==='dsh:provider-insights')onInsights(e.data);}
    return r.result;
  };
  window.dshDesktop=new Proxy({},{get:(_,m)=>m.startsWith('on')&&!['onApiRouterState','onClaudeEvent','onClaudeGoal','onProviderInsights'].includes(m)?()=>()=>{}:m==='onApiRouterState'?f=>onRouter=f:m==='onClaudeEvent'?f=>onEvent=f:m==='onClaudeGoal'?f=>onGoal=f:m==='onProviderInsights'?f=>onInsights=f:p=>window.testCall(m,p)});
})();"""
def assert_back_button_spacing(page):
    button=page.locator('#backProviders')
    button.hover()
    spacing=button.evaluate("""button => {
      const bounds = button.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(button);
      const textBounds = text.getBoundingClientRect();
      return {left: textBounds.left - bounds.left, right: bounds.right - textBounds.right,
        fits: button.scrollWidth <= button.clientWidth};
    }""")
    assert spacing['left'] >= 12 and spacing['right'] >= 12 and spacing['fits'], spacing

try:
    port=rpc('freePort')['result']; upstream=rpc('startTestUpstream')['result']
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1040,'height':900})
        errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
        page.expose_function('testRpc',rpc);page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri());page.wait_for_load_state('networkidle')
        page.locator('[data-view=providers]').click()
        expect(page.locator('#providers')).to_contain_text('Add your first provider')
        page.locator('.router-options > summary').click()
        page.locator('#port').fill(str(port))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('ollama');page.locator('#confirmAdd').click()
        assert_back_button_spacing(page)
        page.locator('#connectionAdvanced > summary').click()
        page.locator('#pUrl').fill(upstream+'/ollama/v1')
        page.get_by_role('textbox',name='API Key 1',exact=True).fill('test-exhausted-account')
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        expect(page.get_by_role('textbox',name='API Key 1',exact=True)).to_have_value('')
        page.locator('#addProvider').click();page.locator('#preset').select_option('commandcode');page.locator('#confirmAdd').click()
        page.locator('#connectionAdvanced > summary').click()
        expect(page.locator('#pUrl')).to_have_value('https://api.commandcode.ai/provider/v1')
        page.locator('#pUrl').fill(upstream+'/command/v1')
        page.get_by_role('textbox',name='API Key 1',exact=True).fill('test-command-account')
        expect(page.locator('#pPriority')).to_have_value('0')
        expect(page.locator('#pPriority option')).to_have_text(['Low', 'Default', 'High'])
        page.locator('#pPriority').select_option('1')
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        state=rpc('apiRouterGetState')['result'];assert len(state['providers'])==2
        assert state['providers'][1]['priority']==1
        assert 'test-command-account' not in json.dumps(state)
        result=rpc('routerRequest','kimi-k3')['result'];assert result['status']==200
        page.locator('#refresh').click();expect(page.locator('#live')).to_contain_text('Command Code GOAT')
        expect(page.locator('#keyRows')).to_contain_text('1 successful')
        # Reordering keeps credentials and usage attached to the same IDs.
        page.locator('#backProviders').click()
        for width, columns in [(600, 1), (760, 1), (960, 2), (1040, 2), (1160, 2), (1440, 3), (1840, 4)]:
            page.set_viewport_size({'width':width,'height':900})
            layout=page.locator('#providers').evaluate('''grid => ({
                columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
                fits: grid.scrollWidth <= grid.clientWidth,
                cards: [...grid.children].map(card => {
                    const badge = card.querySelector('.badge').getBoundingClientRect();
                    const requests = card.querySelector('.provider-footer small').getBoundingClientRect();
                    return {height: card.getBoundingClientRect().height, width: card.getBoundingClientRect().width,
                        fits: card.scrollWidth <= card.clientWidth,
                        sameRow: Math.abs(badge.y + badge.height / 2 - requests.y - requests.height / 2) < 1};
                })
            })''')
            assert layout['columns']==columns, (width, layout)
            assert layout['fits'], (width, layout)
            assert all(card['width'] <= 420 and card['fits'] and card['height'] < 150 for card in layout['cards']), (width, layout)
            if width >= 1040:
                assert all(card['sameRow'] for card in layout['cards']), (width, layout)
        page.set_viewport_size({'width':1040,'height':900})
        page.get_by_role('button',name='Move up Command Code GOAT',exact=True).click()
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        page.reload();page.wait_for_load_state('networkidle')
        page.locator('[data-view=providers]').click()
        expect(page.locator('.provider').first).to_contain_text('Command Code GOAT')
        page.locator('.provider [data-select]').first.click()
        expect(page.locator('#pPriority')).to_have_value('1')
        page.locator('#pPriority').select_option('-1');page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        assert rpc('apiRouterGetState')['result']['providers'][0]['priority']==-1
        expect(page.locator('#pPriority')).to_have_value('-1')
        page.locator('#pPriority').select_option('0');page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        assert rpc('apiRouterGetState')['result']['providers'][0]['priority']==0
        page.locator('#pPriority').select_option('1');page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('Saved')
        expect(page.locator('#keyRows')).to_contain_text('1 successful')
        page.locator('#connectionAdvanced > summary').click()
        page.locator('#pUrl').fill('http://remote.invalid/v1');page.locator('#save').click()
        expect(page.locator('#status')).to_contain_text('HTTPS')
        assert rpc('apiRouterGetState')['result']['providers'][0]['baseUrl']==upstream+'/command/v1'
        page.locator('#pUrl').fill(upstream+'/command/v1');page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        # DeepSeek preset is available without inventing equivalence for aliases.
        page.locator('#addProvider').click();page.locator('#preset').select_option('deepseek');page.locator('#confirmAdd').click()
        expect(page.locator('#pAUrl')).to_have_value('https://api.deepseek.com/anthropic/v1')
        expect(page.locator('#modelRows tr')).to_have_count(0)
        page.locator('#deleteProvider').click();page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        # New models appear in Claude; workspace behavior is checked separately.
        claude=browser.new_page(viewport={'width':1320,'height':900});claude.expose_function('testRpc',rpc);claude.add_init_script(bridge)
        claude.on('pageerror',lambda e:errors.append(str(e)))
        claude.goto((repo/'src/renderer/chat/claude.html').as_uri());claude.wait_for_load_state('networkidle')
        assert 'kimi-k3' in claude.evaluate('MODELS.map(m=>m.id)')
        assert 'kimi-k2.6' in claude.evaluate('MODELS.map(m=>m.id)')
        assert claude.evaluate('currentModel')==''
        # Legacy :cloud IDs and the router's canonical ID represent one model.
        legacy_model = 'deepseek-v4.1-flash:cloud'
        canonical_model = 'deepseek-v4.1-flash'
        rpc('claudeSaveSettings', {'model': legacy_model})
        claude.reload(); claude.wait_for_load_state('networkidle')

        def check_model_menu(label, count):
            claude.locator('#modelPill').click()
            claude.locator('.dsh-pop .pop-row').first.click()
            expect(claude.locator('.pop-opt')).to_have_count(count)
            expect(claude.locator('.pop-opt').filter(has_text=canonical_model)).to_have_count(1)
            expect(claude.locator('.pop-opt.current')).to_have_text(label)
            claude.locator('#modelPill').click()

        configured = rpc('apiRouterGetState')['result']
        check_model_menu(canonical_model, len(configured['models']))
        assert rpc('claudeGetSettings')['result']['model'] == legacy_model
        # Repeated router updates keep one checked entry and never change model.
        for _ in range(2):
            claude.evaluate("state => window.testCall('apiRouterSaveConfig', state)", configured)
            check_model_menu(canonical_model, len(configured['models']))
        (repo/'dist/ui-preview').mkdir(parents=True, exist_ok=True)
        claude.locator('#modelPill').click()
        claude.locator('.dsh-pop .pop-row').first.click()
        claude.screenshot(path=str(repo/'dist/ui-preview/claude-models-deduplicated.png'))
        claude.locator('#modelPill').click()
        # Removing/restoring routes preserves the selected model exactly once.
        removed = json.loads(json.dumps(configured))
        for provider in removed['providers']:
            provider['models'] = [m for m in provider['models'] if m['id'] != canonical_model]
        claude.evaluate("state => window.testCall('apiRouterSaveConfig', state)", removed)
        check_model_menu(canonical_model + ' (no route configured)', len(configured['models']))
        claude.evaluate("state => window.testCall('apiRouterSaveConfig', state)", configured)
        check_model_menu(canonical_model, len(configured['models']))
        claude.locator('#modelPill').click()
        claude.locator('.dsh-pop .pop-row').first.click()
        claude.locator('.pop-opt').filter(has_text='deepseek-v4-pro').click()
        expect(claude.locator('#statusLine')).to_contain_text('Model changed: deepseek-v4-pro')
        assert rpc('claudeGetSettings')['result']['model'] == 'deepseek-v4-pro'
        claude.reload(); claude.wait_for_load_state('networkidle')
        check_model_menu('deepseek-v4-pro', len(configured['models']))
        page.locator('#refresh').click();page.wait_for_load_state('networkidle')
        # Bulk import, model discovery and verification exercise real IPC against
        # the loopback provider, including masked saves and usage attribution.
        page.locator('.provider [data-select]').first.click()
        page.locator('#showImport').click()
        page.locator('#bulkKeys').fill('test-command-account\ntest-command-extra\ntest-command-extra')
        page.locator('#importKeys').click()
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        expect(page.locator('.key-card')).to_have_count(2)
        page.get_by_role('textbox',name='Key label 2',exact=True).fill('Backup account')
        page.locator('#discoverModels').click()
        expect(page.locator('#catalogList input')).to_have_count(2)
        page.locator('#modelSearch').fill('model-test')
        page.locator('#catalogList input').check();page.locator('#applyModels').click()
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        page.locator('#verifyModel').select_option('model-test')
        page.locator('[data-verify]').nth(1).click();expect(page.locator('#status')).to_contain_text('Validation succeeded for model-test')
        # The verify button next to the model picker validates with the first usable key.
        page.locator('#verifyNow').click();expect(page.locator('#status')).to_contain_text('Validation succeeded for model-test')
        expect(page.locator('.key-card').nth(1)).to_contain_text('Model verified')
        state=rpc('apiRouterGetState')['result'];extra=state['providers'][0]['keys'][1]['id']
        assert state['usage'][extra]['requests']==0, 'Connection checks are not business usage'
        assert rpc('routerRequest','model-test')['result']['status']==200
        page.locator('#refresh').click()
        page.locator('[data-view=usage]').click()
        page.locator('#usageModel').select_option('model-test')
        expect(page.locator('#usageRows tr')).to_have_count(1)
        expect(page.locator('#usageRows')).to_contain_text('model-test')
        expect(page.locator('#usageChart [data-chart-kind=usage] svg')).to_have_count(1)
        expect(page.locator('#usageChart h3')).to_contain_text(['model-test'])
        page.locator('#usageKey').select_option(extra)
        expect(page.locator('#usageRows')).to_contain_text('No requests in this period')
        expect(page.locator('#usageChart .chart-empty')).to_have_count(1)
        page.locator('#usageKey').select_option('');page.locator('#usageModel').select_option('')
        with page.expect_download() as download:
            page.locator('#exportUsage').click()
        assert download.value.suggested_filename.endswith('.csv')
        page.screenshot(path=str(repo/'dist/ui-preview/settings-usage.png'))
        # Account responses are fixtures: no real provider credentials or calls.
        state=rpc('apiRouterGetState')['result'];command,ollama=state['providers'];key=command['keys'][0]['id']
        balances=[{'id':'credits','label':'Remaining credits','value':125.5,'currency':'credits','parts':[]}]
        windows=[{'id':'monthly','label':'Monthly','usedPercent':28,'resetsAt':None},
                 {'id':'session','label':'Current session','usedPercent':10,'resetsAt':None},
                 {'id':'weekly','label':'Weekly','usedPercent':45,'resetsAt':None}]
        snapshot={'ok':True,'providers':{
            command['id']:{'supported':True,'label':'Command Code Credits','source':'client'},
            ollama['id']:{'supported':True,'label':'Ollama Cloud quota','source':'observed'}},'keys':{}}
        from datetime import datetime, timedelta, timezone
        now=datetime.now(timezone.utc)
        for provider in [command,ollama]:
            for k in provider['keys']:
                cash=balances if provider==command else []
                quota=windows if provider==ollama else []
                snapshot['keys'][k['id']]={'status':'ok','latest':{'at':now.isoformat(),'balances':cash,'windows':quota,'modelUsage':[]},'history':[
                    {'at':(now-timedelta(hours=2)).isoformat(),'balances':[dict(b,value=132) for b in cash],'windows':[dict(w,usedPercent=14) for w in quota]},
                    {'at':now.isoformat(),'balances':cash,'windows':quota}]}
        page.evaluate('s=>window.testEmitInsights(s)',snapshot)
        page.locator('[data-view=usage]').click()
        page.locator('#balanceSearch').fill('Backup account')
        expect(page.locator('.balance-card')).to_have_count(1)
        page.locator('#balanceSearch').fill('')
        for width, columns in [(600, 1), (760, 1), (960, 2), (1040, 2), (1160, 2), (1440, 3), (1840, 4)]:
            page.set_viewport_size({'width':width,'height':1200})
            layout=page.locator('#balanceCards').evaluate('''grid => ({
                columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
                fits: grid.scrollWidth <= grid.clientWidth,
                widths: [...grid.children].map(card => card.getBoundingClientRect().width),
                heights: [...grid.children].map(card => card.getBoundingClientRect().height)
            })''')
            assert layout['columns']==columns, (width, layout)
            assert layout['fits'], (width, layout)
            assert all(height < 160 for height in layout['heights']), (width, layout)
            assert all(card_width <= 420 for card_width in layout['widths']), (width, layout)
        page.locator('[data-balance="'+key+'"]').click()
        expect(page.locator('#balanceDetail')).to_have_count(0)
        expect(page.locator('.balance-card.selected')).to_contain_text('125.5 Credits')
        expect(page.locator('#usageChart [data-chart-kind=quota] .chart-dot')).to_have_count(2)
        expect(page.locator('#usageKey')).to_have_value(key)
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_have_count(2)
        page.locator('#usageMetric').select_option('requests')
        expect(page.locator('#usageChart [data-chart-kind=usage]').first).to_contain_text('Successful requests')
        page.locator('#usageModel').select_option('model-test')
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_have_count(1)
        expect(page.locator('#usageChart [data-chart-kind=quota]')).to_have_count(1)
        page.locator('#usageModel').select_option('')
        page.set_viewport_size({'width':1280,'height':1200})
        page.mouse.move(0,0)
        page.screenshot(path=str(repo/'dist/ui-preview/settings-balances.png'))
        snapshot['keys'][key]['status']='error'
        snapshot['keys'][key]['error']='<img src=x onerror="window.xss=1">'
        page.evaluate('s=>window.testEmitInsights(s)',snapshot)
        expect(page.locator('.balance-card.selected')).to_contain_text('last successful result')
        expect(page.locator('.balance-card.selected')).to_contain_text('125.5 Credits')
        expect(page.locator('.balance-card.selected img')).to_have_count(0)
        assert page.evaluate('window.xss') is None
        ollama_key=ollama['keys'][0]['id']
        page.evaluate('''key => {
            const today = localDay(new Date());
            const stats = {requests: 3, inputTokens: 120, outputTokens: 30};
            live.usage[key] = {...stats, byModel: {'model-test': stats}, daily: {[today]: {'model-test': stats}}};
        }''', ollama_key)
        page.locator('[data-balance="'+ollama_key+'"]').click()
        expect(page.locator('.balance-card.selected')).to_contain_text('72% remaining')
        expect(page.locator('#usageChart [data-chart-kind=quota] svg')).to_have_count(3)
        expect(page.locator('#usageChart [data-chart-kind=quota] .chart-dot')).to_have_count(6)
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_have_count(1)
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_contain_text('Ollama Cloud')
        page.locator('#usageProvider').select_option('')
        page.locator('#usageKey').select_option('')
        page.locator('#usageModel').select_option('model-test')
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_have_count(2)
        page.locator('#usageKey').select_option(key)
        expect(page.locator('.balance-card.selected')).to_have_attribute('data-balance', key)
        expect(page.locator('#usageChart [data-chart-kind=quota]')).to_have_count(1)
        page.locator('[data-balance="'+ollama_key+'"]').click()
        page.locator('#usageMetric').select_option('tokens')
        for width in [760, 960, 1160, 1840, 1440]:
            page.set_viewport_size({'width':width,'height':1200})
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            for selector in ['#usageChart']:
                expect(page.locator(selector+' [data-chart-kind=quota] svg')).to_have_count(3)
                page.wait_for_function('''selector => {
                    const grid = document.querySelector(selector);
                    const columns = Math.max(1, Math.floor((grid.clientWidth + 12) / 332));
                    return getComputedStyle(grid).gridTemplateColumns.split(' ').length === columns &&
                        [...grid.querySelectorAll('svg')].every(chart =>
                            Math.abs(Number(chart.getAttribute('width')) - chart.parentElement.clientWidth) <= 1);
                }''', arg=selector)
                assert page.locator(selector).evaluate('grid => grid.scrollWidth <= grid.clientWidth')
                assert page.locator(selector).evaluate('''grid => [...grid.children].every(card =>
                    Math.abs(card.getBoundingClientRect().width - document.querySelector('.balance-card').getBoundingClientRect().width) < 1)''')
                for chart in page.locator(selector+' svg').all():
                    dimensions=chart.evaluate('''chart => ({height: chart.getBoundingClientRect().height,
                        labelSize: parseFloat(getComputedStyle(chart.querySelector('text')).fontSize) * chart.getScreenCTM().a})''')
                    assert abs(dimensions['height'] - 248) < 1, dimensions
                    assert 12 <= dimensions['labelSize'] <= 14, dimensions
        page.locator('#usageChart').scroll_into_view_if_needed()
        quota_chart=page.locator('#usageChart [data-chart-kind=quota]').first
        quota_svg=quota_chart.locator('svg')
        quota_svg.hover(position={'x':80,'y':100})
        expect(quota_chart.locator('.chart-tooltip')).to_be_visible()
        expect(quota_chart.locator('.chart-tooltip strong')).to_have_text('86%')
        last_dot=quota_chart.locator('.chart-dot').last
        last_dot.focus()
        expect(quota_chart.locator('.chart-tooltip strong')).to_have_text('72%')
        page.keyboard.press('Escape')
        expect(quota_chart.locator('.chart-tooltip')).to_be_hidden()
        usage_chart=page.locator('#usageChart [data-chart-kind=usage]').first
        usage_chart.locator('svg').hover(position={'x':100,'y':100})
        expect(usage_chart.locator('.chart-tooltip strong')).to_have_text('150 Token')
        bounds=usage_chart.locator('.chart-tile-body').bounding_box()
        tip=usage_chart.locator('.chart-tooltip').bounding_box()
        assert bounds['x'] <= tip['x'] and tip['x'] + tip['width'] <= bounds['x'] + bounds['width'] + 1
        page.mouse.move(0,0)
        expect(usage_chart.locator('.chart-tooltip')).to_be_hidden()
        page.screenshot(path=str(repo/'dist/ui-preview/settings-multiple-charts.png'))
        page.locator('[data-view=general]').click();page.locator('#language').select_option('zh-CN')
        page.locator('[data-view=providers]').click()
        page.locator('#backProviders').click()
        page.locator('#providers [data-select]').first.click()
        expect(page.locator('#backProviders')).to_have_text('← 所有供应商')
        assert_back_button_spacing(page)
        page.locator('#backProviders').click()
        expect(page.locator('#providers')).to_be_visible()
        page.locator('[data-view=usage]').click()
        expect(page.locator('#usageChart [data-chart-kind=usage]')).to_contain_text('Token')
        page.locator('#usageChart').scroll_into_view_if_needed()
        page.screenshot(path=str(repo/'dist/ui-preview/settings-combined-charts-zh.png'))
        page.locator('[data-view=general]').click();page.locator('#language').select_option('en')
        page.locator('[data-view=usage]').click()
        page.emulate_media(color_scheme='dark');page.set_viewport_size({'width':760,'height':620})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#usageChart').scroll_into_view_if_needed()
        page.locator('#usageChart [data-chart-kind=quota] svg').first.hover(position={'x':80,'y':100})
        expect(page.locator('.chart-tooltip:visible')).to_have_count(1)
        page.screenshot(path=str(repo/'dist/ui-preview/settings-balances-dark-compact.png'))
        page.locator('[data-view=general]').click();page.locator('#theme').select_option('dark')
        expect(page.locator('#openMobileAccess')).to_have_count(0)
        page.evaluate("""() => {
          const original = window.testCall;
          const state = {running:false, address:null, language:'en', theme:'dark', closeToTray:false,
            workspaces:[{id:'workspace',name:'Test workspace'}], pending:[], devices:[]};
          window.testMobileCalls = [];
          window.testCall = (method, action) => {
            if (method === 'openMobileAccess') {window.testMobileOpened = true; return Promise.resolve({ok:true});}
            if (method !== 'remoteControl') return original(method, action);
            window.testMobileCalls.push(action);
            if (window.testMobileFailure) return Promise.resolve({ok:false,error:window.testMobileFailure});
            if (action === 'start') {state.running = true; state.address = 'http://100.80.1.2:43127';}
            if (action === 'stop') {state.running = false; state.address = null;}
            if (action === 'invite') {
              state.pending = [{id:'phone',name:'Test phone',workspaceIds:['workspace']}];
              return Promise.resolve({ok:true,result:{code:'test-pairing-code',expiresAt:Date.now()+300000}});
            }
            if (action === 'approve') {state.devices = state.pending; state.pending = [];}
            if (action === 'revoke') state.devices = [];
            return Promise.resolve({ok:true,result:structuredClone(state)});
          };
        }""")
        mobile_nav = page.locator('[data-view=storage] + [data-view=mobile]')
        expect(mobile_nav).to_have_text('▯Mobile access')
        page.evaluate("window.testMobileFailure = 'Local remote-access window required'")
        mobile_nav.click()
        expect(mobile_nav).to_have_attribute('aria-current', 'page')
        expect(page.locator('#pageTitle')).to_have_text('Mobile access')
        expect(page.locator('#mobilePage')).to_be_visible()
        expect(page.locator('#generalPage')).to_be_hidden()
        expect(page.locator('#storagePage')).to_be_hidden()
        expect(page.locator('#save')).to_be_hidden()
        expect(page.locator('#mobile-error')).to_contain_text('fully quit Camellia')
        expect(page.locator('#mobile-status')).to_have_text('Status unavailable')
        expect(page.locator('#mobile-toggle')).to_be_disabled()
        expect(page.locator('#mobilePage input[type=checkbox]')).to_have_count(0)
        expect(page.locator('#mobilePage [data-copy=network]')).not_to_be_empty()
        expect(page.locator('#mobilePage [data-copy=scope]')).not_to_be_empty()
        expect(page.locator('#mobile-retry')).to_be_enabled()
        page.locator('#mobile-openPanel').click()
        assert page.evaluate('window.testMobileOpened') is True
        page.evaluate('window.testMobileFailure = false')
        page.locator('#mobile-retry').click()
        expect(page.locator('#mobile-retry')).to_be_hidden()
        expect(page.locator('#mobile-openPanel')).to_be_hidden()
        expect(page.locator('#mobilePage [data-copy=scope]')).to_contain_text('all current and future workspaces')
        expect(page.locator('#mobile-toggle')).to_have_text('Enable mobile access')
        expect(page.locator('#mobile-invite')).to_be_disabled()
        page.locator('#mobile-toggle').click()
        expect(page.locator('#mobile-address')).to_have_text('http://100.80.1.2:43127')
        page.locator('#mobile-invite').click()
        expect(page.locator('#mobile-code')).to_have_text('test-pairing-code')
        page.get_by_role('button', name='Authorize device', exact=True).click()
        expect(page.locator('#mobile-devices .device')).to_have_count(1)
        page.get_by_role('button', name='Revoke', exact=True).click()
        expect(page.locator('#mobile-devices .device')).to_have_count(0)
        page.locator('#mobile-toggle').click()
        expect(page.locator('#mobile-invitation')).to_be_hidden()
        expect(page.locator('#refresh')).to_be_enabled()
        page.evaluate("window.testMobileFailure = 'Mobile access is unavailable'")
        page.locator('#refresh').click()
        expect(page.locator('#mobile-error')).to_have_text('Unable to load mobile access status. Please retry.')
        expect(page.locator('#mobile-toggle')).to_be_disabled()
        expect(page.locator('#mobile-invite')).to_be_disabled()
        page.evaluate('window.testMobileFailure = false')
        page.locator('#refresh').click()
        expect(page.locator('#mobile-toggle')).to_be_enabled()
        expect(page.locator('#mobile-error')).to_be_empty()
        page.locator('.scroll-content').evaluate('element => element.scrollTop = 0')
        page.screenshot(path=str(repo/'dist/ui-preview/settings-mobile-access.png'))
        page.locator('[data-view=general]').click()
        expect(page.locator('#mobilePage')).to_be_hidden()
        assert page.locator('#closeToTray').is_checked() is False
        page.locator('#autoRefreshBalances').uncheck();page.locator('#closeToTray').check()
        expect(page.locator('#status')).to_contain_text('Preferences saved')
        assert rpc('workbenchSettings')['result']['theme']=='dark'
        assert rpc('workbenchSettings')['result']['autoRefreshBalances'] is False
        assert rpc('workbenchSettings')['result']['closeToTray'] is True
        page.reload(wait_until='domcontentloaded');page.locator('[data-view=general]').click()
        assert page.locator('#closeToTray').is_checked() is True
        page.locator('#closeToTray').uncheck()
        expect(page.locator('#status')).to_contain_text('Preferences saved')
        assert rpc('workbenchSettings')['result']['closeToTray'] is False
        screenshot=repo/'dist/api-router-preview.png';screenshot.parent.mkdir(exist_ok=True)
        page.screenshot(path=str(screenshot),full_page=True)
        assert not errors,errors
        browser.close()
    print('PASS: unified settings, bulk import, catalog, model verification, usage filters/export, balance charts/failure recovery/escaping, dark/compact layout, routing and Claude catalog; no browser errors')
finally:
    try: rpc('cleanup')
    finally: driver.terminate();driver.wait(timeout=5)
