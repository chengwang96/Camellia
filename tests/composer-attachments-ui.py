"""Large attachment drafts remain editable in the real renderer; no model calls."""
import ast
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const command = window.dshDesktop.conversationCommand;
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'list-attachable-conversations') return {ok:true,sessions:[]};
    if (request.action === 'send') { window.sentPayload = request.payload;
      return {ok:true,sessionId:'shared-fixture',userSeq:3,runId:10}; }
    return command(request);
  };
  window.dshDesktop.pickAttachments = async () => ({canceled:false,paths:window.pickedPaths});
})();"""
paths = [f'D:/Fixture/PubPeer - 研究资料 {index:03d} with a long descriptive filename.txt' for index in range(85)]
draft = '\n'.join(f'Draft line {index}' for index in range(20))
output = repo / 'dist/ui-preview'
output.mkdir(parents=True, exist_ok=True)


def assert_editor_in_view(page):
    for selector in ['#input', '#send']:
        box = page.locator(selector).bounding_box()
        if not box or box['y'] < 0 or box['y'] + box['height'] > page.viewport_size['height']:
            page.screenshot(path=str(output / 'attachments-overflow.png'), animations='disabled')
            layout = page.locator('.main-header, .chat-scroll, .input-zone, #inputCard, #statusLine, .attach-list').evaluate_all('(elements) => elements.map(el => ({class:el.className,rect:el.getBoundingClientRect().toJSON()}))')
            raise AssertionError((selector, box, page.viewport_size, layout))
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    cases = 0
    for width, height, theme, language in [(1440, 900, 'light', 'en'), (960, 640, 'dark', 'zh-CN'), (640, 480, 'light', 'zh-CN')]:
        for engine in ['claude', 'codex', 'dsh', 'kimi', 'antigravity']:
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + f'?harness={engine}&conversation=shared-fixture', wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
            page.evaluate('paths => addAttachments(paths)', paths[:12])
            expect(page.locator('#attachRow .attchip')).to_have_count(12)
            expect(page.locator('#attachRow details')).to_have_count(0)
            expect(page.locator('#send')).to_be_enabled()

            page.evaluate('paths => { window.pickedPaths = paths; }', paths[12:])
            page.locator('#attachBtn').click()
            page.locator('.attach-option').first.click()
            details = page.locator('#attachRow .attach-overflow')
            summary = details.locator('summary')
            expect(page.locator('#attachRow .attchip')).to_have_count(85)
            expect(details).not_to_have_attribute('open', '')
            expect(details.locator('.attach-count')).to_have_text('85 attachments' if language == 'en' else '85 个附件')
            expect(details.locator('.attchip').first).to_be_hidden()
            page.locator('#input').fill(draft)
            assert_editor_in_view(page)
            if engine == 'codex':
                page.screenshot(path=str(output / f'attachments-collapsed-{width}-{theme}.png'), animations='disabled')

            summary.focus()
            summary.press('Enter')
            expect(details).to_have_attribute('open', '')
            assert details.locator('.attach-list').evaluate('(el) => el.scrollHeight > el.clientHeight && el.clientHeight <= Math.min(180, innerHeight * .25)')
            assert_editor_in_view(page)
            if engine == 'codex':
                page.screenshot(path=str(output / f'attachments-expanded-{width}-{theme}.png'), animations='disabled')
            page.locator('#attachRow .attchip-x').last.click()
            expect(page.locator('#attachRow .attchip')).to_have_count(84)
            expect(details).to_have_attribute('open', '')
            alternate = 'zh-CN' if language == 'en' else 'en'
            page.evaluate('language => CamelliaI18n.setLanguage(language)', alternate)
            expect(details.locator('.attach-count')).to_have_text('84 attachments' if alternate == 'en' else '84 个附件')
            summary.click()
            expect(details).not_to_have_attribute('open', '')
            expect(page.locator('#input')).to_have_value(draft)

            page.reload(wait_until='networkidle')
            page.wait_for_function('uiReady')
            expect(page.locator('#attachRow .attchip')).to_have_count(84)
            expect(details).not_to_have_attribute('open', '')
            expect(page.locator('#input')).to_have_value(draft)
            page.locator('#send').click()
            page.wait_for_function('Boolean(window.sentPayload)')
            sent = page.evaluate('sentPayload')
            assert [file['path'] for file in sent['attachments']] == paths[:-1]
            assert sent['displayText'] == draft
            expect(page.locator('#attachRow')).to_be_hidden()
            expect(page.locator('#input')).to_have_value('')

            page.evaluate('paths => addAttachments(paths)', paths[:13])
            summary.click()
            page.locator('#attachRow .attchip-x').last.click()
            expect(page.locator('#attachRow details')).to_have_count(0)
            expect(page.locator('#attachRow .attchip')).to_have_count(12)
            expect(page.locator('#attachRow .attchip').first).to_be_visible()
            assert_editor_in_view(page)
            page.close()
            cases += 1
    browser.close()
    assert not errors, errors
print(f'PASS: {cases} composer cases with 85 attachments, bounded expansion, keyboard toggle, removal, translations, restored drafts and complete send payloads')
