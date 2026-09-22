import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in [1100, 390]:
        page = browser.new_page(viewport={'width': width, 'height': 800})
        page.add_init_script(scope['bridge'])
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        code = '    value = "' + 'long_identifier_中文' * 60 + '"\n    <script>alert(1)</script>'
        source = '```python\n' + code + '\n```\n\n```\nsecond block\n```'
        page.evaluate('source => { chat.innerHTML = `<div class="md" translate="no">${mdRender(source)}</div>`; }', source)
        blocks = page.locator('#chat .md-code')
        buttons = page.locator('#chat .md-code-wrap')
        expect(blocks.first).to_have_text(code)
        assert blocks.first.evaluate('element => element.scrollWidth > element.clientWidth')
        buttons.first.click()
        expect(buttons.first).to_have_attribute('aria-pressed', 'true')
        expect(buttons.last).to_have_attribute('aria-pressed', 'true')
        assert blocks.first.evaluate('element => element.scrollWidth <= element.clientWidth + 1')
        expect(blocks.first).to_have_text(code)
        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(buttons.first).to_have_text('自动换行')
        page.evaluate('source => { chat.innerHTML = `<div class="md" translate="no">${mdRender(source + "\\nStreaming")}</div>`; }', source)
        expect(buttons.first).to_have_attribute('aria-pressed', 'true')
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate('source => { chat.innerHTML = `<div class="md">${mdRender(source, true)}</div>`; }', source)
        expect(buttons.first).to_have_attribute('aria-pressed', 'true')
        buttons.first.focus()
        page.keyboard.press('Enter')
        expect(buttons.first).to_have_attribute('aria-pressed', 'false')
        assert blocks.first.evaluate('element => element.scrollWidth > element.clientWidth')
        expect(blocks.first).to_have_text(code)
        page.close()
    browser.close()
print('Code wrap: desktop/narrow layouts, language, streaming, persistence and keyboard passed.')
