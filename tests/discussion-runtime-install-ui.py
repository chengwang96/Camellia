"""Exercise the actual member dialog with an isolated installer bridge. No downloads or model calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview/discussion-runtime-install'
preview.mkdir(parents=True, exist_ok=True)
bridge = r"""(() => {
  const group={id:'group',title:'Install a member',revision:1,participants:[],messages:[],requests:[],deliveries:[]};
  const installed=new Set(), all=[];
  for(const engine of ['claude','codex','dsh','kimi','antigravity','grok']) {
    for(const connection of ['api',...(['codex','kimi','antigravity','grok'].includes(engine)?['subscription']:[])]) {
      all.push({id:engine+'-'+connection,label:'fixture-model',providerId:connection==='api'?'deepseek':'',
        providerLabel:'DeepSeek',accountLabel:'Fixture account',binding:{engine,connection,model:'fixture-model'}});
    }
  }
  const runtimes=()=>all.map(row=>({engine:row.binding.engine,connection:row.binding.connection,canInstall:!installed.has(row.id)}));
  const catalog=()=>all.filter(row=>!window.hideModels&&row.id!==window.removedBinding).map(row=>({...row,capability:installed.has(row.id)
    ? {available:false,canVerify:true,supported:true,canInstall:false}
    : {available:false,canVerify:false,supported:false,canInstall:true,detail:'No harness runtime was found. Install it or set its executable path in Settings, then refresh models.'}}));
  let resolveInstall, target, runtimeChanged=()=>{}, resolveCatalog;
  window.installCalls=[];window.addCalls=[];window.catalogCalls=0;window.holdCatalog=false;
  window.finishInstall=()=>{installed.add(target.engine+'-'+target.mode);resolveInstall({ok:true});};
  window.failInstall=()=>resolveInstall({ok:false,error:'Download failed. Check your network connection.'});
  window.finishCatalog=()=>{resolveCatalog({ok:true,bindings:catalog(),runtimes:runtimes()});};
  window.externalInstall=id=>{installed.add(id);runtimeChanged([]);};
  window.dshDesktop={
    workbenchSettings:async()=>({ok:true,language:'zh-CN',chatContentWidth:'standard'}),
    onLanguageChanged:()=>()=>{},onChatContentWidthChanged:()=>()=>{},onDiscussionEvent:()=>()=>{},
    onRuntimeState:callback=>{runtimeChanged=callback;return()=>{};},switchMode:async()=>({ok:true}),
    runtimeEnsure:payload=>{window.installCalls.push(payload);target=payload;return new Promise(resolve=>{resolveInstall=resolve;});},
    discussion:async(action,payload)=>{
      if(action==='list')return {ok:true,groups:[{id:group.id,title:group.title,members:group.participants.length}]};
      if(action==='load')return {ok:true,group};
      if(action==='catalog'){
        window.catalogCalls++;
        if(window.holdCatalog)return new Promise(resolve=>{resolveCatalog=resolve;});
        return {ok:true,bindings:catalog(),runtimes:runtimes()};
      }
      if(action==='add-member'){
        window.addCalls.push(payload);group.revision++;
        group.participants.push({id:'member',name:payload.name,identityPrompt:payload.identityPrompt,engine:'dsh',connection:'api',
          model:'fixture-model',capability:{available:true}});
        return {ok:true,group};
      }
      return {ok:false,error:'Unexpected fixture action: '+action};
    },
  };
})();"""

errors = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)

    def open_member(engine='dsh', connection='api', width=1100, dark=False):
        page = browser.new_page(viewport={'width': width, 'height': 900}, color_scheme='dark' if dark else 'light')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/discussions/discussions.html').as_uri(), wait_until='networkidle')
        page.locator('#addMember').click()
        page.locator('#engine').select_option(engine)
        page.locator('#connection').select_option(connection)
        expect(page.locator('#engine option:checked')).to_contain_text('未安装')
        expect(page.locator('#bindingStatus')).to_contain_text('可在这里一键安装')
        expect(page.locator('#installRuntime')).to_be_visible()
        expect(page.locator('#saveMember')).to_be_disabled()
        assert page.evaluate('installCalls.length') == 0, 'Choosing a missing harness must not start installation'
        return page

    combinations = [(engine, 'api') for engine in ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok']]
    combinations += [(engine, 'subscription') for engine in ['codex', 'kimi', 'antigravity']]
    for engine, connection in combinations:
        page = open_member(engine, connection)
        page.locator('#memberName').fill('My reviewer')
        page.locator('#memberIdentityPrompt').fill('Keep this identity prompt')
        page.locator('#installRuntime').click()
        expect(page.locator('#installRuntime')).to_be_disabled()
        expect(page.locator('#installRuntime')).to_have_attribute('aria-busy', 'true')
        expect(page.locator('#memberDialog [data-close="memberDialog"]')).to_have_text('关闭')
        expect(page.locator('#bindingStatus')).to_have_text('正在安装 Harness…')
        for selector in ['#engine', '#connection', '#provider', '#binding', '#saveMember', '#refreshModels']:
            expect(page.locator(selector)).to_be_disabled()
        page.evaluate("document.querySelector('#installRuntime').click()")
        assert page.evaluate('installCalls') == [{'engine': engine, 'mode': connection}]
        page.locator('#memberName').fill('Edited while installing')
        page.evaluate('finishInstall()')
        expect(page.locator('#saveMember')).to_be_enabled()
        expect(page.locator('#saveMember')).to_be_visible()
        expect(page.locator('#installRuntime')).not_to_be_visible()
        expect(page.locator('#memberName')).to_have_value('Edited while installing')
        expect(page.locator('#memberIdentityPrompt')).to_have_value('Keep this identity prompt')
        expect(page.locator('#binding')).to_have_value(engine + '-' + connection)
        assert '未安装' not in page.locator('#engine option:checked').inner_text()
        assert page.evaluate('addCalls.length') == 0, 'Installation must not add a member or invoke a model'
        if engine == 'dsh':
            page.locator('#saveMember').click()
            expect(page.locator('#memberDialog')).not_to_be_visible()
            assert page.evaluate('addCalls[0].bindingId') == 'dsh-api'
            assert page.evaluate('addCalls[0].name') == 'Edited while installing'
            assert page.evaluate('addCalls[0].identityPrompt') == 'Keep this identity prompt'
        page.close()

    page = open_member()
    page.locator('#memberName').fill('Retry reviewer')
    page.locator('#memberIdentityPrompt').fill('Keep after a failed download')
    page.locator('#installRuntime').click()
    page.evaluate('failInstall()')
    expected_failure = page.evaluate("CamelliaI18n.t('Download failed. Check your network connection.')")
    expect(page.locator('#bindingStatus')).to_have_text(expected_failure)
    expect(page.locator('#installRuntime')).to_have_text('重试安装')
    expect(page.locator('#installRuntime')).to_be_enabled()
    expect(page.locator('#saveMember')).to_be_disabled()
    expect(page.locator('#memberName')).to_have_value('Retry reviewer')
    page.locator('#installRuntime').click()
    page.evaluate('finishInstall()')
    expect(page.locator('#saveMember')).to_be_enabled()
    expect(page.locator('#memberIdentityPrompt')).to_have_value('Keep after a failed download')
    assert page.evaluate('installCalls.length') == 2
    page.close()

    page = open_member()
    page.locator('#memberName').fill('Catalog refresh draft')
    page.locator('#installRuntime').click()
    page.evaluate('holdCatalog=true; finishInstall()')
    page.wait_for_function('catalogCalls >= 2')
    page.locator('#memberName').fill('Edited during model refresh')
    page.evaluate('finishCatalog()')
    expect(page.locator('#saveMember')).to_be_enabled()
    expect(page.locator('#memberName')).to_have_value('Edited during model refresh')
    page.close()

    page = open_member()
    page.locator('#installRuntime').click()
    page.evaluate("removedBinding='dsh-api'; finishInstall()")
    expect(page.locator('#bindingStatus')).to_contain_text('模型或账号已发生变化')
    expect(page.locator('#saveMember')).to_be_disabled()
    assert page.evaluate('addCalls.length') == 0
    page.close()

    page = open_member()
    page.locator('#memberName').fill('Installed from Settings')
    page.locator('#memberIdentityPrompt').fill('External installation draft')
    page.evaluate("externalInstall('dsh-api')")
    expect(page.locator('#saveMember')).to_be_enabled()
    expect(page.locator('#installRuntime')).not_to_be_visible()
    expect(page.locator('#memberName')).to_have_value('Installed from Settings')
    expect(page.locator('#memberIdentityPrompt')).to_have_value('External installation draft')
    page.close()

    page = open_member()
    page.evaluate('hideModels=true')
    page.locator('#refreshModels').click()
    expect(page.locator('#binding')).to_have_value('')
    expect(page.locator('#installRuntime')).to_be_visible()
    page.locator('#installRuntime').click()
    page.evaluate('finishInstall()')
    expect(page.locator('#installRuntime')).not_to_be_visible()
    expect(page.locator('#saveMember')).to_be_disabled()
    expect(page.locator('#bindingStatus')).to_contain_text('设置')
    assert page.evaluate('installCalls') == [{'engine': 'dsh', 'mode': 'api'}]
    page.close()

    for width, dark in [(1100, False), (390, True)]:
        page = open_member(width=width, dark=dark)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        expect(page.locator('#installRuntime')).to_be_in_viewport()
        page.screenshot(path=str(preview / ('missing-narrow-dark.png' if dark else 'missing-desktop-light.png')))
        page.locator('#installRuntime').click()
        page.locator('#memberDialog [data-close="memberDialog"]').click()
        expect(page.locator('#memberDialog')).not_to_be_visible()
        page.evaluate('finishInstall()')
        page.locator('#addMember').click()
        expect(page.locator('#saveMember')).to_be_enabled()
        assert page.evaluate('installCalls.length') == 1
        page.close()

    browser.close()
assert not errors, errors
print('PASS: 10 harness/connection installs, automatic refresh, saved drafts, duplicate clicks, retry, changed models, external installation, narrow/dark layout and dialog close. Isolated backend only.')
