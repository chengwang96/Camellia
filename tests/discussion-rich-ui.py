"""Real Electron main/preload/IPC + discussion service, with marked test replies."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='discussion-ui-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    (root / 'app').mkdir()
    (root / 'home').mkdir()
    (root / 'app/desktop-config.json').write_text(json.dumps({
        'port': 0, 'autoRefreshBalances': False, 'language': 'en',
    }), encoding='utf8')
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root), 'DISCUSSION_UI_NAVIGATION': '1', 'DISCUSSION_UI_RICH': '1',
                   'DSH_HOME': str(root / 'dsh'), 'HOME': str(root / 'home'),
                   'USERPROFILE': str(root / 'home'), 'KIMI_CODE_HOME': str(root / 'home/.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    errors = []

    def launch(p):
        # Navigation saves the last harness. Start each isolated phase at Home;
        # keep all discussion files and Chromium draft storage across restarts.
        config_file = root / 'app/desktop-config.json'
        config = json.loads(config_file.read_text(encoding='utf8'))
        config['mode'] = 'home'
        config_file.write_text(json.dumps(config), encoding='utf8')
        debug, control = port(), port()
        environment['DISCUSSION_UI_CONTROL_PORT'] = str(control)
        output = open(root / 'electron.log', 'a', encoding='utf8')
        process = subprocess.Popen([str(repo / 'node_modules/electron/dist/electron.exe'),
                                    str(repo / 'tests/discussion-ui-driver.cjs'), f'--remote-debugging-port={debug}'],
                                   cwd=repo, env=environment, stdout=output, stderr=output,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError((root / 'electron.log').read_text(encoding='utf8'))
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version', timeout=.5)
                break
            except OSError:
                time.sleep(.15)
        browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
        try:
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
            page.on('pageerror', lambda e: errors.append(str(e)))
            expect(page.locator('#openDiscussions')).to_be_visible(timeout=30000)
        except Exception:
            (preview / 'discussion-electron-error.log').write_text((root / 'electron.log').read_text(encoding='utf8'), encoding='utf8')
            close(process, output, control)
            raise
        return process, output, control, browser, page

    def close(process, output, control):
        try:
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
            process.wait(timeout=15)
        except Exception:
            process.kill()
            process.wait(timeout=5)
        finally:
            output.close()

    def records():
        return [json.loads(f.read_text(encoding='utf8')) for f in (root / 'app/discussions').glob('*.json')]

    def discussion():
        return next(record for record in records() if record['title'] == '首版范围评审')

    def calls():
        file = root / 'calls.jsonl'
        return [json.loads(line) for line in file.read_text(encoding='utf8').splitlines()] if file.exists() else []

    with sync_playwright() as p:
        process, output, control, browser, page = launch(p)
        try:
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.locator('#openDiscussions').click()
            page.wait_for_function("() => document.querySelector('#discussionSurface')?.shadowRoot?.querySelector('#firstGroup')?.onclick != null")
            assert not errors, errors
            page.locator('#firstGroup').click()
            page.locator('#title').fill('首版范围评审')
            page.locator('#createForm button[type=submit]').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            for engine, name in [('codex', 'Scientist'), ('antigravity', 'Programmer')]:
                page.locator('#addMember').click()
                page.locator('#engine').select_option(engine)
                page.locator('#memberName').fill(name)
                page.locator('#saveMember').click()
                expect(page.locator('#memberDialog')).not_to_be_visible()
            page.locator('#mentions .mention').first.click()
            original = root / 'evidence.txt'
            original.write_text('Attachment evidence 42', encoding='utf8')
            page.evaluate("""path => { const data = new DataTransfer(); data.setData('application/x-camellia-attachment-path', path); document.querySelector('#discussionSurface').shadowRoot.querySelector('#inputCard').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:data})); }""", str(original))
            expect(page.locator('#attachRow .attchip')).to_have_count(1)
            original.unlink()
            page.locator('#attachRow .attchip-name').click()
            expect(page.locator('#discussionSurface #fileViewerBody')).to_contain_text('Attachment evidence 42')
            page.locator('#discussionSurface #fileViewerClose').click()
            page.reload()
            expect(page.locator('#attachRow .attchip')).to_have_count(1)
            expect(page.locator('#discussionSurface #send')).to_be_enabled()
            page.locator('#discussionSurface #send').click()
            expect(page.locator('.message.assistant')).to_have_count(1)
            assert calls()[0]['plan']['attachments'][0]['name'] == 'evidence.txt'
            assert len(discussion()['messages'][0]['attachments']) == 1
            # In-memory clipboard bitmap exercises the real preload/image saver.
            page.evaluate("""() => { const raw = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa8AAAAASUVORK5CYII='); const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(raw, c=>c.charCodeAt(0))], 'pixel.png', {type:'image/png'})); document.querySelector('#discussionSurface').shadowRoot.querySelector('#message').dispatchEvent(new ClipboardEvent('paste', {bubbles:true, clipboardData:data})); }""")
            expect(page.locator('#attachRow img')).to_have_count(1)
            page.locator('#mentions .mention').nth(1).click()
            page.locator('#discussionSurface #send').click()
            expect(page.locator('#notice')).to_contain_text('Programmer: This connection does not support image input.')
            expect(page.locator('#attachRow img')).to_have_count(1)
            assert len(calls()) == 1
            page.locator('#mentions .mention').nth(1).click()
            page.locator('#discussionSurface #send').click()
            expect(page.locator('.message.assistant')).to_have_count(2)
            assert calls()[1]['plan']['attachments'][0]['isImage']
            page.locator('#message').fill('[tools] write a fixture')
            page.locator('#discussionSurface #send').click()
            expect(page.locator('#discussionPermission')).to_be_visible()
            expect(page.locator('#permissionMember')).to_contain_text('Scientist')
            page.screenshot(path=str(preview / 'discussion-tools-permission-light.png'))
            page.locator('#permissionActions').get_by_role('button', name='Deny', exact=True).click()
            expect(page.locator('#discussionPermission')).not_to_be_visible()
            expect(page.locator('.message.assistant')).to_have_count(3)
            expect(page.locator('.tool-card .tool-output').last).to_contain_text('Denied by the user')
            page.locator('#message').fill('[tools] allow a fixture')
            page.locator('#discussionSurface #send').click()
            expect(page.locator('#discussionPermission')).to_be_visible()
            page.emulate_media(color_scheme='dark')
            page.set_viewport_size({'width':390,'height':844})
            page.screenshot(path=str(preview / 'discussion-tools-permission-dark.png'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#permissionActions').get_by_role('button', name='Allow', exact=True).click()
            expect(page.locator('.message.assistant')).to_have_count(4)
            expect(page.locator('.discussion-artifacts .attchip-name')).to_contain_text(['fixture-result.txt'])
            page.locator('.discussion-artifacts .attchip-name').last.click()
            expect(page.locator('#discussionSurface #fileViewerBody')).to_contain_text('Synthetic UI result')
            page.locator('#discussionSurface #fileViewerClose').click()
            page.emulate_media(color_scheme='light')
            page.set_viewport_size({'width':1440,'height':1000})
            page.locator('#message').fill('[tools] cancel pending approval')
            page.locator('#discussionSurface #send').click()
            expect(page.locator('#discussionPermission')).to_be_visible()
            page.locator('#discussionPermission').press('Escape')
            page.locator('#stopAll').click()
            expect(page.locator('#stopAll')).to_be_disabled()
            expect(page.locator('#discussionPermission')).not_to_be_visible()
            assert page.evaluate("window.dshDesktop.discussion('load', {id: document.querySelector('.group-item.active').dataset.groupId})")['group']['permissions'] == []
            page.locator('#groupPermission').select_option('auto')
            expect(page.locator('#groupPermission')).to_have_value('auto')
            page.locator('#message').fill('[questions] choose a role')
            page.locator('#discussionSurface #send').click()
            expect(page.locator('#discussionPermission')).to_be_visible()
            page.locator('#permissionQuestions').get_by_role('radio', name='Scientist').check()
            page.locator('#permissionQuestions').get_by_role('checkbox', name='CSV').check()
            page.locator('#permissionQuestions .question-custom input').nth(1).fill('Markdown')
            page.locator('#permissionActions').get_by_role('button', name='Answer later').click()
            page.get_by_role('button', name='Answer questions', exact=True).click()
            expect(page.locator('#permissionQuestions').get_by_role('radio', name='Scientist')).to_be_checked()
            expect(page.locator('#permissionQuestions .question-custom input').nth(1)).to_have_value('Markdown')
            page.locator('#permissionActions').get_by_role('button', name='Submit answers').click()
            expect(page.locator('.message.assistant')).to_have_count(5)
            assert json.loads((root / 'question-answer.json').read_text())['input'] == {'role': 'Scientist', 'formats': ['CSV', 'Markdown']}
            html = root / 'preview.html'
            html.write_text('''<!doctype html><style>body{background:rgb(240, 241, 242)}</style><button id="increment">Add</button><span id="count">0</span><span id="isolation"></span><span id="network"></span><script>let n=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=++n;document.querySelector('#isolation').textContent=typeof window.dshDesktop;fetch('https://example.com').catch(()=>document.querySelector('#network').textContent='blocked')</script>''', encoding='utf8')
            page.evaluate("""path => { const data = new DataTransfer(); data.setData('application/x-camellia-attachment-path', path); document.querySelector('#discussionSurface').shadowRoot.querySelector('#inputCard').dispatchEvent(new DragEvent('drop', {bubbles:true, dataTransfer:data})); }""", str(html))
            page.locator('#attachRow .attchip-name').click()
            frame = page.frame_locator('.file-preview-html')
            expect(frame.locator('#isolation')).to_have_text('undefined')
            expect(frame.locator('#network')).to_have_text('blocked')
            # The fixture uses an offscreen Electron window. Exercise the
            # sandboxed frame with keyboard activation; browser mouse handling
            # is covered by html-preview-ui.py against the same shared viewer.
            frame.locator('#increment').press('Enter')
            expect(frame.locator('#count')).to_have_text('1')
            expect(frame.locator('body')).to_have_css('background-color', 'rgb(240, 241, 242)')
            page.locator('#discussionSurface #fileViewerClose').click()
            page.locator('#attachRow .attchip-x').click()
            page.screenshot(path=str(preview / 'discussion-rich-light.png'))

            # Simulate the old main process while loading the current renderer.
            # Background file discovery must not turn text replies into global
            # failures or retry model turns. Only the one generated file is read.
            unsupported = root / 'unsupported-actions.json'
            unsupported.write_text(json.dumps(['artifacts', 'set-permission']), encoding='utf8')
            previous_actions = len((root / 'actions.jsonl').read_text().splitlines())
            previous_calls = len(calls())
            page.reload()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('.message.assistant')).to_have_count(5)
            expect(page.locator('.message.assistant .discussion-artifact-error')).to_have_count(1)
            expect(page.locator('.discussion-artifact-error')).to_contain_text('Restart Camellia')
            expect(page.locator('#notice')).not_to_be_visible()
            page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
            expect(page.locator('.discussion-artifact-error')).to_contain_text('无法加载这条回复生成的文件。')
            actions = [json.loads(line) for line in (root / 'actions.jsonl').read_text().splitlines()[previous_actions:]]
            assert sum(action['action'] == 'artifacts' for action in actions) == 1
            page.locator('#message').fill('尚未发送的草稿')
            page.locator('#groupPermission').select_option('full')
            expect(page.locator('#notice')).to_contain_text('当前应用尚未加载此功能，请重启 Camellia 后重试。')
            expect(page.locator('#groupPermission')).to_have_value('auto')
            expect(page.locator('#message')).to_have_value('尚未发送的草稿')
            page.locator('.discussion-artifact-error').scroll_into_view_if_needed()
            bounds = page.locator('#notice').bounding_box()
            assert bounds['y'] >= page.locator('#discussionSurface .main-header').bounding_box()['height']
            assert bounds['y'] + bounds['height'] <= page.locator('#discussionSurface #chatScroll').bounding_box()['y'] + 1
            page.screenshot(path=str(preview / 'discussion-errors-light.png'))
            page.emulate_media(color_scheme='dark')
            page.set_viewport_size({'width':390,'height':844})
            page.locator('.discussion-artifact-error').scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(preview / 'discussion-errors-dark-narrow.png'))
            page.locator('#dismissNotice').click()
            expect(page.locator('#notice')).not_to_be_visible()
            expect(page.locator('.discussion-artifact-error')).to_be_visible()
            unsupported.write_text('[]', encoding='utf8')
            page.locator('.discussion-artifact-error').get_by_role('button', name='重新加载文件', exact=True).click()
            expect(page.locator('.discussion-artifact-error')).to_have_count(0)
            expect(page.locator('.discussion-artifacts .attchip-name')).to_contain_text(['fixture-result.txt'])
            expect(page.locator('#message')).to_have_value('尚未发送的草稿')
            assert len(calls()) == previous_calls
            page.evaluate("window.CamelliaI18n.setLanguage('en')")
            page.emulate_media(color_scheme='light')
            page.set_viewport_size({'width':1440,'height':1000})
            assert not errors, errors
        finally:
            close(process, output, control)
        process, output, control, browser, page = launch(p)
        try:
            page.locator('#openDiscussions').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('#groupPermission')).to_have_value('auto')
            expect(page.locator('.message.assistant')).to_have_count(5)
            expect(page.locator('.discussion-message-attachments .attchip')).to_have_count(2)
            expect(page.locator('.tool-card')).to_have_count(3)
            expect(page.locator('#message')).to_have_value('尚未发送的草稿')
            expect(page.locator('#notice')).not_to_be_visible()
            expect(page.locator('.discussion-artifacts .attchip-name')).to_contain_text(['fixture-result.txt'])
            assert not errors, errors
        finally:
            close(process, output, control)
    print('PASS: Electron attachments, draft/restart, IPC approvals, artifacts and themes; legacy-main errors localized, scoped and retryable without new model calls. Model/tool execution is a synthetic fixture.')
