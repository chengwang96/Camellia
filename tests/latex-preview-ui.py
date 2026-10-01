"""LaTeX code blocks preview locally with KaTeX; other blocks keep plain code."""
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

screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

formula = '\\begin{equation}\nE = mc^2\n\\end{equation}'
plain = 'E = mc^2'
broken = '\\begin{subequations}a=b\\end{subequations}'
source = ('```latex\n' + formula + '\n```\n\n```tex\n' + plain + '\n```\n\n'
          '```python\nprint("hello")\n```\n\n```\nplain text\n```\n\n'
          '```latex\n' + broken + '\n```')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for theme, width in [('light', 1100), ('dark', 390)]:
        page = browser.new_page(viewport={'width': width, 'height': 800}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(scope['bridge'])
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate('source => { chat.innerHTML = `<div class="md" translate="no">${mdRender(source)}</div>`; }', source)

        blocks = page.locator('#chat .md-code-block')
        expect(blocks).to_have_count(5)
        # Only LaTeX blocks carry the preview control; code blocks stay unchanged.
        expect(page.locator('#chat .md-code-latex')).to_have_count(3)
        latex_buttons = page.locator('#chat .md-code-latex')
        expect(latex_buttons.first).to_have_attribute('aria-label', 'Preview formula')
        expect(latex_buttons.first).to_have_attribute('aria-expanded', 'false')
        expect(page.locator('#chat .md-code-python .md-code-latex')).to_have_count(0)
        assert blocks.nth(2).locator('.md-code-latex').count() == 0
        assert blocks.nth(3).locator('.md-code-latex').count() == 0
        # The language label shares the header with up to three buttons.
        assert blocks.first.locator('.md-code-header > span').evaluate('element => element.getBoundingClientRect().height < 24')

        # The formula renders inside the panel without a LaTeX toolchain.
        latex_buttons.first.click()
        panel = blocks.first.locator('.md-latex-panel')
        expect(panel).to_be_visible()
        expect(latex_buttons.first).to_have_attribute('aria-expanded', 'true')
        expect(panel.locator('.katex-display')).to_have_count(1)
        expect(panel.locator('.katex-error')).to_have_count(0)
        expect(panel.locator('.md-latex-notice')).to_contain_text('Rendered without a LaTeX compiler. · KaTeX')
        assert '\\begin{equation}' not in panel.inner_text()
        assert panel.evaluate('element => element.getBoundingClientRect().width <= document.documentElement.clientWidth + 1')

        # A plain expression also previews, and the close button restores focus.
        latex_buttons.nth(1).click()
        expect(blocks.nth(1).locator('.md-latex-panel')).to_be_visible()
        expect(blocks.nth(1).locator('.katex')).to_have_count(1)
        blocks.first.locator('.md-latex-close').click()
        expect(panel).to_be_hidden()
        expect(latex_buttons.first).to_have_attribute('aria-expanded', 'false')
        assert page.evaluate('document.activeElement.className') == 'md-code-latex'

        # Invalid LaTeX reports the parse error instead of breaking the page.
        latex_buttons.nth(2).click()
        broken_panel = blocks.nth(4).locator('.md-latex-panel')
        expect(broken_panel.locator('.md-latex-block.is-error')).to_have_count(1)
        expect(broken_panel.locator('.md-latex-error')).to_contain_text('No such environment')
        expect(broken_panel.locator('.md-latex-source')).to_have_text(broken)

        page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
        expect(latex_buttons.first).to_have_attribute('aria-label', '预览公式')
        expect(latex_buttons.first).to_have_attribute('title', '预览公式')
        expect(panel.locator('.md-latex-head strong')).to_have_text('公式预览')

        # Streaming a growing block keeps an open preview open and current.
        page.evaluate('onBlockStart({type:"text",text:"```latex\\n\\\\frac{a}{b}"}, 99); flushBlockRenders();')
        streamed = page.locator('#chat .md-code-block').last
        streamed.locator('.md-code-latex').click()
        expect(streamed.locator('.md-latex-panel .katex')).to_have_count(1)
        page.evaluate('onBlockDelta({type:"text_delta",text:" = c\\n```"}, 99); flushBlockRenders();')
        expect(streamed.locator('.md-latex-panel')).to_be_visible()
        expect(streamed.locator('.md-latex-panel .katex')).to_have_count(1)
        page.evaluate('onBlockStop(99)')
        expect(streamed.locator('.md-latex-panel')).to_be_visible()
        page.screenshot(path=str(screenshots / f'latex-preview-{theme}.png'), animations='disabled')
        page.close()
    assert not errors, errors
    browser.close()
print('LaTeX preview: button placement, KaTeX rendering, errors, close focus, language and narrow width passed.')
