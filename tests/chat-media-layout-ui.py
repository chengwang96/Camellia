"""Inline media keeps a fixed size while the window and side panels change."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture'
                                                        for target in node.targets))
node = next(node for node in module.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
fixture['cwd'] = repo.as_posix()
fixture['messages'][-1]['text'] = (
    'Media sizing check:\n\n'
    '![Landscape](artifacts/mobile-inline-image-demo-20261109/landscape-mountains.jpg)\n\n'
    '![Square](assets/icon-1024.png)\n\n'
    '![Small](assets/icon-256.png)'
)
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))


def media_boxes(page):
    page.wait_for_function("document.querySelector('#chat img.chat-inline-image')?.naturalWidth > 0")
    boxes = {name: page.locator(f'#chat img.chat-inline-image[alt="{name}"]').bounding_box()
             for name in ('Landscape', 'Square', 'Small')}
    return {name: (round(box['width'], 1), round(box['height'], 1)) for name, box in boxes.items()}


def assert_fixed_media(page):
    boxes = media_boxes(page)
    assert abs(boxes['Landscape'][0] - 560) <= 1 and boxes['Landscape'][1] <= 421, boxes
    assert abs(boxes['Square'][0] - 420) <= 1 and abs(boxes['Square'][1] - 420) <= 1, boxes
    assert 256 <= boxes['Small'][0] <= 258 and 256 <= boxes['Small'][1] <= 258, boxes
    assert page.locator('#chatScroll').evaluate('(node)=>node.scrollWidth<=node.clientWidth+1')
    return boxes


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex',
              wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate('localStorage.removeItem("camellia-chat-sidebar-collapsed")')
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('#sidebar')).to_be_visible()
    initial = assert_fixed_media(page)

    # The conversation list collapses without changing media size.
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_hidden()
    assert page.evaluate('document.body.classList.contains("workbench-sidebar-collapsed")')
    assert media_boxes(page) == initial
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_visible()
    assert media_boxes(page) == initial

    # A panel reserves room beside the chat only while media still fits.
    page.locator('#workPanelToggle').click()
    expect(page.locator('#workPanel')).to_be_visible()
    page.wait_for_function("getComputedStyle(document.querySelector('#chatScroll')).marginRight === '496px'")
    assert media_boxes(page) == initial
    page.screenshot(path=str(preview / 'media-layout-panel-1440.png'), animations='disabled')

    # Closing panels comes first as the window narrows, before the sidebar.
    # The panel closes as soon as the reserved column can no longer hold media
    # at full width, not at a separate hard-coded breakpoint.
    page.set_viewport_size({'width': 1300, 'height': 900})
    expect(page.locator('#workPanel')).to_be_hidden()
    expect(page.locator('#sidebar')).to_be_visible()
    assert media_boxes(page) == initial

    # Opening a panel by hand below that budget floats it over the chat
    # instead of taking width, and it survives further narrowing.
    page.locator('#workPanelToggle').click()
    expect(page.locator('#workPanel')).to_be_visible()
    assert page.evaluate("getComputedStyle(document.querySelector('#chatScroll')).marginRight") == '0px'
    assert not page.evaluate("document.querySelector('.main').classList.contains('panel-fits')")
    page.set_viewport_size({'width': 1200, 'height': 900})
    expect(page.locator('#workPanel')).to_be_visible()
    expect(page.locator('#sidebar')).to_be_visible()
    assert media_boxes(page) == initial

    # With more room and the conversation list out of the way the same panel
    # fits again; expanding the list once more makes the panel give way.
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_hidden()
    page.set_viewport_size({'width': 1200, 'height': 900})
    page.wait_for_function("getComputedStyle(document.querySelector('#chatScroll')).marginRight === '496px'")
    assert media_boxes(page) == initial
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_visible()
    expect(page.locator('#workPanel')).to_be_hidden()

    page.set_viewport_size({'width': 850, 'height': 900})
    expect(page.locator('#sidebar')).to_be_hidden()
    assert page.evaluate('document.body.classList.contains("workbench-sidebar-collapsed")')
    assert media_boxes(page) == initial

    # A manual expand under the threshold wins until the window widens again.
    # Here the real column is genuinely narrower than the media, so 100% is
    # the last-resort overflow guard rather than a window-following size.
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_visible()
    column = page.locator('#chat').bounding_box()['width']
    shrunk = media_boxes(page)
    assert shrunk['Landscape'][0] <= column + 1 and shrunk['Landscape'][0] < 560, (column, shrunk)
    page.set_viewport_size({'width': 1440, 'height': 900})
    expect(page.locator('#sidebar')).to_be_visible()
    assert media_boxes(page) == initial

    # An explicit collapse is remembered across reloads.
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_hidden()
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#sidebar')).to_be_hidden()
    assert page.evaluate('document.body.classList.contains("workbench-sidebar-collapsed")')
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_visible()
    page.locator('[data-sid="shared-fixture"]').click()
    assert_fixed_media(page)

    # The video rule matches the image rule and never forces full width.
    video = page.evaluate('''() => {
      const host = document.createElement('div'); host.className = 'md'; host.style.width = '768px';
      const element = document.createElement('video'); element.className = 'chat-inline-video';
      host.append(element); document.querySelector('#chat').append(host);
      const style = getComputedStyle(element);
      const result = { maxWidth: style.maxWidth, maxHeight: style.maxHeight, display: style.display };
      host.remove(); return result;
    }''')
    assert video == {'maxWidth': 'min(100%, 560px)', 'maxHeight': '420px', 'display': 'block'}, video

    # Phones keep the drawer; media only shrinks to avoid overflow.
    page.set_viewport_size({'width': 420, 'height': 820})
    expect(page.locator('#sidebar')).to_be_hidden()
    page.locator('#workbenchSidebarToggle').click()
    expect(page.locator('#sidebar')).to_be_visible()
    assert page.locator('#workbenchSidebarBackdrop').is_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#sidebar')).to_be_hidden()
    column = page.locator('#chat').bounding_box()['width']
    assert media_boxes(page)['Landscape'][0] <= column + 1
    page.screenshot(path=str(preview / 'media-layout-phone-420.png'), animations='disabled')

    assert not errors, errors
    browser.close()
print('PASS: fixed inline media sizing, panel priority, sidebar collapse, persistence and phone drawer')
