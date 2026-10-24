"""Conversation switches never paint partially restored history above the bottom."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

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
  window.dshDesktop.conversationCommand = async request => {
    if (request.action !== 'load-session') return command(request);
    const id = request.payload;
    if (id === 'delayed') await new Promise(resolve => { window.releaseHistory = resolve; });
    if (id === 'failed') return {ok:false,error:'Fixture history load failed'};
    const result = await command(request);
    result.messages = Array.from({length:100}, (_, index) => ({
      role:index % 2 ? 'assistant':'user', seq:index+1,
      text:id+' message '+index+'\n\n'+('A paragraph with **bold**, `code` and a [link](https://example.com).\n\n').repeat(8),
    }));
    if (id === 'live') {
      result.activity = 'running';
      result.live = {sessionId:id,engine:'codex',runId:42,startedAt:Date.now(),
        prompt:'Live prompt',messages:result.messages,eventSeq:400,
        events:Array.from({length:400}, (_, index) => ({
          type:'gui:usage',usage:{input_tokens:index+1},session_id:id,runId:42,eventSeq:index+1,
        }))};
    }
    return result;
  };
  localStorage.setItem('camellia-chat-draft:shared-fixture', JSON.stringify({text:'Unsent draft\n'.repeat(12)}));
  window.entryFrames = [];
  const record = () => {
    const scroll = document.getElementById('chatScroll'), chat = document.getElementById('chat');
    if (chat?.querySelector('.msg-user, .turn')) entryFrames.push({
      text:chat.textContent.slice(0,80), rows:chat.querySelectorAll(':scope > .msg-user, :scope > .turn').length,
      visible:chat.checkVisibility({checkVisibilityCSS:true, checkOpacity:true}),
      gap:scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop,
    });
    requestAnimationFrame(record);
  };
  requestAnimationFrame(record);
})();"""


def settled(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def assert_entry(page, session_id, rows=100):
    frames = page.evaluate('entryFrames')
    visible = [frame for frame in frames if frame['visible'] and frame['text'].startswith(session_id + ' message')]
    assert visible, (session_id, 'No visible restored history')
    invalid = [frame for frame in visible if frame['rows'] != rows or abs(frame['gap']) > 1]
    assert not invalid, (session_id, 'History painted before bottom positioning', invalid[:5])


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for width, height, theme in [(1200, 820, 'light'), (480, 820, 'dark')]:
        page = browser.new_page(viewport={'width':width, 'height':height}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.context.new_cdp_session(page).send('Emulation.setCPUThrottlingRate', {'rate':4})
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        settled(page)
        assert_entry(page, 'shared-fixture')

        for session_id, rows in [('another-session',100), ('shared-fixture',100), ('live',102)]:
            page.evaluate("() => { document.getElementById('chatScroll').scrollTop = 300; entryFrames.length = 0; }")
            assert page.evaluate('(id) => openHistorySession(id)', session_id)
            settled(page)
            assert_entry(page, session_id, rows)

        # A stale request cannot reveal a new conversation while it is restoring.
        page.evaluate("() => { entryFrames.length = 0; void openHistorySession('delayed'); }")
        page.wait_for_function('typeof releaseHistory === "function"')
        page.evaluate("void openHistorySession('another-session')")
        page.wait_for_function("context.sessionId === 'another-session' && !loadingSession")
        page.evaluate('releaseHistory()')
        settled(page)
        assert_entry(page, 'another-session')

        assert not page.evaluate("openHistorySession('failed')")
        settled(page)
        assert page.locator('#chatScroll').is_visible()

        # Navigating away just before presentation cancels the pending result
        # and clears the loading style on the new-session screen.
        result = page.evaluate("""async () => {
          const opening = openHistorySession('shared-fixture');
          await new Promise(resolve => {
            const ready = () => {
              if (document.querySelectorAll('#chat > .msg-user, #chat > .turn').length === 100) resolve();
              else requestAnimationFrame(ready);
            };
            requestAnimationFrame(ready);
          });
          const location = readUi('location');
          const draft = newSession(null);
          const result = await opening;
          await draft;
          return {result, location};
        }""")
        assert result['result'] is False
        assert result['location']['sessionId'] == 'shared-fixture'
        settled(page)
        assert page.locator('#emptyState').is_visible()
        assert page.evaluate('newSession(null)') is None
        settled(page)
        assert page.locator('#emptyState').is_visible()

        # Hidden or minimized native windows can stop delivering animation
        # frames. Restoring history must still finish and reveal a usable view.
        assert page.evaluate("""async () => {
          const frame = window.requestAnimationFrame;
          window.requestAnimationFrame = () => 0;
          let timeout;
          try {
            return await Promise.race([
              openHistorySession('background-session'),
              new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('History waited indefinitely for an animation frame')), 5000);
              }),
            ]);
          } finally {
            clearTimeout(timeout);
            window.requestAnimationFrame = frame;
          }
        }""")
        assert page.evaluate('!loadingSession && !historyOpening')
        assert page.locator('#chatScroll').is_visible()
        assert abs(page.evaluate('chatScroll.scrollHeight-chatScroll.clientHeight-chatScroll.scrollTop')) <= 1
        page.close()

    assert not errors, errors
    browser.close()
print('PASS: history opens complete and at the bottom, including live, superseded and unavailable-frame loads')
