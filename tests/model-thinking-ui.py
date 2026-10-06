"""Reported model thinking controls drive composer menus and hot updates."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  window.settings = {model:'glm-5.3',connection:'api',thinkingBudget:'',permissionMode:'ask'};
  window.router = {ok:true,enabled:true,models:['glm-5.3','kimi-k2.6','unknown-model'],providers:[],modelThinking:{
    'glm-5.3':{values:['low','high','max'],default:'max'},
    'kimi-k2.6':{values:[false,true],default:true},
  }};
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
    kimiAccountState:async()=>({ok:true,models:[]}),
    antigravityAccountState:async()=>({ok:true,models:[]}),
    onApiRouterState:callback=>{window.refreshRouter=callback;},
  },{get:(target,key)=>key in target?target[key]:key.startsWith('on')?()=>()=>{}:async()=>({ok:true})});
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for engine in ['codex', 'claude', 'dsh', 'kimi', 'antigravity', 'pi']:
        page = browser.new_page(viewport={'width': 1160, 'height': 820})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=' + engine, wait_until='networkidle')
        page.wait_for_function("uiReady && LEVELS.map(level=>level.id).join(',')===',low,high,max'")

        def reasoning_menu(labels):
            page.locator('#modelPill').click()
            page.locator('.pop-row').filter(has_text='Reasoning level').click()
            menu = page.locator('.dsh-pop').last
            expect(menu.locator('.pop-label')).to_have_text(labels)
            return menu

        reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Max', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='max'")
        reasoning_menu(['Default', 'Low', 'High', 'Max']).get_by_text('Default', exact=True).click()
        page.wait_for_function("settings.thinkingBudget===''")
        if engine != 'claude':
            page.evaluate("acceptSessionEvents=true; handleEvent({type:'gui:config',session_id:null,options:[{id:'reasoning_effort',currentValue:'',options:[{value:'medium',name:'Medium'}]}]})")
            assert page.evaluate('LEVELS.map(level=>level.id)') == ['', 'low', 'high', 'max']

        page.evaluate("router.modelThinking['glm-5.3']={values:['high','max','ultra'],default:'max'}; refreshRouter(router)")
        reasoning_menu(['Default', 'High', 'Max', 'Ultra']).get_by_text('Ultra', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='ultra'")

        page.evaluate("persistModel('kimi-k2.6')")
        page.wait_for_function("settings.model==='kimi-k2.6' && LEVELS.map(level=>level.id).join(',')===',none,high'")
        reasoning_menu(['Default', 'Off', 'On']).get_by_text('Off', exact=True).click()
        page.wait_for_function("settings.thinkingBudget==='none'")

        page.evaluate("persistModel('unknown-model')")
        page.wait_for_function("settings.model==='unknown-model' && LEVELS.map(level=>level.id).join(',')===',low,medium,high'")
        reasoning_menu(['Default', 'Low', 'Medium', 'High'])
        page.locator('#modelPill').click()
        page.evaluate("router.modelThinking['unknown-model']={values:[]}; refreshRouter(router)")
        page.locator('#modelPill').click()
        expect(page.locator('.pop-row').filter(has_text='Reasoning level')).to_have_count(0)
        assert errors == [], errors
        page.close()
    browser.close()
print('PASS thinking menus: all engines, reported levels, defaults, native config, hot updates, booleans and fallback')
