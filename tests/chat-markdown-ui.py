"""Chat links render and open real document previews in history and streamed replies."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in fixture_module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in fixture_module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
document = repo / 'docs/configuration.md'
code = repo / 'src/renderer/chat/markdown-links.js'
doc_path = document.as_posix()
code_path = code.as_posix()
text = ('- **额度用尽时**：新会话会优先选择其他已登录且仍有额度的账号。\n\n'
        '所以，你可以先把 A、B 两个账号分别登录好，以后按需选择账号并新建会话。\n\n'
        f'对应说明：[多账号管理]({doc_path}:62)。\n\n'
        '[网页说明](https://example.com/guide_(v2)) · [相对路径](docs/configuration.md:62)\n\n'
        f'[源代码]({code_path}:60)\n\n'
        f'代码示例：`[多账号管理]({doc_path}:62)`')
fixture['cwd'] = repo.as_posix()
fixture['messages'][-1]['text'] = text
files = {file.as_posix(): {'path': file.as_posix(), 'name': file.name, 'extension': file.suffix[1:].upper(),
                         'kind': 'text', 'url': file.as_uri(), 'text': file.read_text(encoding='utf-8'), 'size': file.stat().st_size}
         for file in [document, code]}
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const files = FILES;
  const command = window.dshDesktop.conversationCommand;
  window.dshDesktop.conversationCommand = request => request.action === 'task-list'
    ? Promise.resolve({ok:true,tasks:[]}) : command(request);
  window.previewRequests = [];
  window.dshDesktop.previewFile = async path => {
    previewRequests.push(path);
    return files[path] ? {ok:true,file:files[path]} : {ok:false,error:'Unexpected path: ' + path};
  };
})();""".replace('FILES', json.dumps(files))
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for theme, width in [('light', 1440), ('dark', 960)]:
        page = browser.new_page(viewport={'width': width, 'height': 900}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.context.route('https://example.com/**', lambda route: route.fulfill(body='<title>Link fixture</title>'))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        original_url = page.url
        link = page.locator('#chat').get_by_role('link', name='多账号管理', exact=True)
        expect(link).to_have_count(1)
        expect(link).to_have_attribute('data-chat-file', doc_path)
        expect(link).to_have_attribute('data-chat-line', '62')
        expect(page.locator('#chat .md-inline')).to_have_text(f'[多账号管理]({doc_path}:62)')
        assert page.evaluate('previewRequests') == []
        page.screenshot(path=str(screenshots / f'chat-markdown-links-{theme}.png'), animations='disabled')

        # Keyboard activation uses the same handler as a click, with no page navigation.
        link.focus()
        page.keyboard.press('Enter')
        expect(page.locator('#fileViewer')).to_be_visible()
        expect(page.locator('#fileViewerTitle')).to_have_text('configuration.md')
        expect(page.locator('#fileViewerMeta')).to_contain_text(doc_path + ':62')
        expect(page.locator('.file-preview-markdown h3[data-preview-line="62"]')).to_be_in_viewport()
        assert page.evaluate('previewRequests') == [doc_path]
        assert page.url == original_url
        page.screenshot(path=str(screenshots / f'chat-markdown-preview-{theme}.png'), animations='disabled')
        page.locator('#fileViewerClose').click()

        page.locator('#chat').get_by_role('link', name='相对路径', exact=True).click()
        expect(page.locator('#fileViewerTitle')).to_have_text('configuration.md')
        assert page.evaluate('previewRequests')[-1] == doc_path
        page.locator('#fileViewerClose').click()
        page.locator('#chat').get_by_role('link', name='源代码', exact=True).click()
        expect(page.locator('#fileViewerTitle')).to_have_text('markdown-links.js')
        assert page.locator('#fileViewerBody').evaluate('(body) => body.scrollTop') > 0
        page.locator('#fileViewerClose').click()

        with page.expect_popup() as opened:
            page.locator('#chat').get_by_role('link', name='网页说明', exact=True).click()
        popup = opened.value
        popup.wait_for_load_state()
        assert popup.url == 'https://example.com/guide_(v2)'
        assert page.url == original_url
        popup.close()

        # A partial link becomes clickable when the final streaming chunk arrives.
        partial = f'[流式文档]({doc_path}:62'
        page.evaluate('text => { onBlockStart({type:"text",text}, 0); flushBlockRenders(); }', partial)
        expect(page.locator('#chat').get_by_role('link', name='流式文档', exact=True)).to_have_count(0)
        page.evaluate('onBlockDelta({type:"text_delta",text:")"}, 0); onBlockStop(0)')
        page.locator('#chat').get_by_role('link', name='流式文档', exact=True).click()
        expect(page.locator('#fileViewerTitle')).to_have_text('configuration.md')
        assert page.evaluate('previewRequests')[-1] == doc_path
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        expect(page.locator('#chat').get_by_role('link', name='多账号管理', exact=True)).to_have_count(1)
        page.close()
    assert not errors, errors
    browser.close()
print('PASS: chat links, keyboard/click previews, source lines, external links, streaming, history, light/dark themes')
