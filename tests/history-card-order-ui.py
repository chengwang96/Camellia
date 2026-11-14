"""Cards in restored history stay inside their own turn and never create a stray turn."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
bridge_node = next(node for node in fixture_tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
card = {'ok': True, 'action': 'create', 'visualize': {
    'cardId': 'history-card', 'title': 'History card', 'mode': 'card', 'style': 'whale',
    'summary': 'A card restored from saved history.', 'revision': 1}}
fixture = {
    'id': 'shared-fixture', 'title': 'Card history', 'origin': 'codex',
    'currentEngine': 'codex', 'workspaceId': None,
    'messages': [
        {'role': 'user', 'seq': 1, 'at': 1760000000000, 'text': 'Show me a card.'},
        {'role': 'assistant', 'engine': 'codex', 'seq': 2, 'at': 1760000001000,
         'text': 'First answer.', 'outputBlocks': [{'type': 'text', 'phase': 'final_answer', 'text': 'First answer.'}],
         'process': [
             {'type': 'tool', 'title': 'camellia_visualize', 'status': 'completed', 'text': json.dumps(card)},
             {'type': 'text', 'text': 'First answer.'},
         ]},
        {'role': 'user', 'seq': 3, 'at': 1760000002000, 'text': 'And another one.'},
        {'role': 'assistant', 'engine': 'codex', 'seq': 4, 'at': 1760000003000,
         'text': 'Second answer.', 'outputBlocks': [{'type': 'text', 'phase': 'final_answer', 'text': 'Second answer.'}],
         'process': [{'type': 'text', 'text': 'Second answer.'}]},
    ],
}
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
# Keep the tool output as text so the renderer must parse the card itself, the
# same way a restored Codex transcript does.
bridge += r"""(() => {
  const command = window.dshDesktop.conversationCommand;
  window.dshDesktop.onConversationEvent = fn => { window.deliver = fn; return () => {}; };
  window.dshDesktop.visualizeGet = async ({cardId}) => ({ok:true, card:{cardId, title:'History card',
    html:'<div style="height:80px">card</div>'}});
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'send') return {ok:true, sessionId:'shared-fixture', runId:9, userSeq:5};
    return command(request);
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=shared-fixture',
              wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.wait_for_function('!loadingSession && !historyOpening')

    # A card inside restored history must not create an empty live turn in the
    # middle of the transcript.
    order = page.evaluate("""() => [...document.querySelector('#chat').children]
      .map(el => el.classList.contains('msg-user') ? 'user' : el.classList.contains('turn') ? 'turn' : el.className)""")
    assert order == ['user', 'turn', 'user', 'turn'], order
    assert page.locator('#chat > .turn').count() == 2
    assert page.evaluate("""() => [...document.querySelectorAll('#chat > .turn')]
      .every(turn => turn.querySelector('.turn-body')?.childElementCount > 0)""")
    expect(page.locator('#chat > .turn').first).to_contain_text('First answer.')

    # Sending afterwards must build the reply below the new user message, not
    # inside a turn left over from history.
    page.locator('#input').fill('A new message')
    page.locator('#send').click()
    page.evaluate("""deliver({type:'gui:tool', id:'call_card', name:'camellia_visualize', status:'completed',
      output: %s, session_id:'shared-fixture', runId:9, eventSeq:1})""" % json.dumps(json.dumps(card)))
    page.evaluate("""deliver({type:'assistant', message:{id:'msg-new', content:[
      {type:'text', text:'Fresh reply.', phase:'final_answer'}]}, session_id:'shared-fixture', runId:9, eventSeq:2})""")
    page.evaluate("""deliver({type:'result', subtype:'success', result:'Fresh reply.',
      usage:{input_tokens:10, output_tokens:2, cache_read_input_tokens:0, cache_creation_input_tokens:0},
      session_id:'shared-fixture', runId:9, userSeq:5, eventSeq:3})""")
    expect(page.locator('#chat > .turn').last).to_contain_text('Fresh reply.')
    tail = page.evaluate("""() => [...document.querySelector('#chat').children].slice(-2)
      .map(el => el.classList.contains('msg-user') ? 'user' : el.classList.contains('turn') ? 'turn' : el.className)""")
    assert tail == ['user', 'turn'], tail
    assert page.evaluate("""() => [...document.querySelectorAll('#chat > .msg-user')].at(-1).innerText""").count('A new message') == 1
    assert page.locator('#chat > .turn').count() == 3
    assert not errors, errors
    browser.close()
