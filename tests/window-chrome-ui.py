"""Keyboard/menu geometry in the actual workbench renderer, without model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
bridge_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
fixture_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
import json
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(ast.literal_eval(fixture_node.value)))
chrome = """(() => {
  window.chromeState = { enabled:true,height:40,zoomFactor:1,theme:'light',label:'Application menu',
    menus:['Application','Engine','Edit','View'].map((label,index)=>({label,index})) };
  window.menuCalls = [];
  window.camelliaWindowChrome = {
    getState: async () => chromeState,
    openMenu: payload => {menuCalls.push(payload);return new Promise(resolve=>window.closeNativeMenu=resolve);},
    onState: callback => {window.chromeChanged=callback;},
    onFocus: callback => {window.focusChrome=callback;},
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for theme in ['light', 'dark']:
        page = browser.new_page(viewport={'width': 1000, 'height': 800}, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.add_init_script(chrome)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('theme => {chromeState.theme=theme; chromeChanged(chromeState);}', theme)
        bar = page.get_by_role('menubar')
        expect(bar.get_by_role('menuitem')).to_have_text(['Application', 'Engine', 'Edit', 'View'])
        assert bar.bounding_box()['height'] == 40
        assert page.locator('body > .app').bounding_box()['y'] == 40
        # Menu focus can return to the unsent composer without losing the draft.
        composer = page.locator('#input')
        composer.fill('Keep this draft')
        page.evaluate('focusChrome()')
        first = bar.get_by_role('menuitem').first
        expect(first).to_be_focused()
        first.press('ArrowRight')
        expect(bar.get_by_role('menuitem').nth(1)).to_be_focused()
        page.keyboard.press('ArrowLeft')
        expect(first).to_be_focused()
        first.press('ArrowDown')
        expect(first).to_have_attribute('aria-expanded', 'true')
        assert page.evaluate('menuCalls[0].index') == 0
        assert page.evaluate('menuCalls[0].y') <= 40
        page.evaluate('closeNativeMenu({ok:true})')
        expect(first).to_have_attribute('aria-expanded', 'false')
        first.press('Escape')
        expect(composer).to_be_focused()
        expect(composer).to_have_value('Keep this draft')
        # Menu refresh updates translated labels and the theme without another row.
        page.evaluate("chromeState.menus=['应用','引擎','编辑','视图'].map((label,index)=>({label,index}));chromeChanged(chromeState)")
        expect(bar.get_by_role('menuitem')).to_have_text(['应用', '引擎', '编辑', '视图'])
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        # Browser and embedded content do not get a desktop caption at all.
        page.close()
    # An initial state request can finish after a newer opening/closing event.
    # It must not briefly hide the backdrop; paint acknowledgements must not
    # resurrect an overlay that was closed while rendering was pending.
    page = browser.new_page()
    page.add_init_script(bridge + """
      const backdropApi = {
        onSettingsOverlay: callback => { window.updateBackdrop = callback; },
        settingsOverlay: () => new Promise(resolve => { window.initialBackdrop = resolve; }),
      };
      window.dshDesktop = new Proxy(window.dshDesktop, {get:(target,name) => name in backdropApi ? backdropApi[name] : Reflect.get(target,name)});
    """)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.evaluate('() => {updateBackdrop(true);initialBackdrop(false);}')
    expect(page.locator('.settings-window-backdrop')).to_be_visible()
    page.evaluate('() => paintSettingsBackdrop()')
    expect(page.locator('.settings-window-backdrop')).to_be_visible()
    page.evaluate('() => updateBackdrop(false)')
    page.evaluate('() => paintSettingsBackdrop()')
    expect(page.locator('.settings-window-backdrop')).to_be_hidden()
    page.close()
    page = browser.new_page()
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    expect(page.locator('.desktop-titlebar')).to_have_count(0)
    assert page.locator('body > .app').bounding_box()['y'] == 0
    browser.close()
    assert not errors, errors
print('PASS: caption keyboard navigation, native menu payload, focus/draft retention, translation, light/dark geometry and browser layout')
