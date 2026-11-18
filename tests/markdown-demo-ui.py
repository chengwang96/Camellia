"""Open docs/markdown-preview-demo.md in the real right sidebar and verify it."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
demo = repo / 'docs/markdown-preview-demo.md'
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == 'bridge' for t in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
payload = {'path': demo.as_posix(), 'name': demo.name, 'extension': 'MD', 'kind': 'text',
           'url': demo.as_uri(), 'text': demo.read_text(encoding='utf-8'), 'size': demo.stat().st_size}
bridge += '(() => { window.dshDesktop.previewFile = async path => ({ ok: true, file: FILE }); })();'.replace(
    'FILE', json.dumps(payload))

screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=shared-fixture',
              wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate(f"async () => {{ await openFilePreview({json.dumps(payload['path'])}); }}")
    article = page.locator('.file-preview-markdown')
    expect(article).to_be_visible()
    expect(article.get_by_role('heading', name='右侧栏 Markdown 预览样例', exact=True)).to_be_visible()
    expect(article.get_by_role('link', name='发送邮件')).to_have_attribute('href', 'mailto:demo@example.com')
    expect(article.get_by_role('link', name='正斜杠盘符')).to_have_attribute(
        'href', 'file:///C:/Code/Camellia/docs/artifact-previews.md')
    expect(article.get_by_role('link', name='反斜杠盘符')).to_have_attribute(
        'href', 'file:///C:/Code/Camellia/docs/artifact-previews.md')
    expect(article.get_by_role('link', name='README.md')).to_have_count(0)
    expect(article.locator('video.file-preview-video')).to_have_count(1)
    expect(article.locator('img[src$="icon-256.png"]')).to_have_count(1)
    assert article.inner_text().count('行压力测试') == 400
    page.screenshot(path=str(screenshots / 'markdown-preview-demo.png'), animations='disabled')
    article.locator('video.file-preview-video').scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    video = article.locator('video.file-preview-video').evaluate(
        'el => ({w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height})')
    assert video['w'] > 100 and video['h'] > 100, video
    page.screenshot(path=str(screenshots / 'markdown-preview-demo-video.png'), animations='disabled')
    article.locator('pre code').first.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    page.screenshot(path=str(screenshots / 'markdown-preview-demo-code.png'), animations='disabled')

    # Same-file anchors must resolve without regard to case.
    article.get_by_role('link', name='当前文件内的混合大小写锚点').click()
    expect(page.locator('.file-preview-markdown h2').filter(has_text='Anchor Case Test')).to_be_in_viewport()

    # The cross-file anchor should open artifact-previews.md even though it is absent here.
    page.evaluate("""() => {
      window.dshDesktop.previewFile = async path => ({
        ok: true,
        file: { name: 'artifact-previews.md', path, url: 'file:///' + path, kind: 'text', extension: 'MD',
          text: '# Intro\\n\\n' + 'Filler.\\n\\n'.repeat(120) + '## Several accounts of one provider\\n\\nTarget.', size: 2000 }
      });
    }""")
    page.get_by_role('link', name='跳到配置文档的账号章节').click()
    expect(page.locator('#fileViewerTitle')).to_have_text('artifact-previews.md')
    expect(page.locator('.file-preview-markdown h2').last).to_be_in_viewport()
    page.locator('#fileViewerClose').click()
    assert not errors, errors
    browser.close()
print('PASS: markdown preview demo renders in the right sidebar')
