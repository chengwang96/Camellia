"""Chat math renders in saved messages and streaming replies. No model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in fixture_source.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in fixture_source.body
                   if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))

formula = r'''\[
L_{\mathrm{total}}
=L_{\mathrm{harm}}
+\lambda_1L_{\mathrm{anat}}
+\lambda_2L_{\mathrm{les}}
+\lambda_3L_{\mathrm{latent}}
+\lambda_4L_{\mathrm{edge}}
+\lambda_5L_{\mathrm{tex}}
\]'''
fixture['messages'][0]['text'] = r'请检查公式 \[x^2 + y^2\]'
fixture['messages'][1]['text'] = (
    '站点和疾病嵌入被转换为条件向量，经交叉注意力参与噪声预测。\n\n'
    '算法 2 又加入六项损失：\n\n' + formula + '\n\n'
    '它们分别约束：\n\n- **协调损失**：对齐源与目标分布的均值、标准差。\n'
    '- **解剖一致性损失**：利用 SSIM 保持图像结构。\n\n'
    + r'行内 $E=mc^2$ 和 \(\alpha_1\)。价格 $5 and $10。' + '\n\n'
    '$$z^2$$\n\n`' + r'\[x^2\]' + '`\n\n```tex\n' + formula + '\n```'
)
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for theme, width in [('light', 1440), ('dark', 960)]:
        page = browser.new_page(viewport={'width': width, 'height': 1000}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        saved = page.locator('#chat .turn .md').first
        expect(saved.locator('.katex')).to_have_count(4)
        expect(saved.locator('.katex-display')).to_have_count(2)
        expect(saved.locator('.katex-error')).to_have_count(0)
        expect(saved.locator('math[display="block"]')).to_have_count(2)
        expect(saved.locator('.md-inline')).to_have_text(r'\[x^2\]')
        expect(saved.locator('.md-code > code')).to_have_text(formula)
        expect(saved).to_contain_text('价格 $5 and $10')
        expect(page.locator('#chat .msg-user .katex-display')).to_have_count(1)
        page.evaluate('document.fonts.ready')
        assert saved.locator('section').evaluate_all(
            'sections => sections.every(element => element.clientWidth <= element.closest(".md").clientWidth + 1)')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        saved.locator('.katex-display').first.scroll_into_view_if_needed()
        page.screenshot(path=str(screenshots / f'chat-math-{theme}.png'), animations='disabled')

        # The source is retained while streaming, then rendered when \] arrives.
        partial = r'流式公式：\[' + '\n' + r'\frac{a}{b}'
        page.evaluate('text => { onBlockStart({type:"text",text}, 99); flushBlockRenders(); }', partial)
        streamed = page.locator('#chat .turn .md').last
        expect(streamed.locator('.katex')).to_have_count(0)
        expect(streamed).to_contain_text(r'\frac{a}{b}')
        page.evaluate('text => { onBlockDelta({type:"text_delta",text}, 99); flushBlockRenders(); }', '\n\\]')
        expect(streamed.locator('.katex-display')).to_have_count(1)
        expect(streamed.locator('.katex-error')).to_have_count(0)
        page.evaluate('onBlockStop(99)')
        expect(streamed.locator('.katex-display')).to_have_count(1)
        page.close()
    browser.close()
    assert not errors, errors
print('Chat math: bracket and dollar delimiters, saved messages, code, prices and streaming passed.')
