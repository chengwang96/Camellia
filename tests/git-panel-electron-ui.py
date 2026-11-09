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
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.set_viewport_size({'width': 1440, 'height': 900})
                page.goto((repo_root / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
                page.wait_for_function('uiReady')
                page.locator(f'[data-sid="{session_id}"]').click()
                page.locator('#workPanelToggle').click()
                summary = page.locator('#workPanel [data-work-disclosure="git"]')
                expect(summary.locator('.git-change-label')).to_have_text('3 changed item(s)', timeout=30000)
                summary.locator('.git-change-open').click()
                viewer = page.locator('.file-viewer[data-mode="git"]')
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
                assert not errors, errors
                browser.close()
        finally:
            try:
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                process.wait(timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=5)
            log.flush()
            if process.returncode not in (0, None):
                print((root / 'electron.log').read_text(encoding='utf-8'), file=sys.stderr)

print('PASS: real Electron, preload IPC, staged commit and publish to a local bare repository')
