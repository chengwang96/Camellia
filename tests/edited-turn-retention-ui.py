"""Accepted edit/resend releases old request-usage turns in the actual workbench."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/visualize-edit-rollback-ui.py').read_text(encoding='utf-8'))
bridge = next(ast.literal_eval(node.value) for node in tree.body
              if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'bridge' for t in node.targets))
bridge = bridge.replace("if(payload.editSeq!==3)throw Error('Expected the real edit/resend command');", '')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="edit-card-fixture"]').click()
        page.wait_for_function('requestTurns.size===1')
        page.evaluate('window.removedTurnRefs=[]')
        cdp = page.context.new_cdp_session(page)

        def measure(label):
            cdp.send('HeapProfiler.collectGarbage')
            cdp.send('HeapProfiler.collectGarbage')
            return page.evaluate('''label=>({label,requestUsageIndex:requestTurns.size,
              detachedIndexedTurns:[...requestTurns.values()].filter(node=>node&&!node.isConnected).length,
              retainedRemovedTurns:removedTurnRefs.filter(ref=>!!ref.deref()).length,
              visibleTurnCount:document.querySelectorAll('#chat .turn').length})''', label)

        measurements = [measure('baseline')]
        for batch in range(3):
            page.evaluate('''async batch=>{
              for(let i=0;i<20;i++){
                removedTurnRefs.push(new WeakRef([...chat.querySelectorAll('.turn')].at(-1)));
                beginMessageEdit([...chat.querySelectorAll('.msg-user')].at(-1));
                editingMessage.textarea.value='Edited request '+batch+':'+i;
                const pending=resendEditedMessage(editingMessage);
                const userSeq=5+2*(batch*20+i),runId=100+batch*20+i;
                acceptEdit({ok:true,userSeq,runId});await pending;
                deliverEvent({type:'assistant',session_id:'edit-card-fixture',engine:'codex',runId,
                  message:{content:[{type:'text',text:'Answer '+userSeq}]}});
                deliverEvent({type:'result',session_id:'edit-card-fixture',engine:'codex',runId,
                  subtype:'success',result:'Answer '+userSeq,userSeq,requestUsageLead:true,
                  requestUsage:{main:{input_tokens:10,output_tokens:1}}});
              }
            }''', batch)
            page.wait_for_timeout(100)
            value = measure(f'{(batch + 1) * 20} accepted edits')
            assert value['requestUsageIndex'] == 1, value
            assert value['detachedIndexedTurns'] == 0, value
            assert value['retainedRemovedTurns'] == 0, value
            assert value['visibleTurnCount'] == 2, value
            measurements.append(value)
        page.locator('#newSessionBtn').click()
        page.wait_for_function('requestTurns.size===0')
        measurements.append(measure('after leaving conversation'))
        assert not errors, errors
        print(json.dumps({'result': 'PASS', 'measurements': measurements, 'pageErrors': errors}))
    finally:
        browser.close()
