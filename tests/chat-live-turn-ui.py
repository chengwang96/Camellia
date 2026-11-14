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
  window.dshDesktop.onConversationEvent = fn => { window.deliver = fn; return () => {}; };
  const tools = Array.from({length: 4}, (_, index) => [
    {type:'gui:tool',id:'call_'+index,name:'commandExecution',input:{command:'pwsh -Command Check '+index},
     status:'in_progress',session_id:'shared-fixture',runId:7,eventSeq:index*2+1},
    {type:'gui:tool',id:'call_'+index,name:'commandExecution',status:'completed',output:'done '+index,
     session_id:'shared-fixture',runId:7,eventSeq:index*2+2},
  ]).flat();
  window.dshDesktop.conversationCommand = async request => {
    if (request.action !== 'load-session') return command(request);
    const result = await command(request);
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

    # A native session id in an init event must not replace the conversation
    # the view is showing, or every following event is dropped as foreign.
    before = page.locator('.tool-card').count()
    page.evaluate("deliver({type:'system',subtype:'init',session_id:'native-9',runId:7,eventSeq:90})")
    page.evaluate("deliver({type:'gui:tool',id:'call_after_init',name:'commandExecution',status:'completed',"
                  "output:'ok',session_id:'shared-fixture',runId:7,eventSeq:91})")
    expect(page.locator('.tool-card')).to_have_count(before + 1)

    # Even a snapshot without events must leave a visible in-progress turn.
    page.evaluate("window.liveEvents = 'empty'")
    page.evaluate("openHistorySession('shared-fixture')")
    expect(page.locator('.run-status')).to_be_visible()
    assert page.locator('.tool-card').count() == 0
    assert not errors, errors
    browser.close()
