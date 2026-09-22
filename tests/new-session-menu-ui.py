"""New-session action menus with real workspace IPC and no model requests."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(
    ['node', str(repo / 'tests/claude-ui-driver.cjs')],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding='utf-8',
)


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    response = json.loads(driver.stdout.readline())
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response


bridge = """(() => {
  window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on')
    ? () => () => {}
    : async payload => (await window.testRpc(method, payload)).result});
})();"""


def expect_menu_position(page, position):
    menu = page.locator('.dsh-pop')
    expect(menu).to_be_visible()
    menu.evaluate('element => Promise.all(element.getAnimations().map(animation => animation.finished))')
    bounds = menu.bounding_box()
    viewport = page.viewport_size
    expected_x = max(8, min(position['x'], viewport['width'] - bounds['width'] - 8))
    expected_y = max(8, min(position['y'], viewport['height'] - bounds['height'] - 8))
    assert abs(bounds['x'] - expected_x) <= 1, (bounds, position)
    assert abs(bounds['y'] - expected_y) <= 1, (bounds, position)


try:
    fixtures = rpc('fixtures')['result']
    rpc('claudeMetaOp', {'op': 'create-workspace', 'name': 'DSH', 'path': fixtures['alpha']})
    rpc('workbenchSaveSettings', {'language': 'zh-CN'})
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1160, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri(), wait_until='networkidle')
        page.locator('section .ws-row .session-more').first.click()
        expect(page.locator('section #sessionCurrent')).to_be_visible()
        for selector in ['#sessionCurrent', '.session-item[data-history="1"]']:
            item = page.locator(selector).first
            for offset in [{'x': 12, 'y': 10}, {'x': 100, 'y': 25}]:
                bounds = item.bounding_box()
                position = {'x': bounds['x'] + offset['x'], 'y': bounds['y'] + offset['y']}
                item.click(button='right', position=offset)
                expect_menu_position(page, position)
                if selector == '#sessionCurrent':
                    page.get_by_role('menuitem', name='更改工作区…', exact=True).click()
                    expect_menu_position(page, position)
                page.keyboard.press('Escape')
                expect(item.locator('.session-more')).to_be_focused()
            position = {'x': 1158, 'y': 898}
            item.evaluate("(element, position) => element.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: position.x, clientY: position.y, button: 2}))", position)
            expect_menu_position(page, position)
            page.keyboard.press('Escape')
            more = item.locator('.session-more')
            bounds = more.bounding_box()
            more.click()
            expect_menu_position(page, {'x': bounds['x'], 'y': bounds['y'] + bounds['height'] + 4})
            page.keyboard.press('Escape')
        for button in ['left', 'right']:
            page.locator('#sessionCurrent .session-more').click(button=button)
            expect(page.locator('.dsh-pop [role=menuitem]')).to_have_text(['更改工作区…'])
            page.get_by_role('menuitem', name='更改工作区…', exact=True).click()
            expect(page.locator('.dsh-pop .current')).to_have_text('DSH')
            page.keyboard.press('Escape')
        page.locator('#sessionCurrent .session-more').click()
        page.get_by_role('menuitem', name='更改工作区…', exact=True).click()
        page.get_by_role('menuitem', name='无工作区 · 独立会话', exact=True).click()
        expect(page.locator('#independentSessions #sessionCurrent')).to_be_visible()
        page.locator('#sessionCurrent .session-more').click()
        expect(page.locator('.dsh-pop [role=menuitem]')).to_have_text(['更改工作区…'])
        page.get_by_role('menuitem', name='更改工作区…', exact=True).click()
        expect(page.locator('.dsh-pop .current')).to_have_text('无工作区 · 独立会话')
        page.get_by_role('menuitem', name='DSH', exact=True).click()
        expect(page.locator('section #sessionCurrent')).to_be_visible()
        assert not errors, errors
        browser.close()
    print('PASS: cursor-positioned menus, viewport clamping, button anchoring, localization, and workspace selection')
finally:
    driver.terminate()
    driver.wait(timeout=10)
