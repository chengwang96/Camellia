"""Real Electron/preload/Git workflow in an isolated temporary repository."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo_root = Path(__file__).resolve().parents[1]
output = repo_root / 'dist/ui-preview/git-panel-design'
output.mkdir(parents=True, exist_ok=True)


def port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def git(cwd, *args):
    result = subprocess.run(['git', *args], cwd=cwd, text=True, capture_output=True,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'})
    if result.returncode:
        raise AssertionError(f'git {args} failed: {result.stderr or result.stdout}')
    return result.stdout.strip()


if sys.platform == 'win32':
    executable = repo_root / 'node_modules/electron/dist/electron.exe'
elif sys.platform == 'darwin':
    executable = repo_root / 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
else:
    executable = repo_root / 'node_modules/electron/dist/electron'

with tempfile.TemporaryDirectory(prefix='camellia-git-electron-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    app = root / 'app'
    home = root / 'home'
    work = root / 'work'
    remote = root / 'remote.git'
    app.mkdir()
    home.mkdir()
    work.mkdir()
    draft = root / 'Draft report.md'
    draft.write_bytes(b'\xef\xbb\xbf# Original draft\r\n')
    picture = root / 'picture.svg'
    picture.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>', encoding='utf-8')
    (app / 'desktop-config.json').write_text(json.dumps({
        'port': 0, 'autoRefreshBalances': False, 'language': 'en', 'mode': 'home',
    }), encoding='utf-8')
    git(root, 'init', '--bare', str(remote))
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(work, 'init', '-b', 'main')
    git(work, 'config', 'user.name', 'Camellia UI Test')
    git(work, 'config', 'user.email', 'camellia-ui@example.invalid')
    (work / 'tracked.txt').write_text('base\n', encoding='utf-8')
    git(work, 'add', 'tracked.txt')
    git(work, 'commit', '-m', 'Initial fixture')
    (work / 'tracked.txt').write_text('base\nchanged from the worktree\n', encoding='utf-8')
    (work / 'notes.txt').write_text('first note\nsecond note\n', encoding='utf-8')
    (work / 'bulk').mkdir()
    (work / 'bulk/a.txt').write_text('bulk A\n', encoding='utf-8')
    (work / 'bulk/b.txt').write_text('bulk B\n', encoding='utf-8')
    git(work, 'remote', 'add', 'origin', str(remote))

    conversations = app / 'conversations'
    conversations.mkdir()
    session_id = 'git-electron-fixture'
    (conversations / f'{session_id}.json').write_text(json.dumps({
        'id': session_id, 'origin': 'codex', 'currentEngine': 'codex', 'title': 'Real Git workflow',
        'cwd': str(work), 'workspaceId': None, 'createdAt': time.time(), 'updatedAt': time.time(),
        'seq': 1, 'segments': {}, 'handoffs': [], 'apiModel': 'fixture-model',
    }), encoding='utf-8')
    (conversations / f'{session_id}.jsonl').write_text(json.dumps({
        'role': 'user', 'seq': 1, 'text': 'Inspect the repository changes.',
    }) + '\n', encoding='utf-8')

    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root),
                   'DISCUSSION_UI_NAVIGATION': '1', 'DISCUSSION_UI_CONTROL_PORT': str(control),
                   'DSH_HOME': str(root / 'dsh'), 'HOME': str(home),
                   'USERPROFILE': str(home), 'KIMI_CODE_HOME': str(home / '.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    errors = []
    with (root / 'electron.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([str(executable), str(repo_root / 'tests/discussion-ui-driver.cjs'),
                                    f'--remote-debugging-port={debug}'], cwd=repo_root, env=environment,
                                   stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                assert process.poll() is None, (root / 'electron.log').read_text(encoding='utf-8')
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version', timeout=.5)
                    break
                except OSError:
                    time.sleep(.15)
            else:
                raise AssertionError('Electron debugging endpoint did not start')
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
                page.on('pageerror', lambda error: errors.append(error.stack or str(error)))
                page.set_viewport_size({'width': 1440, 'height': 900})
                page.goto((repo_root / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
                page.wait_for_function('uiReady')
                page.locator(f'[data-sid="{session_id}"]').click()
                page.locator('#workPanelToggle').click()
                summary = page.locator('#workPanel [data-work-disclosure="git"]')
                expect(summary.locator('.git-change-label')).to_have_text('3 changed item(s)', timeout=30000)
                preview = page.locator('body > .app > #fileViewer')
                page.evaluate('path => openFilePreview(path)', str(picture))
                expect(preview.locator('.file-preview-image')).to_be_visible()
                expect(preview.locator('#fileViewerEdit')).to_be_hidden()
                page.evaluate('path => openFilePreview(path)', str(draft))
                expect(preview.locator('.file-preview-markdown h1')).to_have_text('Original draft')
                assert page.evaluate('typeof window.monaco') == 'undefined'
                assert not page.evaluate("dshDesktop.savePreviewText('invalid-token', 'bad edit')")['ok']
                edit = preview.get_by_role('button', name='Edit', exact=True)
                editor = preview.get_by_role('textbox', name='File contents')
                save = preview.get_by_role('button', name='Save', exact=True)
                render = preview.get_by_role('button', name='Preview', exact=True)
                status = preview.locator('.file-preview-editor-status')

                def fill_editor(value):
                    editor.press('ControlOrMeta+a')
                    page.keyboard.insert_text(value)

                def editor_value():
                    return page.evaluate("monaco.editor.getModels()[0].getValue(monaco.editor.EndOfLinePreference.LF)")

                edit.click()
                expect(status).to_have_text('Auto-save on')
                assert editor_value() == '# Original draft\n'
                assert page.evaluate('monaco.editor.getModels()[0].getLanguageId()') == 'markdown'
                expect(preview.locator('.line-numbers').first).to_have_text('1')
                editor.press('ControlOrMeta+f')
                expect(preview.locator('.find-widget')).to_be_visible()
                page.keyboard.press('Escape')
                expect(editor).to_be_focused()
                expect(save).to_be_disabled()
                fill_editor('# Saved draft\n\nSome text.\n')
                page.evaluate('monaco.editor.getEditors()[0].setSelection(new monaco.Range(1, 3, 1, 8))')
                expect(status).to_have_text('Saved')
                expect(editor).to_be_focused()
                assert page.evaluate('monaco.editor.getEditors()[0].getSelection().endColumn') == 8
                preview.screenshot(path=str(output / 'real-electron-text-editor.png'), animations='disabled')
                assert draft.read_bytes() == b'\xef\xbb\xbf# Saved draft\r\n\r\nSome text.\r\n'

                fill_editor('# Second save\n')
                editor.press('ControlOrMeta+s')
                expect(status).to_have_text('Saved')
                expect(editor).to_be_focused()
                assert draft.read_bytes() == b'\xef\xbb\xbf# Second save\r\n'

                fill_editor('# Save and preview\n')
                render.click()
                expect(preview.locator('.file-preview-markdown h1')).to_have_text('Save and preview')
                assert page.evaluate('monaco.editor.getModels().length') == 0
                assert draft.read_bytes() == b'\xef\xbb\xbf# Save and preview\r\n'

                edit.click()
                fill_editor('# Save on close\n')
                preview.locator('#fileViewerClose').click()
                expect(preview).to_be_hidden()
                assert draft.read_bytes() == b'\xef\xbb\xbf# Save on close\r\n'

                page.evaluate('path => openFilePreview(path)', str(draft))
                edit.click()
                fill_editor('# Save before changing files\n')
                page.evaluate('path => openFilePreview(path)', str(picture))
                expect(preview.locator('.file-preview-image')).to_be_visible()
                assert draft.read_bytes() == b'\xef\xbb\xbf# Save before changing files\r\n'

                page.evaluate('path => openFilePreview(path)', str(draft))
                edit.click()
                draft.write_bytes(b'# External version\n')
                fill_editor('# My unsaved edit\n')
                expect(status).to_contain_text('The file changed on disk')
                assert editor_value() == '# My unsaved edit\n'
                assert draft.read_bytes() == b'# External version\n'
                page.once('dialog', lambda dialog: dialog.dismiss())
                preview.locator('#fileViewerClose').click()
                assert editor_value() == '# My unsaved edit\n'
                page.once('dialog', lambda dialog: dialog.dismiss())
                page.evaluate('path => openFilePreview(path)', str(picture))
                assert editor_value() == '# My unsaved edit\n'
                if not summary.is_visible():
                    page.locator('#workPanelToggle').click()
                page.once('dialog', lambda dialog: dialog.dismiss())
                summary.locator('.git-change-open').click()
                assert editor_value() == '# My unsaved edit\n'
                page.once('dialog', lambda dialog: dialog.accept())
                summary.locator('.git-change-open').click()
                viewer = page.locator('.file-viewer[data-mode="git"]')
                expect(viewer.locator('#fileViewerEdit')).to_be_hidden()
                assert draft.read_bytes() == b'# External version\n'
                expect(viewer.locator('.git-diff-addition').first).to_contain_text('changed from the worktree')
                expect(viewer.locator('#fileViewerExternal')).to_be_hidden()
                viewer.locator('[data-git-path="bulk/"]').click()
                viewer.locator('.git-directory-content .work-action').click()
                expect(viewer.locator('.git-directory-files .git-file-row')).to_have_count(2)
                viewer.locator('[data-git-path="bulk/a.txt"]').click()
                expect(viewer.locator('.git-diff-addition').first).to_contain_text('bulk A')
                notes = viewer.locator('.git-file-row').filter(has_text='notes.txt')
                notes.locator('.git-stage-button').click()
                expect(viewer.locator('.git-file-group').nth(1).locator('.git-group-count')).to_have_text('1')
                viewer.locator('.git-commit-input').fill('Commit from the real Git panel')
                viewer.locator('.git-commit-form button[type="submit"]').click()
                expect(viewer.locator('.git-operation-notice')).to_contain_text('Created commit', timeout=30000)
                assert git(work, 'log', '-1', '--format=%s') == 'Commit from the real Git panel'
                assert (work / 'tracked.txt').read_text(encoding='utf-8').replace('\r\n', '\n') == 'base\nchanged from the worktree\n'
                expect(viewer.locator('.git-push-button')).to_have_text('Publish branch')
                viewer.locator('.git-push-button').click()
                expect(page.locator('.git-remote-select')).to_have_value('origin')
                page.locator('.git-confirm-actions button[type="submit"]').click()
                expect(viewer.locator('.git-operation-notice')).to_contain_text('Pushed commits', timeout=30000)
                assert git(remote, 'log', '-1', '--format=%s', 'main') == 'Commit from the real Git panel'
                assert git(remote, 'show', 'main:notes.txt').replace('\r\n', '\n') == 'first note\nsecond note'
                assert git(remote, 'show', 'main:tracked.txt').replace('\r\n', '\n') == 'base'
                viewer.screenshot(path=str(output / 'real-electron-workflow.png'), animations='disabled')
                page.evaluate('path => openFilePreview(path)', str(draft))
                edit.click()
                fill_editor('# Save before Home\n')
                page.locator('#backToHome').click()
                page.wait_for_url('**/home/home.html')
                assert draft.read_bytes() == b'# Save before Home\n'

                page.goto((repo_root / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='load')
                page.wait_for_function('uiReady')
                page.evaluate('path => openFilePreview(path)', str(draft))
                edit.click()
                fill_editor('# Save before quit\n')
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                assert process.wait(timeout=15) == 0
                assert draft.read_bytes() == b'# Save before quit\n'
                assert not errors, errors
                browser.close()
        finally:
            if process.poll() is None:
                try:
                    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                    process.wait(timeout=15)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=5)
            log.flush()
            if process.returncode not in (0, None):
                print((root / 'electron.log').read_text(encoding='utf-8'), file=sys.stderr)

print('PASS: Electron text autosave, focus, save on exit, conflicts and local Git workflow')
