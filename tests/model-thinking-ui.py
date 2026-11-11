"""Reported model thinking controls drive composer menus and hot updates."""
from pathlib import Path
import json
import subprocess
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
# Exercise the production discovery/parser/state path before checking menus.
# Command Code's standard model list has no efforts, while its client view
# and OpenCode's nested capabilities carry different metadata schemas.
router = subprocess.run(['node', '-e', r"""
const {fetchModels} = require('./src/api/provider-accounts');
const {PRESETS,normalizeConfig,publicState} = require('./src/api/api-router-config');
(async () => {
  const providers = [];
  for (const [type, entries] of [
    ['commandcode', [
      {id:'zai-org/GLM-5.3',reasoningEfforts:['low','high','max']},
      {id:'deepseek/deepseek-v4.1-flash',reasoningEfforts:['off','low','high','max']},
    ]],
    ['opencode', [{id:'kimi-k2.6',capabilities:{reasoning:{supported:true,toggle:true}}}]],
  ]) {
    const provider = {...PRESETS.find(p=>p.type===type), id:type, keys:[{key:'fixture-key'}]};
    provider.models = await fetchModels(provider, 'fixture-key', {fetchImpl:async url=>{
      if(type==='commandcode'&&!url.endsWith('?view=client')) throw Error('must use client view');
      return {ok:true,json:async()=>({data:entries})};
    }});
    providers.push(provider);
  }
  const state=publicState(normalizeConfig({providers}));
  state.providers[0].models.push({id:'unknown-model',upstream:'unknown-model',protocol:'auto'});
  state.models.push('unknown-model');
  process.stdout.write(JSON.stringify(state));
})().catch(error=>{console.error(error);process.exit(1)});
"""], cwd=repo, capture_output=True, text=True, encoding='utf-8', check=True).stdout
bridge = r"""(() => {
  window.settings = {model:'glm-5.3',connection:'api',thinkingBudget:'',permissionMode:'ask'};
  window.router = __ROUTER_STATE__;
  window.dshDesktop = new Proxy({
    sharedConversations: true,
    conversationCommand: async ({action,payload}) => {
      if(action==='list-sessions') return {ok:true,sessions:[],workspaces:[],pagination:{}};
      if(action==='get-settings') return {...settings};
      if(action==='save-settings') { Object.assign(settings,payload); return {ok:true,settings:{...settings}}; }
      if(action==='get-live') return {ok:true,live:null};
      return {ok:true};
    },
    apiRouterGetState:async()=>router,
    workbenchSettings:async()=>({ok:true,language:'en-US'}),
    codexAccountState:async()=>({ok:true,models:[]}),
    kimiAccountState:async()=>({ok:true,account:{},models:[{id:'kimi-code/k3.1-pro',name:'K3.1 Pro',supportedReasoningEfforts:['low','high','max'],defaultReasoningEffort:'high'}]}),
    antigravityAccountState:async()=>({ok:true,models:[]}),
    onApiRouterState:callback=>{window.refreshRouter=callback;},
  },{get:(target,key)=>key in target?target[key]:key.startsWith('on')?()=>()=>{}:async()=>({ok:true})});
})();""".replace('__ROUTER_STATE__', json.dumps(json.loads(router)))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for engine in ['codex', 'claude', 'dsh', 'kimi', 'antigravity', 'grok']:
        page = browser.new_page(viewport={'width': 1160, 'height': 820})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=' + engine, wait_until='networkidle')
        page.wait_for_function("uiReady && LEVELS.map(level=>level.id).join(',')===',low,high,max'")

        def reasoning_menu(labels):
            page.locator('#modelPill').click()
            page.locator('.pop-row').filter(has_text='Reasoning level').click()
            menu = page.locator('.dsh-pop').last
            expect(menu.locator('.pop-label')).to_have_text(labels)
            return menu

        reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='max'")
        if engine == 'codex':
            long_label = 'Extremely thorough reasoning with a long label'
            page.evaluate("label => LEVELS.push({id:'extended',label})", long_label)
            menu = reasoning_menu(['Default', 'Low', 'High', 'Max', long_label])
            rows = menu.locator('.pop-opt').evaluate_all("""options => options.map(option => {
              const label = option.querySelector('.pop-label'), rect = option.getBoundingClientRect();
              return {height:rect.height,whiteSpace:getComputedStyle(label).whiteSpace,title:label.title};
            })""")
            assert all(row['whiteSpace'] == 'nowrap' for row in rows), rows
            assert len({round(row['height']) for row in rows}) == 1, rows
            assert rows[-1]['title'] == long_label
            page.mouse.click(10, 10)
            page.evaluate('LEVELS.pop()')
        reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Default', exact=True).click()
        page.wait_for_function("settings.thinkingBudget===''")
        if engine == 'antigravity':
            long_model = 'claude-opus-4-6-thinking (refreshed with an intentionally long label)'
            page.evaluate("""async model => {
              router.models.push(model);
              router.modelThinking[model] = {values:['low','high'],default:'high'};
              refreshRouter(router);
              await persistModel(model);
              currentLevel = 'default'; renderModelPill();
              CamelliaI18n.setLanguage('zh-CN');
            }""", long_model)
            expect(page.locator('#modelPillName')).to_have_text(long_model)
            expect(page.locator('#modelPillLevel')).to_have_text('默认')
            layout = page.locator('#modelPill').evaluate("""pill => {
              const name = pill.querySelector('.model-name'), level = pill.querySelector('.model-level');
              const range = document.createRange(); range.selectNodeContents(level);
              return {lines:range.getClientRects().length, whiteSpace:getComputedStyle(level).whiteSpace,
                nameClipped:name.scrollWidth > name.clientWidth};
            }""")
            assert layout == {'lines':1, 'whiteSpace':'nowrap', 'nameClipped':True}, layout
            page.evaluate("""async () => {
              CamelliaI18n.setLanguage('en-US');
              await persistModel('glm-5.3');
            }""")
        if engine != 'claude':
            page.evaluate("acceptSessionEvents=true; handleEvent({type:'gui:config',session_id:null,options:[{id:'reasoning_effort',currentValue:'',options:[{value:'medium',name:'Medium'}]}]})")
            assert page.evaluate('LEVELS.map(level=>level.id)') == ['', 'low', 'high', 'max']

        page.evaluate("router.modelThinking['glm-5.3']={values:['high','max','ultra'],default:'max'}; refreshRouter(router)")
        reasoning_menu(['Default', 'High', 'Max', 'Ultra']).get_by_text('Ultra', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='ultra'")

        page.evaluate("persistModel('deepseek-v4.1-flash')")
        page.wait_for_function("settings.model==='deepseek-v4.1-flash' && LEVELS.map(level=>level.id).join(',')===',none,low,high,max'")
        reasoning_menu(['Default', 'Off', 'Low', 'High', 'Max']).get_by_text('Off', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='none'")
        reasoning_menu(['Default', 'Off', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='max'")

        page.evaluate("persistModel('kimi-k2.6')")
        page.wait_for_function("settings.model==='kimi-k2.6' && LEVELS.map(level=>level.id).join(',')===',none,high'")
        reasoning_menu(['Default', 'Off', 'On']).get_by_text('Off', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='none'")

        page.evaluate("persistModel('unknown-model')")
        page.wait_for_function("settings.model==='unknown-model' && LEVELS.map(level=>level.id).join(',')===',low,medium,high'")
        reasoning_menu(['Default', 'Low', 'Medium', 'High']).get_by_text('Medium', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='medium'")
        # Background discovery replaces the generic fallback without a reload.
        page.evaluate("router.modelThinking['unknown-model']={values:[false,'low','high','max'],default:'high'}; refreshRouter(router)")
        reasoning_menu(['Default', 'Off', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='max'")
        # An explicit empty list means the provider reported no selectable effort.
        page.evaluate("router.modelThinking['unknown-model']={values:[]}; refreshRouter(router)")
        page.locator('#modelPill').click()
        expect(page.locator('.pop-row').filter(has_text='Reasoning level')).to_have_count(0)
        if engine == 'kimi':
            page.locator('#modelPill').click()
            page.evaluate("""async () => {
              Object.assign(settings, {model:'kimi-code/k3.1-pro',connection:'subscription',thinkingBudget:'',subscriptionId:'default'});
              await loadSettings();
            }""")
            page.wait_for_function("LEVELS.map(level=>level.id).join(',')===',low,high,max'")
            reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
            page.wait_for_function("settings.thinkingBudget==='max' && settings.connection==='subscription'")
            page.evaluate("acceptSessionEvents=true; handleEvent({type:'gui:config',session_id:null,options:[{id:'thinking',currentValue:'max',options:[{value:'low',name:'Thinking Low'},{value:'high',name:'Thinking High'},{value:'max',name:'Thinking Max'}]}]})")
            assert page.evaluate('LEVELS.map(level=>level.id)') == ['', 'low', 'high', 'max']
            reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
        assert errors == [], errors
        page.close()
    browser.close()
print('PASS thinking menus: all engines, reported levels, defaults, native config, background discovery, booleans and unknown metadata')
