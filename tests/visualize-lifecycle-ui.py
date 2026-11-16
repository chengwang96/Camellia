"""Detached cards release resources; layout moves preserve state and controls."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('<main id="chat"></main><aside id="other"></aside>')
        page.add_script_tag(path=str(repo / 'src/renderer/chat/visualize-card.js'))
        page.evaluate('''() => {
          window.disposals=0; window.serial=0; window.refs=[]; window.saves=[];
          window.dshDesktop={
            visualizeGet:async ({cardId})=>({ok:true,card:{cardId,title:'Fixture',
              html:'<button id="control">Change</button>',state:{value:0}}}),
            visualizeState:async request=>{saves.push(request);return {ok:true};}
          };
          window.mountFixture=()=>{
            const card=CamelliaVisualize.mount({cardId:'card-'+(++serial),title:'Fixture'},
              {sessionId:'fixture'});
            const dispose=card.disposeVisualize;
            let disposed=false;
            card.disposeVisualize=()=>{if(!disposed){disposed=true;disposals++;}dispose();};
            refs.push(new WeakRef(card)); document.querySelector('#chat').append(card);
          };
          mountFixture();
        }''')
        page.frame_locator('iframe').locator('#control').wait_for()

        # Moving a card during process layout must not dispose it, and the
        # frame bridge must still accept state changes after the move.
        page.evaluate('''() => {
          const card=document.querySelector('.visualize-block');
          card.remove();document.querySelector('#other').append(card);
        }''')
        page.wait_for_timeout(80)
        assert page.evaluate('disposals') == 0
        page.frame_locator('iframe').locator('#control').wait_for()
        page.frame_locator('iframe').locator('#control').evaluate(
            '() => camelliaVisualize.state.set({value:7})')
        page.wait_for_function("document.querySelector('.visualize-block').getVisualizeState().value===7")
        # Simulate replacing a conversation containing an ancestor wrapper.
        page.evaluate("document.querySelector('#other').replaceChildren()")
        page.wait_for_function('disposals===1 && saves.some(row=>row.state?.value===7)')

        # Mount and replace chat content repeatedly. No test-side registry
        # retains cards; WeakRef plus CDP GC establishes collectability.
        cdp = page.context.new_cdp_session(page)
        cdp.send('HeapProfiler.collectGarbage')
        baseline = cdp.send('Memory.getDOMCounters')
        for iteration in range(30):
            page.evaluate('mountFixture()')
            page.wait_for_function("!!document.querySelector('.visualize-frame')")
            page.evaluate("document.querySelector('#chat').replaceChildren()")
            page.wait_for_function(f'disposals==={iteration + 2}')
        cdp.send('HeapProfiler.collectGarbage')
        cdp.send('HeapProfiler.collectGarbage')
        assert page.evaluate('refs.filter(ref=>!!ref.deref()).length') == 0
        after = cdp.send('Memory.getDOMCounters')
        assert after['jsEventListeners'] <= baseline['jsEventListeners'] + 2, (baseline, after)

        # A removed card with an outstanding load must not create a frame or
        # re-register resources when its IPC request eventually resolves.
        page.evaluate('''() => {
          dshDesktop.visualizeGet=()=>new Promise(resolve=>{window.releaseLoad=resolve;});
          mountFixture();document.querySelector('#chat').replaceChildren();
        }''')
        page.wait_for_function('disposals===32')
        page.evaluate("releaseLoad({ok:true,card:{html:'<p>Late</p>'}})")
        page.wait_for_timeout(80)
        assert page.locator('iframe').count() == 0
        assert not errors, errors
        print(json.dumps({'result': 'PASS', 'baseline': baseline, 'after30Replacements': after,
                          'retainedRemovedCards': 0, 'pendingStateFlushed': True,
                          'sameDocumentReparentPreserved': True, 'lateLoadIgnored': True}))
    finally:
        browser.close()
