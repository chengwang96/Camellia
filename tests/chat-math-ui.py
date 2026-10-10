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
cases = [
    {'name': 'escaped-dollar', 'text': r'$$\text{price: \$5} + x$$', 'math': 1, 'display': 1},
    {'name': 'bracket-price', 'text': r'\[\text{price: \$5} + x\]', 'math': 1, 'display': 1},
    {'name': 'multiline-inline', 'text': r'\(\frac{a}{b}' + '\n\n+c' + r'\)', 'math': 1, 'display': 0},
    {'name': 'quoted-array', 'text': r'> \[' + '\n' + r'> \begin{aligned}' + '\n'
     + r'> a &= b \\' + '\n> c &= d\n' + r'> \end{aligned}' + '\n' + r'> \]', 'math': 1, 'display': 1},
    {'name': 'list-display', 'text': '- Formula:\n  ' + r'\[' + '\n  x+y\n  ' + r'\]', 'math': 1, 'display': 1},
    {'name': 'table', 'text': '| Formula | Value |\n| --- | --- |\n| ' + r'\[\text{\$5}\] | $\lvert x\rvert$ |', 'math': 2, 'display': 1},
    {'name': 'code', 'text': '    $$x^2$$\n\n```tex\n' + r'\[x^2\]' + '\n```', 'math': 0, 'display': 0},
]
metrics = []

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
        # All desktop surfaces use the same delimiter rules and preserve TeX.
        for surface in ['chat', 'preview', 'discussion']:
            for case in cases:
                result = page.evaluate('''({surface, text}) => {
                    const area = document.createElement('div'); area.className = 'md';
                    if (surface === 'chat') area.innerHTML = mdRender(text);
                    else if (surface === 'preview') area.innerHTML = CamelliaMarkdownPreview.render(text);
                    else area.append(CamelliaMarkdown.render(document, text));
                    document.querySelector('#chat').append(area);
                    const result = {math: area.querySelectorAll('.katex').length,
                        display: area.querySelectorAll('.katex-display').length,
                        errors: area.querySelectorAll('.katex-error').length,
                        unresolved: area.innerHTML.includes('\\x01'),
                        annotations: [...area.querySelectorAll('annotation')].map(node => node.textContent)};
                    area.remove(); return result;
                }''', {'surface': surface, 'text': case['text']})
                assert result['math'] == case['math'] and result['display'] == case['display'], (surface, case, result)
                assert result['errors'] == 0 and not result['unresolved'], (surface, case, result)
                if case['name'] == 'quoted-array':
                    assert all('>' not in value and '<br>' not in value for value in result['annotations'])
                metrics.append({'theme': theme, 'surface': surface, 'case': case['name'], **result})
        # Reloading a saved conversation repeats parsing with no streaming state.
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady')
        expect(page.locator('#chat .turn .md').first.locator('.katex')).to_have_count(4)
        expect(page.locator('#chat .turn .md').first.locator('.katex-error')).to_have_count(0)
        font_status = page.evaluate('''async () => {
            await document.fonts.ready;
            return [...document.fonts].filter(font => font.family.startsWith('KaTeX')).map(font => ({family:font.family,status:font.status}));
        }''')
        assert any(font['status'] == 'loaded' for font in font_status), font_status
        assert not any(font['status'] == 'error' for font in font_status), font_status
        page.close()
    browser.close()
    assert not errors, errors
(screenshots / 'chat-math-metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Chat math: saved/streamed/reloaded messages, fonts and {len(metrics)} surface cases passed.')
