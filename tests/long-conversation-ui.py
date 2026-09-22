"""Long history pagination, cancellable restoration and stale load isolation."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge'] + r"""
(() => {
  const command = window.dshDesktop.conversationCommand;
  window.cancelledSessions = [];
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'cancel') {
      cancelledSessions.push(request.payload.sessionId);
      return {ok:true};
    }
    if (request.action !== 'load-session') return command(request);
    if (request.payload === 'delayed') {
      await new Promise(resolve => { window.releaseHistory = resolve; });
    }
    const result = await command(request);
    result.currentEngine = 'codex';
    result.messages = Array.from({length:10000}, (_, index) => ({
      role:index % 2 ? 'assistant':'user', seq:index+1, text:'History message '+index
    }));
    if (request.payload === 'live') {
      result.activity = 'running';
      result.live = {sessionId:'live',engine:'codex',runId:42,startedAt:Date.now(),
        prompt:'Continue',messages:result.messages,eventSeq:10000,
        events:Array.from({length:10000}, (_, index) => ({
          type:'gui:usage',usage:{input_tokens:index+1},session_id:'live',runId:42,eventSeq:index+1
        }))};
    }
    return result;
  };
})();
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate("openHistorySession('shared-fixture')")
    expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(100)
    expect(page.locator('.history-earlier')).to_have_count(1)
    page.locator('.history-earlier').click()
    page.wait_for_function("!document.querySelector('.history-earlier').disabled")
    expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(200)
    texts = page.locator('#chat > .msg-user .bubble, #chat > .turn .md').all_text_contents()
    assert texts == [f'History message {index}' for index in range(9800, 10000)], texts[:5]

    page.evaluate("void openHistorySession('delayed')")
    page.wait_for_function('typeof releaseHistory === "function"')
    assert page.evaluate('!contextBusy()')
    page.locator('[data-sid="another-session"]').click()
    page.wait_for_function("context.sessionId === 'another-session' && !loadingSession")
    page.evaluate('releaseHistory()')
    assert page.evaluate('context.sessionId') == 'another-session'
    assert page.evaluate('!loadingSession')

    page.evaluate("void openHistorySession('live')")
    page.wait_for_function('running && loadingSession')
    expect(page.locator('#send')).to_be_enabled()
    page.locator('#send').click()
    assert page.evaluate('cancelledSessions') == ['live']
    page.locator('[data-sid="another-session"]').click()
    page.wait_for_function("context.sessionId === 'another-session' && !loadingSession")
    assert page.evaluate('context.sessionId') == 'another-session'
    assert not page.evaluate('running')
    expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(100)
    assert not errors, errors
    browser.close()
print('PASS 10,000-message history: pagination, switching, stop and stale replay isolation')
