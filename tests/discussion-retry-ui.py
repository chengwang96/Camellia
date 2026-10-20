"""Click Retry through real Electron IPC after a serial context failure and restart. No model calls."""
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
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


seed = r"""
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DiscussionManager } = require('./src/engines/discussions/manager');
const root = process.env.DISCUSSION_UI_TEST_ROOT;
const manager = new DiscussionManager({ dir: path.join(root, 'app/discussions') });
const group = manager.create({ title: 'Serial retry after restart', cwd: path.join(root, 'work') });
const members = ['Completed member', 'Failed member', 'Unstarted member'].map(name => manager.addMember(group.id,
  { name, engine: 'codex', connection: 'subscription', model: 'fixture-model', accountRef: 'fixture-account', contextWindow: 32768 }));
const request = manager.enqueue(group.id, { requestId: 'original-question', text: '[UI fixture] Preserve this question', participantIds: members.map(m => m.id), mode: 'serial' });
const first = manager.prepare(group.id, request.deliveryIds[0]);
manager.saveInput(group.id, first.id, first.generation, { prompt: 'Synthetic original input', inputThroughSeq: first.inputThroughSeq });
manager.start(group.id, first.id, first.generation, randomUUID());
manager.complete(group.id, first.id, first.generation, '[UI fixture] Preserve this completed reply', { ...first, deliveryId: first.id, stopped: true, released: true });
const failed = manager.prepare(group.id, request.deliveryIds[1]);
manager.fail(group.id, failed.id, failed.generation, 'failed', { ...failed, deliveryId: failed.id, stopped: true, released: true },
  'This member needs a context summary. Long-context summaries are not connected yet; keep this history and start a new group with a shorter brief.');
manager.configureMember(group.id, failed.participantId, { contextWindow: 64000 });
manager.store.close();
process.stdout.write(JSON.stringify({ id: group.id, failed: failed.id, last: request.deliveryIds[2], target: failed.participantId, lastMember: members[2].id }));
"""

with tempfile.TemporaryDirectory(prefix='discussion-retry-ui-', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary)
    (root / 'app').mkdir()
    (root / 'home').mkdir()
    (root / 'app/desktop-config.json').write_text(json.dumps({
        'port': 0, 'autoRefreshBalances': False, 'language': 'zh-CN', 'mode': 'home',
    }), encoding='utf8')
    debug, control = port(), port()
    environment = {**os.environ, 'DISCUSSION_UI_TEST_ROOT': str(root), 'DISCUSSION_UI_NAVIGATION': '1',
                   'DISCUSSION_UI_CONTROL_PORT': str(control), 'DSH_HOME': str(root / 'dsh'),
                   'HOME': str(root / 'home'), 'USERPROFILE': str(root / 'home'), 'KIMI_CODE_HOME': str(root / 'home/.kimi-code')}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    ids = json.loads(subprocess.run(['node', '-e', seed], cwd=repo, env=environment, check=True, capture_output=True, text=True).stdout)

    def calls():
        file = root / 'calls.jsonl'
        return [json.loads(line) for line in file.read_text(encoding='utf8').splitlines()] if file.exists() else []

    with open(root / 'electron.log', 'w', encoding='utf8') as output:
        process = subprocess.Popen([str(repo / 'node_modules/electron/dist/electron.exe'),
                                    str(repo / 'tests/discussion-ui-driver.cjs'), f'--remote-debugging-port={debug}'],
                                   cwd=repo, env=environment, stdout=output, stderr=output,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 50
            while True:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise AssertionError((root / 'electron.log').read_text(encoding='utf8'))
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version', timeout=.5)
                    break
                except OSError:
                    time.sleep(.15)
            with sync_playwright() as p:
                browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.set_viewport_size({'width': 1280, 'height': 900})
                page.locator('#openDiscussions').click()
                expect(page.locator('#groupTitle')).to_have_text('Serial retry after restart')
                expect(page.locator('.message.assistant')).to_have_count(1)
                failed = page.locator(f'[data-delivery-id="{ids["failed"]}"]')
                last = page.locator(f'[data-delivery-id="{ids["last"]}"]')
                expect(failed).to_contain_text('此成员需要上下文摘要')
                expect(last).to_contain_text('已中断')
                page.locator('#message').fill('保留未发送草稿')
                assert not calls(), 'Opening recovered history does not dispatch any response'
                failed.get_by_role('button', name='重试', exact=True).click()
                expect(page.locator('.message.assistant')).to_have_count(2, timeout=15000)
                expect(failed).to_have_count(0)
                expect(last).to_contain_text('已中断')
                expect(page.locator('#notice')).not_to_be_visible()
                expect(page.locator('#message')).to_have_value('保留未发送草稿')
                trace = calls()
                assert len(trace) == 1 and trace[0]['identity']['participantId'] == ids['target']
                assert trace[0]['identity']['profile']['contextWindow'] == 64000
                assert 'Preserve this completed reply' in trace[0]['plan']['prompt']
                page.screenshot(path=str(preview / 'discussion-retry-after-restart.png'), animations='disabled')
                last.get_by_role('button', name='重试', exact=True).click()
                expect(page.locator('.message.assistant')).to_have_count(3, timeout=15000)
                expect(page.locator('.message.user')).to_have_count(1)
                expect(page.locator('.message.pending')).to_have_count(0)
                assert len(calls()) == 2 and calls()[1]['identity']['participantId'] == ids['lastMember']
                page.reload()
                expect(page.locator('#groupTitle')).to_have_text('Serial retry after restart')
                expect(page.locator('.message.assistant')).to_have_count(3)
                expect(page.locator('#message')).to_have_value('保留未发送草稿')
                assert len(calls()) == 2 and not errors, errors
        finally:
            try:
                urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{control}/quit', method='POST'), timeout=3)
                process.wait(timeout=15)
            except Exception:
                process.kill()
                process.wait(timeout=5)
print('PASS: real Electron Retry after serial failure/restart and context correction; one selected attempt, completed history and drafts preserved, stopped successors require explicit retries. Model responses are synthetic fixtures.')
