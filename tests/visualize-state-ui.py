"""Card state survives returning a control to its saved value during a save."""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_content('<div id="cards"></div>')
    page.add_script_tag(path=str(repo / 'src/renderer/chat/visualize-card.js'))
    page.evaluate("""() => {
      window.saves = [];
      window.stateMessages = 0;
      window.addEventListener('message', event => {
        if (event.data?.type === 'camellia-visualize-state') stateMessages++;
      });
      window.dshDesktop = {
        visualizeGet: async () => ({ok:true, card:{cardId:'state-test', title:'State',
          html:'<button>Control</button>', state:{value:0}}}),
        visualizeState: async request => {
          saves.push(request.state);
          if (window.holdSave) await new Promise(resolve => { window.releaseSave = resolve; });
          return {ok:true};
        },
      };
      window.card = CamelliaVisualize.mount({cardId:'state-test', title:'State'}, {sessionId:'test'});
      document.querySelector('#cards').append(card);
    }""")
    frame = page.frame_locator('iframe')
    frame.locator('button').wait_for()
    control = frame.locator('button')

    # Both state messages arrive before the debounce flush. Returning to the
    # saved value must replace the pending intermediate state.
    control.evaluate("""() => {
      camelliaVisualize.state.set({value:1});
      camelliaVisualize.state.set({value:0});
    }""")
    page.wait_for_function('stateMessages === 2')
    assert page.evaluate('card.getVisualizeState().value') == 0
    page.evaluate('card.flushVisualizeState()')
    assert page.evaluate('saves.at(-1).value') == 0

    # A previously saved value still needs a new write when a different value
    # is already being persisted, or the older request would win on disk.
    page.evaluate('window.holdSave = true')
    control.evaluate('camelliaVisualize.state.set({value:2})')
    page.wait_for_function('stateMessages === 3')
    page.evaluate('void card.flushVisualizeState()')
    page.wait_for_function('typeof releaseSave === "function"')
    control.evaluate('camelliaVisualize.state.set({value:0})')
    page.wait_for_function('stateMessages === 4')
    assert page.evaluate('card.getVisualizeState().value') == 0
    page.evaluate('window.holdSave = false; releaseSave()')
    page.evaluate('card.flushVisualizeState()')
    assert page.evaluate('saves.at(-1).value') == 0
    assert not errors, errors
    page.evaluate('card.disposeVisualize()')
    browser.close()
    print('PASS: latest card state wins during debounce and in-flight saves')
