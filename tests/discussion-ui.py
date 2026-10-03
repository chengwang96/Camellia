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
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root), 'DISCUSSION_UI_NAVIGATION': '1',
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
            tools = page.locator('.home-tools > button')
            expect(tools).to_have_count(4)
            bounds = [tools.nth(i).bounding_box() for i in range(4)]
            assert bounds[0]['y'] == bounds[1]['y'] and bounds[2]['y'] == bounds[3]['y']
            page.screenshot(path=str(preview / 'discussion-home.png'), full_page=True)
            await_free = page.evaluate("window.dshDesktop.discussion('list')")
            assert not await_free['ok'], 'Non-discussion pages cannot use discussion IPC'
            page.locator('#openDiscussions').click()
            expect(page.locator('#firstGroup')).to_be_visible()
            page.wait_for_function("() => typeof document.querySelector('#discussionSurface')?.shadowRoot?.getElementById('firstGroup')?.onclick === 'function'")
            page.locator('#firstGroup').click()
            page.locator('#title').fill('首版范围评审')
            page.locator('#createForm button[type=submit]').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            page.locator('#message').fill('尚未发送的草稿')
            page.locator('#newDiscussionBtn').click()
            page.locator('#title').fill('第二个独立主题')
            page.locator('#createForm button[type=submit]').click()
            expect(page.locator('#groupTitle')).to_have_text('第二个独立主题')
            expect(page.locator('#discussionSessions .group-item')).to_have_count(2)
            second = page.locator('#discussionSessions .group-item').filter(has_text='第二个独立主题')
            second.locator('.session-more').click()
            page.get_by_role('menuitem', name='Rename', exact=True).click()
            page.locator('.session-rename-input').fill('第二个主题（已重命名）')
            page.locator('.session-rename-input').press('Enter')
            expect(page.locator('#groupTitle')).to_have_text('第二个主题（已重命名）')
            second = page.locator('#discussionSessions .group-item').filter(has_text='第二个主题（已重命名）')
            second.click(button='right')
            page.get_by_role('menuitem', name='Pin discussion', exact=True).click()
            expect(page.locator('#discussionSessions .group-item').first).to_contain_text('第二个主题（已重命名）')
            expect(second.locator('.group-item-pin')).to_be_visible()
            second.locator('.session-more').click()
            page.screenshot(path=str(preview / 'discussion-group-menu.png'), animations='disabled')
            page.get_by_role('menuitem', name='Rename', exact=True).click()
            page.locator('.session-rename-input').fill('不要保存')
            page.locator('.session-rename-input').press('Escape')
            expect(page.locator('#groupTitle')).to_have_text('第二个主题（已重命名）')
            page.locator('#discussionSessions .group-item').filter(has_text='首版范围评审').click()
            expect(page.locator('#message')).to_have_value('尚未发送的草稿')

            def add(name, engine='codex', connection='subscription', identity=''):
                page.locator('#addMember').click()
                page.locator('#engine').select_option(engine)
                page.locator('#connection').select_option(connection)
                page.locator('#memberName').fill(name)
                expect(page.locator('#memberIdentityPrompt')).to_have_value('')
                page.locator('#memberIdentityPrompt').fill(identity)
                page.locator('#saveMember').click()
                expect(page.locator('#memberDialog')).not_to_be_visible()

            scientist = '你是一位科学家，重视证据并说明不确定性。'
            programmer = '你是一位程序员，优先给出可实现的设计。'
            add('方案设计', identity=scientist)
            add('边界复核', 'antigravity')
            add('独立复核')
            add('尚未验证的连接', 'antigravity', 'api')
            expect(page.locator('.member-card')).to_have_count(4)
            expect(page.locator('#addMember')).to_be_disabled()
            assert len({c['id'] for c in discussion()['participants']}) == 4

            # Exercise real main/preload page navigation for all six harnesses,
            # then return through the sidebar section. No inference is sent.
            modes = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']
            page.locator('.mention').nth(0).click()
            page.locator('.mention').nth(1).click()
            page.locator('#replyMode').select_option('serial')
            page.locator('#message').fill('切换页面后应保留的讨论草稿')
            last_chat_draft = ''
            for engine in modes:
                expect(page.locator('#engineSwitch:visible')).to_have_count(0)
                page.locator(':light(#newSessionBtn)').click()
                expect(page.locator('#discussionSurface')).not_to_be_visible()
                page.wait_for_function('uiReady')
                assert page.locator('#engineSwitch:visible option:not([hidden])').evaluate_all('(items)=>items.map(item=>item.value)') == modes
                page.locator('#engineSwitch:visible').select_option(engine)
                page.wait_for_url(f'**/chat/claude.html?harness={engine}')
                page.wait_for_function('uiReady')
                expect(page.locator('#engineSwitch:visible')).to_have_value(engine)
                expect(page.locator('#engineSwitch:visible [value=discussions]')).to_have_count(0)
                expect(page.locator('#input')).to_have_value(last_chat_draft)
                last_chat_draft = f'单聊草稿：{engine}'
                page.locator('#input').fill(last_chat_draft)
                # Discussions are a peer section in every harness, with direct group navigation.
                expect(page.locator(':light([data-nav-section="discussions"])')).to_be_visible()
                page.locator('#discussionSessions [data-group-id]').filter(has_text='首版范围评审').click()
                expect(page.locator('#discussionSurface')).to_be_visible()
                expect(page.locator('#engineSwitch:visible')).to_have_count(0)
                expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
                expect(page.locator('#message')).to_have_value('切换页面后应保留的讨论草稿')
                expect(page.locator('.mention[aria-pressed=true]')).to_have_count(2)
                expect(page.locator('#replyMode')).to_have_value('serial')
                expect(page.locator(':light(#sessionList)')).to_contain_text('Workspaces')
                expect(page.locator(':light(#sessionList)')).to_contain_text('Standalone sessions')
            # Return to an ordinary draft, then create/manage a group from its peer section.
            page.locator(':light(#newSessionBtn)').click()
            page.wait_for_url('**/chat/claude.html?harness=pi')
            page.wait_for_function('uiReady')
            expect(page.locator('#input')).to_have_value(last_chat_draft)
            page.locator('#newDiscussionBtn').click()
            expect(page.locator('#discussionSurface')).to_be_visible()
            expect(page.locator('#groupDialog')).to_be_visible()
            page.locator('#groupDialog').press('Escape')
            page.locator(':light(#newSessionBtn)').click()
            page.wait_for_url('**/chat/claude.html?harness=pi')
            page.wait_for_function('uiReady')
            row = page.locator('#discussionSessions [data-group-id]').filter(has_text='首版范围评审')
            row.locator('.session-more').click()
            page.get_by_role('menuitem', name='Rename', exact=True).click()
            expect(page.locator('#discussionSurface')).not_to_be_visible()
            expect(page.locator('.session-rename-input')).to_be_visible()
            page.locator('.session-rename-input').press('Escape')
            page.locator('#discussionSessions [data-group-id]').filter(has_text='首版范围评审').click()
            expect(page.locator('#message')).to_have_value('切换页面后应保留的讨论草稿')
            assert not calls(), 'Switching pages must not dispatch any model'
            assert [json.loads(line)['engine'] for line in (root / 'navigation.jsonl').read_text(encoding='utf8').splitlines()] == modes[1:]
            page.locator('.mention').nth(0).click()
            page.locator('.mention').nth(1).click()

            def send(text):
                page.locator('#message').fill(text)
                page.locator('#message').press('Enter')
                expect(page.locator('#message')).to_have_value('')

            send('冻结范围：纯文本、四位成员。')
            expect(page.locator('#messages')).to_contain_text('冻结范围')
            assert not calls(), 'A note must not dispatch a model'
            page.locator('.mention').nth(0).click()
            page.locator('.mention').nth(1).click()
            page.locator('#replyMode').select_option('serial')
            send('请依次审查首版范围。')
            expect(page.locator('.message.assistant')).to_have_count(2, timeout=15000)
            trace = calls()
            assert len(trace) == 2 and trace[0]['identity']['runtimeId'] != trace[1]['identity']['runtimeId']
            assert 'codex reply to' in trace[1]['plan']['prompt'], 'Serial second member receives first reply'
            assert '方案设计' in trace[1]['plan']['prompt']
            assert scientist in trace[0]['plan']['prompt'] and scientist not in trace[1]['plan']['prompt']
            author = page.locator('#messages .message.assistant .member-identity').first
            author.locator('.turn-avatar').click()
            expect(page.locator('#identityPrompt')).to_have_value(scientist)
            page.locator('#identityPrompt').fill(programmer)
            page.locator('#identityDialog [data-close]').click()
            assert discussion()['participants'][0]['identityPrompt'] == scientist
            author.locator('.identity-name').click()
            page.locator('#identityPrompt').fill('Cancel with Escape')
            page.locator('#identityPrompt').press('Escape')
            expect(page.locator('#identityDialog')).not_to_be_visible()
            author.press('Enter')
            expect(page.locator('#identityPrompt')).to_have_value(scientist)
            page.locator('#identityPrompt').fill('')
            page.locator('#saveIdentity').click()
            expect(page.locator('#identityDialog')).not_to_be_visible()
            assert discussion()['participants'][0]['identityPrompt'] == ''
            author.click()
            page.locator('#identityPrompt').fill(programmer)
            page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
            expect(page.locator('#identityTitle')).to_have_text('编辑身份 prompt')
            page.screenshot(path=str(preview / 'discussion-identity-light.png'), animations='disabled')
            page.emulate_media(color_scheme='dark')
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(preview / 'discussion-identity-dark-narrow.png'), animations='disabled')
            page.locator('#saveIdentity').click()
            expect(page.locator('#identityDialog')).not_to_be_visible()
            assert discussion()['participants'][0]['identityPrompt'] == programmer
            assert len(calls()) == 2, 'Editing identity does not send a model request'
            page.emulate_media(color_scheme='light')
            page.set_viewport_size({'width':1440,'height':1000})
            page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
            page.screenshot(path=str(preview / 'discussions-light.png'), full_page=True)
            page.evaluate("window.CamelliaI18n.setLanguage('en')")
            page.locator('#replyMode').select_option('parallel')
            send('[hold] 用于验证停止')
            expect(page.locator('.message.pending')).to_have_count(2)
            expect(page.locator('#messages')).to_contain_text('[UI fixture] Preparing')
            pending_member = page.locator('.message.pending').first
            pending_member.locator('.member-identity').click()
            expect(page.locator('#saveIdentity')).to_be_disabled()
            expect(page.locator('#identityBusy')).to_contain_text('finish replying')
            page.locator('#identityDialog [data-close]').click()
            assert programmer in calls()[2]['plan']['prompt']
            assert scientist not in calls()[2]['plan']['prompt']
            page.locator('#discussionSessions .group-item.active .session-more').click()
            expect(page.get_by_role('menuitem', name='Delete discussion', exact=True)).to_be_disabled()
            page.get_by_role('menuitem', name='Rename', exact=True).press('Escape')
            active_calls = len(calls())
            page.locator(':light(#newSessionBtn)').click()
            expect(page.locator('#discussionSurface')).not_to_be_visible()
            page.wait_for_function('uiReady')
            page.locator('#discussionSessions [data-group-id]').filter(has_text='首版范围评审').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('.message.pending')).to_have_count(2)
            expect(page.locator('#messages')).to_contain_text('[UI fixture] Preparing')
            assert len(calls()) == active_calls, 'Returning to running replies must not replay them'
            page.locator('.message.pending').first.get_by_role('button', name='Stop', exact=True).click()
            expect(page.locator('.message.pending').first).to_contain_text('Stopped')
            assert not page.locator('#stopAll').is_disabled(), 'The other member is still active'
            page.locator('#stopAll').click()
            expect(page.locator('#stopAll')).to_be_disabled()
            assert not any(d['status'] in ['queued', 'preparing', 'running', 'stopping'] for d in discussion()['deliveries'])

            page.locator('.mention[aria-pressed=true]').evaluate_all('(buttons) => buttons.forEach(button => button.click())')
            # Re-query after each click because selection rebuilds the roster.
            for chip in range(4):
                current = page.locator('.mention').nth(chip)
                if current.get_attribute('aria-pressed') == 'true':
                    current.click()
            page.locator('.mention').nth(3).click()
            count = len(calls())
            send('This connection must stay unavailable.')
            expect(page.locator('.message.pending').last).to_contain_text('not verified')
            assert len(calls()) == count
            page.locator('.message.pending').last.get_by_role('button', name='Retry', exact=True).click()
            expect(page.locator('.message.pending')).to_have_count(4)
            assert len(calls()) == count

            page.evaluate("window.CamelliaI18n.setLanguage('zh-CN')")
            expect(page.locator('#addMember')).to_have_text('添加成员')
            page.screenshot(path=str(preview / 'discussions-unavailable.png'), full_page=True)
            page.emulate_media(color_scheme='dark')
            page.set_viewport_size({'width': 960, 'height': 820})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(preview / 'discussions-dark.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(preview / 'discussions-narrow.png'), full_page=True)
            page.reload()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('.message.assistant')).to_have_count(2)
            assert len(calls()) == count, 'Reload must not replay calls'
            page.locator('#message').fill('重启后继续编辑的草稿')
        except Exception:
            (preview / 'discussion-electron-error.log').write_text(
                json.dumps(errors, ensure_ascii=False) + '\n' + (root / 'electron.log').read_text(encoding='utf8'), encoding='utf8')
            page.screenshot(path=str(preview / 'discussion-electron-error.png'))
            raise
        finally:
            close(process, output, control)

        process, output, control, browser, page = launch(p)
        try:
            page.locator('#openDiscussions').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('.message.assistant')).to_have_count(2)
            expect(page.locator('.member-card')).to_have_count(4)
            expect(page.locator('#message')).to_have_value('重启后继续编辑的草稿')
            page.locator('#messages .message.assistant .member-identity').first.click()
            expect(page.locator('#identityPrompt')).to_have_value(programmer)
            page.locator('#identityDialog [data-close]').click()
            assert len(calls()) == count, 'App restart must not replay calls'
            expect(page.locator('#discussionSessions .group-item').first).to_contain_text('第二个主题（已重命名）')
            expect(page.locator('#discussionSessions .group-item').first.locator('.group-item-pin')).to_be_visible()
            assert not errors, errors
        finally:
            close(process, output, control)

        # Exercise the production service/catalog without fixture
        # injection. Stored test history must never enable a production binding.
        environment['DISCUSSION_UI_REAL_SERVICE'] = '1'
        process, output, control, browser, page = launch(p)
        try:
            page.locator('#openDiscussions').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('.member-state').nth(1)).to_have_text('Connection not verified')
            page.locator('#discussionSessions .group-item').filter(has_text='第二个主题（已重命名）').click()
            page.locator('#addMember').click()
            expect(page.locator('#binding')).to_contain_text('No configured models')
            expect(page.locator('#saveMember')).to_be_disabled()
            page.get_by_role('button', name='Cancel', exact=True).click()
            send('Production service: save a note without model calls.')
            expect(page.locator('#messages')).to_contain_text('Production service: save a note')
            page.locator('#discussionSessions .group-item.active .session-more').click()
            page.get_by_role('menuitem', name='Unpin', exact=True).click()
            expect(page.locator('#discussionSessions .group-item-pin')).to_have_count(0)
            page.locator('#discussionSessions .group-item.active .session-more').click()
            page.get_by_role('menuitem', name='Delete discussion', exact=True).click()
            page.locator('#discussionSurface #deleteCancel').click()
            expect(page.locator('#discussionSessions .group-item')).to_have_count(2)
            page.locator('#discussionSessions .group-item.active .session-more').click()
            page.get_by_role('menuitem', name='Delete discussion', exact=True).click()
            page.locator('#discussionSurface #deleteConfirm').click()
            expect(page.locator('#groupTitle')).to_have_text('首版范围评审')
            expect(page.locator('#message')).to_have_value('重启后继续编辑的草稿')
            expect(page.locator('#discussionSessions .group-item')).to_have_count(1)
            expect(page.locator('.message.assistant')).to_have_count(2)
            page.locator('#discussionSessions .group-item.active .session-more').click()
            page.get_by_role('menuitem', name='Delete discussion', exact=True).click()
            page.locator('#discussionSurface #deleteConfirm').click()
            expect(page.locator('#firstGroup')).to_be_visible()
            expect(page.locator('#messages')).to_be_empty()
            page.reload()
            expect(page.locator('#discussionSessions .group-item')).to_have_count(0)
            assert records() == []
            assert page.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('camellia:discussion:draft:'))") == []
            assert len(calls()) == count
            assert not errors, errors
        finally:
            close(process, output, control)
    print('PASS: real Electron group rename/Escape, pin/unpin across restart, delete confirmation/cancellation, busy deletion disabled, adjacent group/draft and last-group removal; six-harness menu and sidebar discussion navigation, drafts, four members, serial replies, stop, themes/languages/narrow layout, and production catalog. Synthetic replies only; no model calls.')
