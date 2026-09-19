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
try:
    port=rpc('freePort')['result']; upstream=rpc('startTestUpstream')['result']
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1040,'height':900})
        errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
        page.expose_function('testRpc',rpc);page.add_init_script(bridge)
        page.goto((repo/'src/renderer/settings/api-settings.html').as_uri());page.wait_for_load_state('networkidle')
        expect(page.locator('#providers')).to_contain_text('Add your first provider')
        page.locator('.router-options > summary').click()
        page.locator('#port').fill(str(port))
        page.locator('#addProvider').click()
        page.locator('#preset').select_option('ollama');page.locator('#confirmAdd').click()
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
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        state=rpc('apiRouterGetState')['result'];assert len(state['providers'])==2
        assert 'test-command-account' not in json.dumps(state)
        result=rpc('routerRequest','kimi-k3')['result'];assert result['status']==200
        page.locator('#refresh').click();expect(page.locator('#live')).to_contain_text('Command Code GOAT')
        expect(page.locator('#keyRows')).to_contain_text('1 successful')
        # Reordering keeps credentials and usage attached to the same IDs.
        page.locator('#backProviders').click()
        page.get_by_role('button',name='Move up Command Code GOAT',exact=True).click()
        page.locator('#save').click();expect(page.locator('#status')).to_contain_text('Saved')
        page.reload();page.wait_for_load_state('networkidle')
        expect(page.locator('.provider').first).to_contain_text('Command Code GOAT')
        page.locator('.provider [data-select]').first.click()
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
        check_model_menu(canonical_model, len(configured['models']) + 1)
        assert rpc('claudeGetSettings')['result']['model'] == legacy_model
        # Repeated router updates keep one checked entry and never change model.
        for _ in range(2):
            claude.evaluate("state => window.testCall('apiRouterSaveConfig', state)", configured)
            check_model_menu(canonical_model, len(configured['models']) + 1)
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
        check_model_menu(canonical_model + ' (no route configured)', len(configured['models']) + 1)
        claude.evaluate("state => window.testCall('apiRouterSaveConfig', state)", configured)
        check_model_menu(canonical_model, len(configured['models']) + 1)
        claude.locator('#modelPill').click()
        claude.locator('.dsh-pop .pop-row').first.click()
        claude.locator('.pop-opt').filter(has_text='deepseek-v4-pro').click()
        expect(claude.locator('#statusLine')).to_contain_text('Model changed: deepseek-v4-pro')
        assert rpc('claudeGetSettings')['result']['model'] == 'deepseek-v4-pro'
        claude.reload(); claude.wait_for_load_state('networkidle')
        check_model_menu('deepseek-v4-pro', len(configured['models']) + 1)
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
        expect(page.locator('.key-card').nth(1)).to_contain_text('Model verified')
        state=rpc('apiRouterGetState')['result'];extra=state['providers'][0]['keys'][1]['id']
        assert state['usage'][extra]['requests']==0, 'Connection checks are not business usage'
        assert rpc('routerRequest','model-test')['result']['status']==200
        page.locator('#refresh').click()
        page.locator('[data-view=usage]').click()
        page.locator('#usageModel').select_option('model-test')
        expect(page.locator('#usageRows tr')).to_have_count(1)
        expect(page.locator('#usageRows')).to_contain_text('model-test')
        expect(page.locator('#usageChart svg')).to_be_visible()
        page.locator('#usageKey').select_option(extra)
        expect(page.locator('#usageRows')).to_contain_text('No requests in this period')
        page.locator('#usageKey').select_option('');page.locator('#usageModel').select_option('')
        with page.expect_download() as download:
            page.locator('#exportUsage').click()
        assert download.value.suggested_filename.endswith('.csv')
        page.screenshot(path=str(repo/'dist/ui-preview/settings-usage.png'))
        # Account responses are fixtures: no real provider credentials or calls.
        state=rpc('apiRouterGetState')['result'];command,ollama=state['providers'];key=command['keys'][0]['id']
        balances=[{'id':'credits','label':'Remaining credits','value':125.5,'currency':'credits','parts':[]}]
        windows=[{'id':'monthly','label':'Monthly','usedPercent':28,'resetsAt':None}]
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
        page.locator('[data-balance="'+key+'"]').click()
        expect(page.locator('#balanceDetail')).to_contain_text('125.5 Credits')
        expect(page.locator('#balanceDetail .chart-dot')).to_have_count(2)
        page.set_viewport_size({'width':1280,'height':1200})
        page.mouse.move(0,0)
        page.screenshot(path=str(repo/'dist/ui-preview/settings-balances.png'))
        snapshot['keys'][key]['status']='error'
        snapshot['keys'][key]['error']='<img src=x onerror="window.xss=1">'
        page.evaluate('s=>window.testEmitInsights(s)',snapshot)
        expect(page.locator('#balanceDetail')).to_contain_text('last successful result')
        expect(page.locator('#balanceDetail')).to_contain_text('125.5 Credits')
        expect(page.locator('#balanceDetail img')).to_have_count(0)
        assert page.evaluate('window.xss') is None
        ollama_key=ollama['keys'][0]['id'];page.locator('[data-balance="'+ollama_key+'"]').click()
        expect(page.locator('#balanceDetail')).to_contain_text('72% remaining')
        expect(page.locator('#balanceDetail')).to_contain_text('Reset time not provided')
        page.emulate_media(color_scheme='dark');page.set_viewport_size({'width':760,'height':620})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#balanceDetail').scroll_into_view_if_needed()
        page.screenshot(path=str(repo/'dist/ui-preview/settings-balances-dark-compact.png'))
        page.locator('[data-view=general]').click();page.locator('#theme').select_option('dark')
        assert page.locator('#closeToTray').is_checked() is False
        page.locator('#autoRefreshBalances').uncheck();page.locator('#closeToTray').check();page.locator('#saveGeneral').click()
        expect(page.locator('#status')).to_contain_text('Preferences saved')
        assert rpc('workbenchSettings')['result']['theme']=='dark'
        assert rpc('workbenchSettings')['result']['autoRefreshBalances'] is False
        assert rpc('workbenchSettings')['result']['closeToTray'] is True
        page.reload(wait_until='domcontentloaded');page.locator('[data-view=general]').click()
        assert page.locator('#closeToTray').is_checked() is True
        page.locator('#closeToTray').uncheck();page.locator('#saveGeneral').click()
        assert rpc('workbenchSettings')['result']['closeToTray'] is False
        screenshot=repo/'dist/api-router-preview.png';screenshot.parent.mkdir(exist_ok=True)
        page.screenshot(path=str(screenshot),full_page=True)
        assert not errors,errors
        browser.close()
    print('PASS: unified settings, bulk import, catalog, model verification, usage filters/export, balance charts/failure recovery/escaping, dark/compact layout, routing and Claude catalog; no browser errors')
finally:
    try: rpc('cleanup')
    finally: driver.terminate();driver.wait(timeout=5)
