"""File preview resizing, persistence, bounds, and pointer cleanup. No model calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.previewKind = 'image';
  window.dshDesktop = {
    sharedConversations:true,
    conversationCommand:async ({action}) => {
      if(action==='list-sessions') return {ok:true,sessions:[],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false}}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onLanguageChanged:()=>{},
    pickAttachments:async()=>({canceled:false,paths:['C:/fixture/preview.txt']}),
    previewFile:async()=>({ok:true,file:{kind:window.previewKind,name:'Preview fixture',path:'C:/fixture/preview.txt',
      size:64,text:'Preview fixture',url:window.previewKind==='image'
        ? 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="steelblue"/></svg>')
        : 'about:blank'}}),
    openFileExternally:async()=>({ok:true}),
  };
})();"""


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri(), wait_until='networkidle')
    page.wait_for_function('uiReady')
    viewer = page.locator('#fileViewer')
    handle = page.locator('#fileViewerResize')

    def open_preview(kind):
        page.evaluate('(kind) => window.previewKind = kind', kind)
        if page.locator('.attchip-name').count() == 0:
            page.locator('#attachBtn').click()
        page.locator('.attchip-name').click()
        expect(viewer).to_be_visible()
        page.wait_for_function("document.getElementById('fileViewer').getAnimations().every(animation => animation.playState === 'finished')")

    def width():
        return viewer.bounding_box()['width']

    def drag(delta):
        bounds = handle.bounding_box()
        start = bounds['x'] + bounds['width'] / 2
        page.mouse.move(start, 250)
        page.mouse.down()
        page.mouse.move(start + delta, 250, steps=10)
        page.mouse.up()
        assert not page.evaluate("document.body.classList.contains('resizing-file-viewer')")

    open_preview('image')
    initial = width()
    drag(-200)
    assert abs(width() - initial - 200) <= 1
    expect(viewer.locator('img')).to_be_visible()
    enlarged = width()
    image = viewer.locator('img').bounding_box()
    assert image['width'] <= enlarged
    page.locator('#fileViewerClose').click()
    open_preview('video')
    assert width() == enlarged
    expect(viewer.locator('video')).to_be_visible()
    drag(120)
    assert abs(width() - enlarged + 120) <= 1
    saved = width()
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    open_preview('text')
    assert width() == saved

    handle.focus()
    handle.press('ArrowLeft')
    assert width() == saved + 10
    handle.press('Shift+ArrowRight')
    assert width() == saved - 40
    handle.press('End')
    assert page.locator('.main').bounding_box()['width'] >= 320
    handle.press('Home')
    assert width() == 300
    drag(200)
    assert width() == 300

    open_preview('pdf')
    drag(-220)
    assert width() == 520
    expect(viewer.locator('iframe')).to_be_visible()
    bounds = handle.bounding_box()
    page.mouse.move(bounds['x'] + 3, 250)
    page.mouse.down()
    page.mouse.move(bounds['x'] - 30, 250)
    page.keyboard.press('Escape')
    expect(viewer).to_be_hidden()
    assert not page.evaluate("document.body.classList.contains('resizing-file-viewer')")
    page.mouse.up()
    open_preview('image')
    for event in ['pointercancel', 'lostpointercapture', 'blur']:
        bounds = handle.bounding_box()
        page.mouse.move(bounds['x'] + 3, 250)
        page.mouse.down()
        page.mouse.move(bounds['x'] - 20, 250)
        page.evaluate("event => (event === 'blur' ? window : document.getElementById('fileViewerResize')).dispatchEvent(new Event(event))", event)
        assert not page.evaluate("document.body.classList.contains('resizing-file-viewer')")
        page.mouse.up()

    handle.press('End')
    preferred = width()
    for viewport_width in [960, 801, 760, 360]:
        page.set_viewport_size({'width': viewport_width, 'height': 820})
        page.wait_for_function("Number(document.getElementById('fileViewerResize').getAttribute('aria-valuemax')) === (innerWidth <= 800 ? innerWidth - 32 : Math.max(300, innerWidth - 260 - 320))")
        assert viewer.bounding_box()['x'] >= 0
        assert viewer.bounding_box()['x'] + width() <= viewport_width + 1
        if viewport_width > 800:
            assert page.locator('.main').bounding_box()['width'] >= 240
        else:
            drag(30)
            assert width() >= 300
    page.set_viewport_size({'width': 1440, 'height': 900})
    handle.press('End')
    assert width() == preferred

    sidebar = page.locator('#sidebar')
    sidebar_handle = page.locator('#sidebarResize')

    def sidebar_width():
        return sidebar.bounding_box()['width']

    def drag_sidebar(delta):
        bounds = sidebar_handle.bounding_box()
        start = bounds['x'] + bounds['width'] / 2
        page.mouse.move(start, 250)
        page.mouse.down()
        page.mouse.move(start + delta, 250, steps=10)
        page.mouse.up()
        assert not page.evaluate("document.body.classList.contains('resizing-sidebar')")

    assert sidebar_width() == 260
    drag_sidebar(140)
    assert sidebar_width() == 400
    assert page.locator('.main').bounding_box()['width'] >= 320
    assert viewer.bounding_box()['x'] + width() <= 1441
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    assert sidebar_width() == 400
    sidebar_handle.press('ArrowLeft')
    assert sidebar_width() == 390
    sidebar_handle.press('Shift+ArrowRight')
    assert sidebar_width() == 440
    sidebar_handle.press('Home')
    assert sidebar_width() == 210
    drag_sidebar(-100)
    assert sidebar_width() == 210
    sidebar_handle.press('End')
    assert sidebar_width() == 520
    drag_sidebar(100)
    assert sidebar_width() == 520
    open_preview('pdf')
    for event in ['pointercancel', 'lostpointercapture', 'blur', 'resize']:
        bounds = sidebar_handle.bounding_box()
        page.mouse.move(bounds['x'] + 3, 250)
        page.mouse.down()
        page.mouse.move(bounds['x'] - 20, 250)
        page.evaluate("event => (['blur', 'resize'].includes(event) ? window : document.getElementById('sidebarResize')).dispatchEvent(new Event(event))", event)
        assert not page.evaluate("document.body.classList.contains('resizing-sidebar')")
        page.mouse.up()
    sidebar_handle.press('End')
    for viewport_width in [960, 801, 760, 360]:
        page.set_viewport_size({'width': viewport_width, 'height': 820})
        page.wait_for_function("Number(document.getElementById('sidebarResize').getAttribute('aria-valuenow')) === Math.max(210, Math.min(520, innerWidth - (innerWidth > 800 ? 540 : 320)))")
        assert sidebar_width() >= 210
        assert sidebar_width() < viewport_width
        assert viewer.bounding_box()['x'] + width() <= viewport_width + 1
        if viewport_width > 800:
            assert page.locator('.main').bounding_box()['width'] >= 240
    page.set_viewport_size({'width': 1440, 'height': 900})
    page.wait_for_function("document.getElementById('sidebarResize').getAttribute('aria-valuenow') === '520'")
    assert sidebar_width() == 520
    screenshots = repo / 'dist/ui-preview'
    screenshots.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(screenshots / 'file-preview-resized.png'), animations='disabled')
    assert errors == [], errors
    browser.close()
print('PASS sidebar and file preview resize: persistence, keyboard, bounds, pointer cleanup, PDF interaction')
