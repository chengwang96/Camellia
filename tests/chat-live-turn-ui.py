"""A restored live run keeps its status row and execution process in the transcript."""
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
# Codex runs carry tool calls only: no assistant snapshots recreate the turn, so
# a live restore must attach the status row and process itself.
bridge += r"""(() => {
  const command = window.dshDesktop.conversationCommand;
  window.watchedConversations = [];
  window.rendererDiagnostics = [];
  window.dshDesktop.watchConversation = async scope => { watchedConversations.push(scope); return {ok:true}; };
  window.dshDesktop.onConversationEvent = fn => { window.deliver = fn; return () => {}; };
  const tools = Array.from({length: 4}, (_, index) => [
    {type:'gui:tool',id:'call_'+index,name:'commandExecution',input:{command:'pwsh -Command Check '+index},
     status:'in_progress',session_id:'shared-fixture',runId:7,eventSeq:index*2+1},
    {type:'gui:tool',id:'call_'+index,name:'commandExecution',status:'completed',output:'done '+index,
     session_id:'shared-fixture',runId:7,eventSeq:index*2+2},
  ]).flat();
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'diagnostic') rendererDiagnostics.push(request.payload.message);
    if (request.action !== 'load-session') return command(request);
    const result = await command(request);
    if (request.payload !== 'shared-fixture') return result;
    result.activity = 'running';
    result.live = {sessionId:'shared-fixture',engine:'codex',runId:7,startedAt:Date.now()-120000,
      prompt:'Live prompt',displayText:'Live prompt',userSeq:3,attachments:[],
      messages:result.messages,events:window.liveEvents === 'empty' ? [] : tools,
      eventSeq:tools.length};
    return result;
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('.run-status')).to_be_visible()
    expect(page.locator('.run-status .run-text')).to_contain_text('Working')
    assert page.locator('.tool-card').count() == 4, page.locator('.tool-card').count()
    expect(page.locator('.execution-process')).to_be_visible()
    expect(page.locator('.msg-user').last).to_contain_text('Live prompt')
    assert page.evaluate('watchedConversations.at(-1).sessionId') == 'shared-fixture'

    # Queued output from several background sessions is normal. It must not
    # create tools or diagnostics in the current run, even when ids alternate.
    diagnostics_before = page.evaluate('rendererDiagnostics.length')
    page.evaluate("""() => {
      for (let i = 0; i < 100; i++) deliver({type:'gui:tool',id:'background_'+i,
        name:'commandExecution',status:'completed',session_id:'background_'+(i%3),runId:7});
    }""")
    assert page.evaluate('rendererDiagnostics.length') == diagnostics_before
    assert page.locator('.tool-card').count() == 4

    # A native session id in an init event must not replace the conversation
    # the view is showing, or every following event is dropped as foreign.
    before = page.locator('.tool-card').count()
    page.evaluate("deliver({type:'system',subtype:'init',session_id:'native-9',runId:7,eventSeq:90})")
    page.evaluate("deliver({type:'gui:tool',id:'call_after_init',name:'commandExecution',status:'completed',"
                  "output:'ok',session_id:'shared-fixture',runId:7,eventSeq:91})")
    expect(page.locator('.tool-card')).to_have_count(before + 1)

    page.locator('[data-sid="another-session"]').click()
    page.wait_for_function("watchedConversations.at(-1).sessionId === 'another-session'")
    page.locator('[data-sid="shared-fixture"]').click()
    page.wait_for_function("!loadingSession && watchedConversations.at(-1).sessionId === 'shared-fixture'")

    # Even a snapshot without events must leave a visible in-progress turn.
    page.evaluate("window.liveEvents = 'empty'")
    page.evaluate("openHistorySession('shared-fixture')")
    expect(page.locator('.run-status')).to_be_visible()
    assert page.locator('.tool-card').count() == 0
    page.evaluate('newSession()')
    assert page.evaluate('watchedConversations.at(-1)') == {'sessionId': None, 'pending': False}

    # New sends have no conversation id until main returns. Preserve output
    # emitted during that interval, then narrow the subscription to the id.
    page.evaluate("""() => {
      const command = dshDesktop.conversationCommand;
      dshDesktop.conversationCommand = request => ['send','goal-start'].includes(request.action)
        ? new Promise(resolve => { window.completeSend = resolve; }) : command(request);
    }""")
    page.locator('#input').fill('Start a new conversation')
    page.locator('#send').click()
    page.wait_for_function('window.completeSend && watchedConversations.at(-1).pending')
    page.evaluate("deliver({type:'gui:tool',id:'early_tool',name:'commandExecution',status:'completed',"
                  "output:'early output retained',session_id:'created-session',runId:8})")
    page.evaluate("completeSend({ok:true,sessionId:'created-session',runId:8,userSeq:1}); window.completeSend = null")
    page.wait_for_function("!sending && context.sessionId === 'created-session'")
    expect(page.locator('.tool-card')).to_have_count(1)
    assert page.evaluate('watchedConversations.at(-1)') == {'sessionId': 'created-session', 'pending': False}

    # Failed starts return to the empty-view subscription, including Goals.
    page.evaluate('newSession()')
    page.locator('#input').fill('This start will fail')
    page.locator('#send').click()
    page.wait_for_function('window.completeSend && watchedConversations.at(-1).pending')
    page.evaluate("completeSend({ok:false,error:'Fixture failure'}); window.completeSend = null")
    page.wait_for_function('!sending && !watchedConversations.at(-1).pending')
    assert page.evaluate('watchedConversations.at(-1).sessionId') is None

    page.evaluate('newSession(); goalUI.reveal()')
    page.locator('#input').fill('A new Goal conversation')
    page.locator('#send').click()
    page.wait_for_function('window.completeSend && watchedConversations.at(-1).pending')
    page.evaluate("completeSend({ok:false,error:'Fixture goal failure'}); window.completeSend = null")
    page.wait_for_function('!watchedConversations.at(-1).pending')
    assert page.evaluate('watchedConversations.at(-1).sessionId') is None
    page.locator('#input').fill('A new Goal conversation')
    page.locator('#send').click()
    page.wait_for_function('window.completeSend && watchedConversations.at(-1).pending')
    page.evaluate("""completeSend({ok:true,sessionId:'goal-session',goal:{id:'new-goal',
      sessionId:'goal-session',objective:'A new Goal conversation',phase:'active',armed:true,
      elapsedMs:0,activeSince:Date.now()}}); window.completeSend = null""")
    page.wait_for_function("context.sessionId === 'goal-session' && !watchedConversations.at(-1).pending")
    assert not errors, errors
    browser.close()
