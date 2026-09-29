"""Inline local images load in history/streams and open the existing viewer."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo/'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id=='fixture' for t in n.targets))
node = next(n for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id=='bridge' for t in n.targets))
picture = repo/'assets/icon-256.png'
fixture['cwd'] = repo.as_posix()
fixture['messages'][-1]['text'] = f'Local image preview:\n\n![Camellia]({picture.as_posix()})\n\n![Missing](assets/missing-inline-test.png)'
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += """const imageCommand = window.dshDesktop.conversationCommand;
window.dshDesktop.conversationCommand = request => request.action === 'task-list' ? Promise.resolve({ok:true,tasks:[]}) : imageCommand(request);
window.previewRequests=[]; window.dshDesktop.previewFile=async path=>{
 previewRequests.push(path);return {ok:true,file:IMAGE};};""".replace('IMAGE', json.dumps({'path':picture.as_posix(),'name':picture.name,'kind':'image','url':picture.as_uri(),'size':picture.stat().st_size}))
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for theme in ['light','dark']:
        page=browser.new_page(viewport={'width':1100,'height':850})
        page.add_init_script(bridge)
        page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex&conversation=shared-fixture',wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('theme=>document.documentElement.dataset.theme=theme',theme)
        img=page.locator('#chat img.chat-inline-image').first
        img.scroll_into_view_if_needed()
        page.wait_for_function("document.querySelector('#chat img.chat-inline-image')?.naturalWidth > 0")
        expect(page.locator('#chat .chat-image-fallback')).to_have_text('Missing')
        img.focus();page.keyboard.press('Enter')
        expect(page.locator('#fileViewer')).to_be_visible()
        expect(page.locator('#fileViewerTitle')).to_have_text('icon-256.png')
        page.locator('#fileViewerClose').click()
        partial='![Stream](assets/icon-256.png'
        page.evaluate('text=>{onBlockStart({type:"text",phase:"final_answer",text},0);flushBlockRenders();}',partial)
        expect(page.locator('#chat img.chat-inline-image')).to_have_count(1)
        page.evaluate('onBlockDelta({type:"text_delta",text:")"},0);onBlockStop(0)')
        expect(page.locator('#chat img.chat-inline-image')).to_have_count(2)
        page.locator('#chat img.chat-inline-image').last.click()
        expect(page.locator('#fileViewer')).to_be_visible()
        page.locator('#fileViewerClose').click()
        page.set_viewport_size({'width':480,'height':800})
        assert img.evaluate('el=>el.getBoundingClientRect().width<=el.parentElement.clientWidth')
        page.reload(wait_until='networkidle');page.wait_for_function('uiReady && !loadingSession')
        expect(page.locator('#chat img.chat-inline-image')).to_have_count(1)
        page.close()
    browser.close()
print('PASS: local image history, streaming, keyboard/click preview, missing-file fallback, reload and narrow layout')

