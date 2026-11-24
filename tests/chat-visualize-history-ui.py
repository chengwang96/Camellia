"""Large historical turns keep their PPT cards visible without opening process details."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)

card_id = '11111111-1111-4111-8111-111111111111'
# Codex stores tool results with the payload nested inside an escaped string,
# exactly as it appears in a real transcript.
tool_output = json.dumps({'content': [{'type': 'text', 'text': json.dumps({
    'ok': True,
    'action': 'create',
    'visualize': {
        'cardId': card_id,
        'title': 'PPT card',
        'mode': 'wide',
        'style': 'paper',
        'summary': 'Slides survive history reload.',
        'revision': 1,
    },
})}], 'structuredContent': None, '_meta': None})
process = [
    {'type': 'tool', 'title': 'commandExecution', 'input': {'command': f'check {index}'},
     'text': f'output {index}', 'status': 'completed'}
    for index in range(12)
]
process.append({
    'type': 'tool',
    'title': 'camellia_visualize',
    'input': {'action': 'create'},
    'text': tool_output,
    'status': 'completed',
})
messages = [
    {'role': 'user', 'seq': 1, 'text': 'Build the PPT cards'},
    {
        'role': 'assistant',
        'engine': 'codex',
        'seq': 2,
        'userSeq': 1,
        'text': 'The PPT card is ready.',
        'process': process,
        'outputBlocks': [{'phase': 'final_answer', 'text': 'The PPT card is ready.'}],
    },
]

fixture = dict(scope['fixture'])
fixture['messages'] = messages
bridge = scope['bridge'].replace(json.dumps(scope['fixture']), json.dumps(fixture))
bridge = bridge.replace(
    "previewFile:async()=>({ok:false,error:'fixture'}),",
    "previewFile:async()=>({ok:false,error:'fixture'}),"
    'visualizeGet:async({cardId})=>({ok:true,card:{cardId,title:"PPT card",mode:"wide",style:"paper",'
    'html:"<div class=\\"slide\\">Slide one</div>",state:{}}}),'
    'visualizeState:async()=>({ok:true}),',
)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1100, 'height': 800})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex',
                  wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()

        turn = page.locator('.turn').last
        expect(turn.locator('.execution-process')).not_to_have_attribute('open', '')
        expect(turn.locator('.visualize-block')).to_be_visible()
        expect(turn.locator('.visualize-block .visualize-title')).to_have_text('PPT card')
        expect(turn.locator('.visualize-block iframe')).to_have_count(1)
        expect(turn.locator('.visualize-block iframe')).to_be_visible()

        page.locator('[data-sid="another-session"]').click()
        page.locator('[data-sid="shared-fixture"]').click()
        turn = page.locator('.turn').last
        expect(turn.locator('.execution-process')).not_to_have_attribute('open', '')
        expect(turn.locator('.visualize-block')).to_be_visible()
        expect(turn.locator('.visualize-block iframe')).to_have_count(1)
        assert not errors, errors
    finally:
        browser.close()

print('PASS: PPT cards stay visible after switching away from a large historical turn')
