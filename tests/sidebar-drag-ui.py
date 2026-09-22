"""Long-press sidebar drag interactions using the real sidebar renderer."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 900, "height": 700})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_content('<div id="sessionList"></div>')
    page.add_style_tag(path=str(repo / 'src/renderer/chat/claude.css'))
    page.add_style_tag(content='#sessionList {width:320px;height:600px;overflow:auto} .session-item {min-height:40px}')
    page.add_script_tag(path=str(repo / 'src/renderer/chat/claude-sidebar.js'))
    page.evaluate("""async () => {
      window.calls = []; window.opened = []; window.menus = [];
      window.harnessId = 'codex'; window.chatProfile = {fixedCwd:true};
      window.chatApi = {
        listSessions: async () => ({ok:true, sessions:[
          {id:'first',title:'First',workspaceId:'workspace',mtimeMs:Date.now()},
          {id:'second',title:'Second',workspaceId:'workspace',mtimeMs:Date.now()},
          {id:'third',title:'Third',workspaceId:null,mtimeMs:Date.now()}
        ], workspaces:[{id:'workspace',name:'Workspace',path:'/first'},
          {id:'target',name:'Empty target',path:'/target',collapsed:true}], pagination:{}}),
        metaOp: async payload => { calls.push(payload); return {ok:true}; }
      };
      const lookup = id => {
        let element = document.getElementById(id);
        if (!element) {element=document.createElement('div');element.id=id;document.body.append(element);}
        return element;
      };
      window.sidebar = createClaudeSidebar({$:lookup,context:{sessionId:'first',workspaceId:'workspace'},
        contextBusy:()=>false,canChangeContext:()=>true,setStatus:()=>{},newSession:()=>{},
        openHistorySession:id=>opened.push(id),forkSession:()=>{},closePops:()=>{},
        openActionMenu:(anchor,actions)=>menus.push(actions.map(action=>action.label))});
      await sidebar.load();
    }""")
    expect(page.locator('[data-sid]')).to_have_count(3)

    def center(selector):
        box = page.locator(selector).bounding_box()
        return box['x'] + 70, box['y'] + box['height'] / 2

    def hold(selector):
        page.mouse.move(*center(selector))
        page.mouse.down()
        page.wait_for_timeout(400)
        expect(page.locator('body')).to_have_class('session-drag-active')

    page.locator('[data-sid="second"]').click()
    assert page.evaluate('opened') == ['second']
    hold('[data-sid="first"]')
    expect(page.locator('.session-drag-preview')).to_have_count(1)
    assert page.locator('.session-drag-preview').get_attribute('aria-hidden') == 'true'
    assert page.locator('.session-drag-preview').evaluate('(element) => element.inert')
    assert page.locator('.session-drag-card').evaluate('(element) => element.getAnimations().some(animation => animation.effect.getTiming().duration === 220)')
    target = page.locator('[data-sid="second"]').bounding_box()
    page.mouse.move(target['x'] + 70, target['y'] + target['height'] - 3)
    expect(page.locator('[data-sid="second"]')).to_have_class('session-item session-drop-after')
    page.wait_for_timeout(230)
    assert page.locator('[data-sid="second"]').evaluate('(element) => new DOMMatrix(getComputedStyle(element).transform).m42') == -5
    assert page.locator('.session-drag-card').evaluate('(element) => new DOMMatrix(getComputedStyle(element).transform).a') > 1
    preview = page.locator('.session-drag-preview').bounding_box()
    assert abs(preview['y'] - (target['y'] + target['height'] - 3 - target['height'] / 2)) < 2
    capture = repo / 'dist/ui-preview'
    capture.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(capture / 'sidebar-drag-motion.png'))
    page.mouse.up()
    page.wait_for_function('calls.length === 1')
    expect(page.locator('.session-drag-preview')).to_have_count(0)
    assert page.evaluate('calls[0]') == dict(op='move-session', sessionId='first', group='workspace', targetSessionId='second', placement='after')
    assert page.evaluate('opened') == ['second']
    hold('[data-sid="first"]')
    page.mouse.move(*center('[data-workspace-id="target"] .ws-row'))
    expect(page.locator('[data-workspace-id="target"]')).to_have_class('session-drop-group')
    page.mouse.up()
    page.wait_for_function('calls.length === 2')
    assert page.evaluate('calls[1].group') == 'target'
    hold('[data-sid="first"]')
    page.mouse.move(*center('[data-sid="third"]'))
    page.keyboard.press('Escape')
    page.mouse.up()
    assert page.evaluate('calls.length') == 2
    hold('[data-sid="first"]')
    page.mouse.move(700, 500)
    page.mouse.up()
    assert page.evaluate('calls.length') == 2
    page.mouse.move(*center('[data-sid="first"]'))
    page.mouse.down()
    page.mouse.move(*center('[data-sid="second"]'))
    page.wait_for_timeout(400)
    page.mouse.up()
    assert page.evaluate('calls.length') == 2
    hold('[data-sid="second"]')
    page.mouse.move(*center('[data-sid="third"]'))
    page.mouse.up()
    page.wait_for_function('calls.length === 3')
    assert page.evaluate('calls[2].group') == 'recent'
    assert page.evaluate('opened') == ['second']
    page.locator('[data-sid="second"]').click(button='right')
    assert 'Rename' in page.evaluate('menus.at(-1)')
    page.evaluate("""() => {
      document.getElementById('sessionList').style.height = '220px';
      document.getElementById('independentSessions').style.paddingBottom = '900px';
    }""")
    hold('[data-sid="first"]')
    edge = page.locator('#sessionList').bounding_box()
    page.mouse.move(edge['x'] + 100, edge['y'] + edge['height'] - 4)
    page.wait_for_function('document.getElementById("sessionList").scrollTop > 30')
    page.keyboard.press('Escape')
    page.mouse.up()
    assert page.evaluate('calls.length') == 3
    expect(page.locator('.session-drag-preview')).to_have_count(0)
    page.evaluate('document.getElementById("sessionList").scrollTop = 0')
    page.emulate_media(reduced_motion='reduce')
    hold('[data-sid="first"]')
    assert page.locator('.session-drag-card').evaluate('(element) => element.getAnimations().length') == 0
    page.keyboard.press('Escape')
    page.mouse.up()
    expect(page.locator('.session-drag-preview')).to_have_count(0)
    assert page.evaluate('calls.length') == 3
    page.emulate_media(reduced_motion='no-preference')
    hold('[data-sid="first"]')
    page.evaluate('window.dispatchEvent(new Event("blur"))')
    page.mouse.up()
    expect(page.locator('.session-drag-preview')).to_have_count(0)
    expect(page.locator('.session-dragging')).to_have_count(0)
    assert not errors, errors
    browser.close()
    print('Sidebar drag UI checks passed')
