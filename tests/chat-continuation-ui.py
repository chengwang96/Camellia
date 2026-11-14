"""Account recovery and live replay keep exactly one working indicator. No model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in fixture_tree.body
               if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in fixture_tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const command = window.dshDesktop.conversationCommand;
  window.liveEvents = [];
  window.dshDesktop.onConversationEvent = fn => {
    window.deliver = event => {
      if (event.session_id === 'shared-fixture' && event.runId === 7)
        window.liveEvents.push(structuredClone(event));
      fn(event);
    };
    return () => {};
  };
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'task-list') return {ok:true,tasks:[]};
    const result = await command(request);
    if (request.action !== 'load-session' || request.payload !== 'shared-fixture') return result;
    result.activity = 'running';
    result.live = {sessionId:'shared-fixture',engine:'codex',runId:7,startedAt:Date.now()-120000,
      prompt:'Repair the status display',displayText:'Repair the status display',userSeq:3,
      attachments:[],messages:result.messages,events:structuredClone(window.liveEvents),
      eventSeq:window.liveEvents.length};
    return result;
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('.run-status')).to_have_count(1)

    def emit(event):
        page.evaluate("event => deliver({...event,session_id:'shared-fixture',runId:event.runId ?? 7,engine:'codex'})", event)

    def text(message):
        emit({'type': 'stream_event', 'event': {'type': 'message_start'}})
        emit({'type': 'stream_event', 'event': {'type': 'content_block_start', 'index': 0,
              'content_block': {'type': 'text', 'text': '', 'phase': 'commentary'}}})
        emit({'type': 'stream_event', 'event': {'type': 'content_block_delta', 'index': 0,
              'delta': {'type': 'text_delta', 'text': message}}})
        emit({'type': 'stream_event', 'event': {'type': 'content_block_stop', 'index': 0}})

    def tool(tool_id):
        emit({'type': 'gui:tool', 'id': tool_id, 'name': 'commandExecution',
              'input': {'command': 'Check current state'}, 'status': 'in_progress'})
        emit({'type': 'gui:tool', 'id': tool_id, 'name': 'commandExecution',
              'output': 'Completed before continuing', 'status': 'completed'})

    text('The first account checked the current state.')
    tool('before_switch')
    previous = page.locator('.turn').last
    previous.evaluate("turn => turn.id = 'before-switch'")
    emit({'type': 'conversation:continued', 'reason': 'subscription-account-switch'})
    text('The new account is continuing the repair.')
    expect(page.locator('.run-status')).to_have_count(1)
    expect(page.locator('#before-switch .run-status, #before-switch .cursor, #before-switch .think.live')).to_have_count(0)
    expect(page.locator('#before-switch')).to_contain_text('The first account checked the current state.')
    expect(page.locator('.continuation-notice')).to_contain_text('Subscription account switched')
    expect(page.locator('.tool-card')).to_have_count(1)
    expect(page.locator('.turn').last).to_contain_text('The new account is continuing the repair.')
    assert page.locator('.run-status').evaluate("row => row.closest('.turn') === document.querySelector('.turn:last-child')")

    # A stale run cannot remove or replace the current working indicator.
    turns = page.locator('.turn').count()
    emit({'type': 'conversation:continued', 'runId': 6, 'reason': 'subscription-account-switch'})
    expect(page.locator('.turn')).to_have_count(turns)
    expect(page.locator('.run-status')).to_have_count(1)

    # The same transition is used for compaction, including older reasonless events.
    tool('after_switch')
    emit({'type': 'conversation:continued'})
    text('Continuing after context recovery.')
    expect(page.locator('.run-status')).to_have_count(1)
    expect(page.locator('.tool-card')).to_have_count(2)

    # Opening the live conversation replays the account boundary from its snapshot.
    page.locator('[data-sid="another-session"]').click()
    page.wait_for_function("!loadingSession && context.sessionId === 'another-session'")
    page.locator('[data-sid="shared-fixture"]').click()
    page.wait_for_function("!loadingSession && context.sessionId === 'shared-fixture'")
    expect(page.locator('.run-status')).to_have_count(1)
    expect(page.locator('.tool-card')).to_have_count(2)
    expect(page.locator('.continuation-notice')).to_have_count(1)
    expect(page.locator('.msg-user', has_text='Repair the status display')).to_have_count(1)
    expect(page.locator('#chat')).to_contain_text('The first account checked the current state.')
    expect(page.locator('.turn').last).to_contain_text('Continuing after context recovery.')
    page.evaluate("changeLanguage('zh-CN')")
    expect(page.locator('.continuation-notice')).to_contain_text('已切换订阅账号')
    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'chat-continuation.png'), full_page=True, animations='disabled')
    page.evaluate("changeLanguage('en')")

    emit({'type': 'result', 'subtype': 'stopped', 'result': ''})
    expect(page.locator('.run-status')).to_have_count(0)
    expect(page.locator('.run-result')).to_contain_text('Stopped')
    expect(page.locator('.tool-card')).to_have_count(2)

    # A silent attempt leaves no empty agent block when it hands over.
    turns = page.locator('.turn').count()
    emit({'type': 'conversation:started', 'runId': 8, 'prompt': 'Next task', 'userSeq': 4})
    expect(page.locator('.turn')).to_have_count(turns + 1)
    emit({'type': 'conversation:continued', 'runId': 8, 'reason': 'subscription-account-switch'})
    expect(page.locator('.turn')).to_have_count(turns + 1)
    expect(page.locator('.run-status')).to_have_count(1)
    emit({'type': 'assistant', 'runId': 8, 'message': {'content': [{'type': 'text', 'text': 'Repair verified.'}]}})
    emit({'type': 'result', 'runId': 8, 'subtype': 'success', 'result': 'Repair verified.'})
    expect(page.locator('.run-status')).to_have_count(0)
    expect(page.locator('.turn').last).to_contain_text('Repair verified.')
    expect(page.locator('.turn').last.locator('.turn-completion')).to_contain_text('Completed')
    assert not errors, errors
    browser.close()
