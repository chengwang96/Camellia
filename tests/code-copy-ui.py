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
        page.add_init_script('''
            window.copiedCode = [];
            window.copyFails = false;
            Object.defineProperty(navigator, 'clipboard', {value: {
                writeText: async text => {
                    if (window.copyFails) throw new Error('Clipboard denied');
                    window.copiedCode.push(text);
                }
            }});
        ''')
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        code = '\tconst value = "<script>中文 & \\"quotes\\"</script>";  \n\n    ' + 'long_identifier_' * 60
        source = '```javascript\n' + code + '\n```\n\n```\nsecond block\n```'
        page.evaluate('source => { chat.innerHTML = `<div class="md" translate="no">${mdRender(source)}</div>`; }', source)
        buttons = page.locator('#chat .md-code-copy')
        expect(buttons).to_have_count(2)
        expect(buttons.first).to_have_attribute('aria-label', 'Copy code')
        expect(buttons.first).to_be_in_viewport()
        buttons.first.locator('svg').click()
        expect(buttons.first).to_have_attribute('aria-label', 'Code copied')
        assert page.evaluate('window.copiedCode') == [code]
        expect(buttons.last).to_have_attribute('aria-label', 'Copy code')
        page.locator('#chat .md-code-wrap').first.click()
        buttons.last.focus()
        page.keyboard.press('Enter')
        expect(buttons.last).to_have_attribute('aria-label', 'Code copied')
        assert page.evaluate('window.copiedCode') == [code, 'second block']
        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(buttons.last).to_have_attribute('title', '代码已复制')
        expect(buttons.first).to_have_attribute('aria-label', '复制代码', timeout=4000)
        page.evaluate('window.copyFails = true')
        buttons.first.click()
        expect(page.locator('#statusLine')).to_have_text('无法复制代码')
        expect(buttons.first).to_be_enabled()
        expect(buttons.first).to_have_attribute('aria-label', '复制代码')
        page.evaluate('window.copyFails = false')
        page.evaluate('source => { chat.innerHTML = `<div class="md">${mdRender(source, true)}</div>`; }', '```text\nstreaming partial')
        buttons.first.click()
        expect(buttons.first).to_have_attribute('aria-label', '代码已复制')
        assert page.evaluate('window.copiedCode.at(-1)') == 'streaming partial'
        page.close()
    browser.close()
print('Code copy: exact text, independent blocks, keyboard, language, failure, streaming and narrow layouts passed.')
