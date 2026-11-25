"""Agent/Web switching, independent web history and layout diagnostics."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture'
                                                        for target in node.targets))
node = next(node for node in module.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
base_bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))

web_bridge = r"""(() => {
  const providers = [
    {id:'deepseek',label:'DeepSeek Web',shortLabel:'DeepSeek',brand:'deepseek'},
    {id:'kimi',label:'Kimi Web',shortLabel:'Kimi',brand:'kimi'},
  ];
  const sessions = {
    deepseek: [
      {id:'ds-active',title:'DeepSeek active conversation',url:'https://chat.deepseek.com/a/chat/s/ds-active'},
      {id:'ds-other',title:'DeepSeek older conversation',url:'https://chat.deepseek.com/a/chat/s/ds-other'},
    ],
    kimi: [
      {id:'kimi-active',title:'Kimi active conversation',url:'https://www.kimi.com/chat/kimi-active'},
    ],
  };
  let state = {
    ok:true, provider:'deepseek', providers, sessions:sessions.deepseek, activeId:'ds-active',
    currentUrl:sessions.deepseek[0].url, title:'DeepSeek active conversation',
    loading:false, error:'', visible:true, canGoBack:false, canGoForward:true,
    layout:{status:'ok',historyCount:2,sidebarMarked:true,error:''},
  };
  window.webCalls = [];
  window.webListeners = [];
  window.contentWidthListeners = [];
  window.settingsListeners = [];
  window.confirmCalls = [];
  window.confirm = message => { window.confirmCalls.push(message); return true; };
  window.emitWebState = patch => {
    state = {...state, ...patch};
    for (const listener of window.webListeners) listener(state);
  };
  window.selectMockProvider = provider => {
    state = {...state, provider, sessions:sessions[provider],
      activeId:sessions[provider][0]?.id || null,
      title:sessions[provider][0]?.title || provider,
      currentUrl:sessions[provider][0]?.url || state.currentUrl,
      canGoBack:true, canGoForward:true};
    for (const listener of window.webListeners) listener(state);
  };
  window.dshDesktop.webSurfaceState = async () => ({...state});
  window.dshDesktop.onWebSurfaceState = callback => { window.webListeners.push(callback); return () => {}; };
  window.dshDesktop.onChatContentWidthChanged = callback => {
    window.contentWidthListeners.push(callback);
    return () => {};
  };
  window.dshDesktop.settingsOverlay = async () => false;
  window.dshDesktop.onSettingsOverlay = callback => {
    window.settingsListeners.push(callback);
    return () => {};
  };
  window.setSettingsOccluded = visible => {
    for (const listener of window.settingsListeners) listener(visible);
  };
  window.dshDesktop.webSurfaceCommand = async (action, payload = {}) => {
    window.webCalls.push({action, payload});
    if (action === 'show') return {ok:true,state};
    if (action === 'hide') return {ok:true};
    if (action === 'bounds') return {ok:true};
    if (action === 'new') {
      state = {...state, activeId:null, title:'New web conversation',
        currentUrl:'https://chat.deepseek.com/'};
      return {ok:true,state};
    }
    if (action === 'freeze-menu') return {ok:true,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3xQAAAAASUVORK5CYII='};
    if (action === 'provider-menu') return {ok:true,provider:state.provider};
    if (action === 'provider') {
      state = {...state, provider:payload.provider, sessions:sessions[payload.provider],
        activeId:sessions[payload.provider][0].id, title:sessions[payload.provider][0].title,
        currentUrl:sessions[payload.provider][0].url, canGoBack:true, canGoForward:true};
      return {ok:true,state};
    }
    if (action === 'navigate') {
      state = {...state, activeId:new URL(payload.url).pathname.split('/').pop(), currentUrl:payload.url};
      return {ok:true,state};
    }
    if (action === 'session-action') {
      const list = sessions[state.provider];
      const index = list.findIndex(item => item.id === payload.sessionId);
      if (index >= 0 && payload.action === 'rename') {
        list[index] = {...list[index], title:payload.value};
        if (state.activeId === payload.sessionId) state = {...state, title:payload.value};
      } else if (index >= 0 && payload.action === 'delete') {
        list.splice(index, 1);
        state = {...state, activeId:state.activeId === payload.sessionId ? (list[0]?.id || null) : state.activeId};
      }
      state = {...state, sessions:[...list]};
      for (const listener of window.webListeners) listener(state);
      return {ok:true,action:payload.action,sessionId:payload.sessionId};
    }
    if (action === 'diagnose') return {
      ok:true, provider:state.provider,
      diagnostics:{links:[1,2,3],candidates:[{pattern:'/chat/:id',count:2,classes:['next-sidebar-history-item__link']}]},
      proposal:{provider:state.provider,version:1,historyAnchorSelector:'a.next-sidebar-history-item__link',
        titleSelector:'',css:'',updatedAt:Date.now(),evidence:{count:2}},
    };
    if (action === 'layout-models') return {ok:true,models:['fixture-layout-model']};
    if (action === 'repair-layout-model') return {
      ok:true, provider:state.provider,
      proposal:{provider:state.provider,version:2,historyAnchorSelector:'a[data-testid="chat-history-item"]',
        titleSelector:'',css:'',updatedAt:Date.now(),evidence:{count:2}},
    };
    if (action === 'apply-layout') return {ok:true,profile:payload.profile};
    if (action === 'reset-layout' || action === 'clear-session' || action === 'reload') return {ok:true};
    return {ok:true,state};
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(base_bridge)
    page.add_init_script(web_bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    harness_style = page.evaluate("""() => {
      const style = getComputedStyle(document.querySelector('#engineSwitch'));
      return {
        height: style.height, padding: style.padding, border: style.border,
        borderRadius: style.borderRadius, font: style.font,
      };
    }""")

    expect(page.locator('#surfaceSwitch')).to_be_visible()
    expect(page.locator('#webSessionList')).to_be_hidden()
    agent_title = page.locator('#headerTitle').inner_text()
    page.locator('[data-surface-option="web"]').click()
    page.wait_for_function('window.CamelliaWebSurface.surface === "web"')
    expect(page.locator('#webSessionList')).to_be_visible()
    expect(page.locator('#sessionList')).to_be_hidden()
    expect(page.locator('#webSurfaceStage')).to_be_visible()
    expect(page.locator('#engineSwitch option')).to_have_count(2)
    expect(page.locator('#engineSwitch')).to_have_value('deepseek')
    page.mouse.move(1200, 700)
    provider_style = page.evaluate("""() => {
      const node = document.querySelector('#webProviderButton');
      const style = getComputedStyle(node);
      return {
        width: node.getBoundingClientRect().width,
        height: style.height, padding: style.padding, border: style.border,
        borderRadius: style.borderRadius, font: style.font,
      };
    }""")
    for field in ('height', 'padding', 'border', 'borderRadius', 'font'):
        assert provider_style[field] == harness_style[field], (field, provider_style, harness_style)
    provider_width = provider_style['width']
    expect(page.locator('[data-web-session-id="ds-active"]')).to_have_class(
        'session-item web-session-item active')
    expect(page.locator('[data-web-session-id="ds-other"]')).to_contain_text('DeepSeek older conversation')
    assert page.locator('#newSessionLabel').inner_text() == 'New web conversation'
    assert page.evaluate('document.body.classList.contains("web-mode")')
    page.wait_for_function("window.webCalls.some(call => call.action === 'show')")
    expected_width = page.evaluate("""() => {
      const rect = document.querySelector('#webSurfaceStage').getBoundingClientRect();
      const style = getComputedStyle(document.querySelector('#chatScroll'));
      const available = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const configured = getComputedStyle(document.documentElement).getPropertyValue('--content-width').trim();
      return configured === 'none' ? Math.round(available) : Math.round(Math.min(parseFloat(configured), available));
    }""")
    page.wait_for_function(
        f"window.webCalls.some(call => call.action === 'show'"
        f" && call.payload.contentWidth === {expected_width})")
    wide_width = page.evaluate("""() => {
      const rect = document.querySelector('#webSurfaceStage').getBoundingClientRect();
      const style = getComputedStyle(document.querySelector('#chatScroll'));
      return Math.round(Math.min(1080, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    }""")
    page.evaluate("""() => {
      document.documentElement.style.setProperty('--content-width', '1080px');
      for (const listener of window.contentWidthListeners) listener('wide');
    }""")
    page.wait_for_function(
        f"window.webCalls.some(call => call.action === 'content-width'"
        f" && call.payload.width === {wide_width})")

    hide_count = page.evaluate("window.webCalls.filter(call => call.action === 'hide').length")
    page.evaluate("window.setSettingsOccluded(true)")
    page.wait_for_function(
        f"window.webCalls.filter(call => call.action === 'hide').length > {hide_count}")
    standard_width = page.evaluate("""() => {
      const rect = document.querySelector('#webSurfaceStage').getBoundingClientRect();
      const style = getComputedStyle(document.querySelector('#chatScroll'));
      return Math.round(Math.min(768, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    }""")
    content_width_count = page.evaluate(
        "window.webCalls.filter(call => call.action === 'content-width').length")
    page.evaluate(
        "for (const listener of window.contentWidthListeners) listener('standard')")
    page.wait_for_timeout(120)
    assert page.evaluate(
        "window.webCalls.filter(call => call.action === 'content-width').length") == content_width_count
    show_count = page.evaluate("window.webCalls.filter(call => call.action === 'show').length")
    page.evaluate("window.setSettingsOccluded(false)")
    page.wait_for_function(
        f"window.webCalls.filter(call => call.action === 'show').length > {show_count}"
        f" && window.webCalls.filter(call => call.action === 'show').at(-1).payload.contentWidth === {standard_width}")
    page.evaluate("for (const listener of window.contentWidthListeners) listener('wide')")
    page.wait_for_function(
        f"window.webCalls.some(call => call.action === 'content-width'"
        f" && call.payload.width === {wide_width})")

    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'web-surface-1440.png'), animations='disabled')

    page.locator('[data-web-session-id="ds-other"]').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'navigate' && call.payload.url.includes('ds-other'))")
    expect(page.locator('[data-web-session-id="ds-other"]')).to_have_class(
        'session-item web-session-item active')

    page.locator('#newSessionBtn').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'new')")
    provisional = page.locator('.web-session-provisional')
    expect(provisional).to_be_visible()
    expect(provisional.locator('.session-item-text')).to_have_text('New web conversation')
    assert 'active' not in (page.locator('[data-web-session-id="ds-other"]').get_attribute('class') or '').split()
    page.evaluate("""window.emitWebState({
      sessions:[
        {id:'ds-new',title:'New conversation title',url:'https://chat.deepseek.com/a/chat/s/ds-new'},
        {id:'ds-active',title:'DeepSeek active conversation',url:'https://chat.deepseek.com/a/chat/s/ds-active'},
        {id:'ds-other',title:'DeepSeek older conversation',url:'https://chat.deepseek.com/a/chat/s/ds-other'}
      ],
      activeId:'ds-new',
      title:'New conversation title'
    })""")
    expect(page.locator('.web-session-provisional')).to_have_count(0)
    expect(page.locator('[data-web-session-id="ds-new"]')).to_have_class(
        'session-item web-session-item active')
    expect(page.locator('[data-web-session-id="ds-new"]')).to_contain_text('New conversation title')
    page.evaluate("""window.emitWebState({
      sessions:[
        {id:'ds-active',title:'DeepSeek active conversation',url:'https://chat.deepseek.com/a/chat/s/ds-active'},
        {id:'ds-other',title:'DeepSeek older conversation',url:'https://chat.deepseek.com/a/chat/s/ds-other'}
      ],
      activeId:'ds-active',
      title:'DeepSeek active conversation'
    })""")

    more = page.locator('[data-web-session-id="ds-other"] .web-session-more')
    more.click()
    expect(page.locator('.web-session-menu')).to_be_visible()
    assert page.locator('.web-session-menu button').all_text_contents() == [
        'Rename', 'Pin / Unpin', 'Share', 'Multi-select', 'Delete conversation']
    page.screenshot(path=str(preview / 'web-session-menu.png'), animations='disabled')
    page.locator('.web-session-menu button', has_text='Rename').click()
    rename_input = page.locator('[data-web-session-id="ds-other"] .web-session-rename')
    expect(rename_input).to_be_visible()
    rename_input.fill('Renamed web conversation')
    rename_input.press('Enter')
    page.wait_for_function("window.webCalls.some(call => call.action === 'session-action'"
                           " && call.payload.action === 'rename'"
                           " && call.payload.value === 'Renamed web conversation')")
    expect(page.locator('[data-web-session-id="ds-other"]')).to_contain_text('Renamed web conversation')

    for action in ('Pin / Unpin', 'Share'):
        page.locator('[data-web-session-id="ds-other"] .web-session-more').click()
        page.locator('.web-session-menu button', has_text=action).click()
        page.wait_for_function("window.webCalls.some(call => call.action === 'session-action'"
                               f" && call.payload.action === '{'pin' if action == 'Pin / Unpin' else 'share'}')")

    page.locator('[data-web-session-id="ds-other"] .web-session-more').click()
    page.locator('.web-session-menu button', has_text='Delete conversation').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'session-action'"
                           " && call.payload.action === 'delete'"
                           " && call.payload.sessionId === 'ds-other')")
    assert page.evaluate("window.webCalls.some(call => call.action === 'session-action'"
                         " && call.payload.action === 'delete'"
                         " && call.payload.sessionId === 'ds-other'"
                         " && call.payload.autoConfirm === false)")
    assert page.evaluate('window.confirmCalls.length') == 0

    page.locator('[data-web-session-id="ds-active"] .web-session-more').click()
    page.locator('.web-session-menu button', has_text='Multi-select').click()
    expect(page.locator('.web-session-bulk')).to_be_visible()
    expect(page.locator('[data-web-session-id="ds-active"]')).to_have_attribute('aria-checked', 'true')
    expect(page.locator('[data-web-session-id="ds-other"] .web-session-more')).to_have_count(0)
    page.locator('.web-session-bulk-delete').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'session-action'"
                           " && call.payload.action === 'delete'"
                           " && call.payload.sessionId === 'ds-active')")
    assert page.evaluate('window.confirmCalls.length') == 1
    expect(page.locator('.web-session-bulk')).to_have_count(0)
    expect(page.locator('[data-web-session-id="ds-active"]')).to_have_count(0)

    expect(page.locator('#engineSwitch')).to_be_hidden()
    expect(page.locator('#webProviderButton')).to_be_visible()
    expect(page.locator('#webProviderLabel')).to_have_text('DeepSeek Web')
    provider_shows = page.evaluate("window.webCalls.filter(call => call.action === 'show').length")
    page.locator('#webProviderButton').click()
    expect(page.locator('.web-provider-menu')).to_be_visible()
    page.wait_for_function("window.webCalls.some(call => call.action === 'hide')")
    expect(page.locator('#webSurfaceStage')).to_have_class('web-surface-stage provider-menu-frozen')
    expect(page.locator('#webProviderButton')).to_have_attribute('aria-expanded', 'true')
    expect(page.locator('.web-provider-menu-option[aria-selected="true"]')).to_have_text('DeepSeek Web')
    assert page.evaluate("getComputedStyle(document.querySelector('.web-provider-menu-option')).minHeight") == '40px'
    page.screenshot(path=str(preview / 'web-provider-menu.png'), animations='disabled')
    page.locator('.web-provider-menu-option', has_text='DeepSeek Web').click()
    expect(page.locator('.web-provider-menu')).to_have_count(0)
    page.wait_for_function(f"window.webCalls.filter(call => call.action === 'show').length > {provider_shows}")
    assert page.evaluate("window.webCalls.filter(call => call.action === 'provider').length") == 0
    provider_shows = page.evaluate("window.webCalls.filter(call => call.action === 'show').length")
    page.locator('#webProviderButton').click()
    expect(page.locator('.web-provider-menu')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('.web-provider-menu')).to_have_count(0)
    page.wait_for_function(f"window.webCalls.filter(call => call.action === 'show').length > {provider_shows}")
    assert page.evaluate("window.webCalls.filter(call => call.action === 'provider').length") == 0
    page.locator('#webProviderButton').click()
    expect(page.locator('.web-provider-menu')).to_be_visible()
    page.locator('.web-provider-menu-option', has_text='Kimi Web').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'provider' && call.payload.provider === 'kimi')")
    expect(page.locator('#webProviderButton')).to_have_attribute('aria-expanded', 'false')
    expect(page.locator('#webSurfaceStage')).not_to_have_class('web-surface-stage provider-menu-frozen')
    page.mouse.move(1200, 700)
    expect(page.locator('#webProviderLabel')).to_have_text('Kimi Web')
    expect(page.locator('#engineSwitch')).to_have_value('kimi')
    expect(page.locator('[data-web-session-id="kimi-active"]')).to_contain_text('Kimi active conversation')
    expect(page.locator('#logoBadge')).to_have_text('WEB')
    assert abs(page.locator('#webProviderButton').bounding_box()['width'] - provider_width) <= 1
    page.evaluate("window.emitWebState({loading:true,ready:true,title:'Loading conversation'})")
    expect(page.locator('#webSurfacePlaceholder')).to_have_text('')
    expect(page.locator('#webSurfaceStage')).to_have_attribute('aria-busy', 'false')
    page.evaluate("window.emitWebState({loading:false,ready:true,title:'Kimi active conversation'})")

    page.evaluate("window.emitWebState({activeId:null,title:'Kimi AI 官网：K3.1 Pro 上线，编程与智能体任务全面升级'})")
    expect(page.locator('#headerTitle')).to_have_text('New web conversation')
    page.evaluate("window.emitWebState({activeId:'kimi-active',title:'Kimi active conversation'})")

    page.locator('#webBack').click()
    page.locator('#webForward').click()
    page.locator('#webReload').click()
    for action in ('back', 'forward', 'reload'):
        page.wait_for_function(f"window.webCalls.some(call => call.action === '{action}')")

    page.locator('#webMore').click()
    more_menu = page.locator('#webMoreMenu')
    expect(more_menu).to_be_visible()
    expect(more_menu).to_have_class('dsh-pop action-menu')
    assert more_menu.locator('.pop-row').all_text_contents() == [
        'Refresh web conversations', 'Repair web layout',
        'Reset built-in layout', 'Clear web sign-in']
    expect(more_menu.locator('.pop-row').first).to_be_focused()
    assert page.evaluate("getComputedStyle(document.querySelector('#webMoreMenu .pop-row')).minHeight") == '36px'
    page.keyboard.press('ArrowDown')
    expect(more_menu.locator('.pop-row').nth(1)).to_be_focused()
    page.screenshot(path=str(preview / 'web-more-menu.png'), animations='disabled')
    page.keyboard.press('Escape')
    expect(more_menu).to_have_count(0)
    expect(page.locator('#webMore')).to_be_focused()

    page.locator('.web-layout-button').click()
    expect(page.locator('dialog.web-layout-dialog')).to_be_visible()
    page.wait_for_function("window.webCalls.some(call => call.action === 'diagnose')")
    page.screenshot(path=str(preview / 'web-layout-dialog.png'), animations='disabled')
    expect(page.locator('.web-layout-proposal code')).to_have_text('a.next-sidebar-history-item__link')
    expect(page.locator('.web-layout-model')).to_have_value('fixture-layout-model')
    page.locator('.web-layout-model-run').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'repair-layout-model' && call.payload.model === 'fixture-layout-model')")
    expect(page.locator('.web-layout-proposal code')).to_have_text('a[data-testid="chat-history-item"]')
    expect(page.locator('.web-layout-proposal strong')).to_have_text('Model-assisted proposal')
    page.locator('.web-layout-proposal .btn-primary').click()
    page.wait_for_function("window.webCalls.some(call => call.action === 'apply-layout')")
    expect(page.locator('dialog.web-layout-dialog')).to_have_count(0)

    page.locator('[data-surface-option="agent"]').click()
    page.wait_for_function('window.CamelliaWebSurface.surface === "agent"')
    expect(page.locator('#sessionList')).to_be_visible()
    expect(page.locator('#webSessionList')).to_be_hidden()
    expect(page.locator('#chatScroll')).to_be_visible()
    expect(page.locator('#engineSwitch')).to_contain_text('Codex CLI')
    assert page.locator('#headerTitle').inner_text() == agent_title
    page.wait_for_function("window.webCalls.some(call => call.action === 'hide')")

    page.emulate_media(color_scheme='dark')
    page.set_viewport_size({'width': 960, 'height': 720})
    page.locator('[data-surface-option="web"]').click()
    page.wait_for_function('window.CamelliaWebSurface.surface === "web"')
    expect(page.locator('#surfaceSwitch')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    switch_box = page.locator('#surfaceSwitch').bounding_box()
    assert switch_box and 75 <= switch_box['width'] <= 120, switch_box
    page.screenshot(path=str(preview / 'web-surface-960-dark.png'), animations='disabled')

    page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
    web_option = page.locator('[data-surface-option="web"]')
    expect(web_option).to_have_text('Web')
    expect(web_option).to_have_css('white-space', 'nowrap')
    assert page.evaluate("document.querySelector('[data-surface-option=web]').scrollHeight") \
        == page.evaluate("document.querySelector('[data-surface-option=web]').clientHeight")
    assert page.evaluate("[...document.querySelectorAll('#engineSwitch option')].map(option => option.textContent)") \
        == ['DeepSeek Web', 'Kimi Web']
    page.screenshot(path=str(preview / 'web-surface-960-dark-zh.png'), animations='disabled')

    assert not errors, errors
    browser.close()
print('PASS: agent/web switching, independent web history, provider navigation and layout diagnostics')
