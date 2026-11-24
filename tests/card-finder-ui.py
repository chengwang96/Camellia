"""The card finder filters by title/summary and reveals the chosen card."""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(
            '<html><head></head><body style="margin:0">'
            '<button id="toggle" aria-expanded="false"></button>'
            '<div id="panel" hidden><input id="input"><span id="status"></span>'
            '<div id="list"></div><button id="cardFinderClose">x</button></div>'
            '<div id="cards"></div></body></html>')
        page.add_script_tag(path=str(repo / 'src/renderer/chat/card-finder.js'))
        page.evaluate(
            """() => {
              const cards = [
                { cardId: 'a', title: 'Wave basics', summary: 'wavelength and period', revision: 3 },
                { cardId: 'b', title: 'Element delay', summary: '128 channels', revision: 1 },
                { cardId: 'c', title: 'Hardware model', summary: 'printable parts', revision: 2 },
              ];
              window.opened = [];
              window.dshDesktop = { visualizeList: async () => ({ ok: true, cards }) };
              window.finder = CamelliaCardFinder.mount({
                button: document.querySelector('#toggle'),
                panel: document.querySelector('#panel'),
                input: document.querySelector('#input'),
                status: document.querySelector('#status'),
                list: document.querySelector('#list'),
                getSessionId: () => 'session-1',
                onOpen: card => opened.push(card.cardId),
              });
            }""")
        page.click('#toggle')
        page.wait_for_selector('.card-finder-row')
        assert page.locator('.card-finder-row').count() == 3
        page.fill('#input', 'delay')
        assert page.locator('.card-finder-row').count() == 1
        assert 'Element delay' in page.locator('.card-finder-row strong').inner_text()
        page.fill('#input', '128')
        assert page.locator('.card-finder-row').count() == 1
        page.fill('#input', 'zzz')
        assert page.locator('.card-finder-row').count() == 0
        assert 'No card matches' in page.locator('#status').inner_text()
        page.fill('#input', 'wave')
        page.locator('.card-finder-row').first.click()
        assert page.evaluate('opened') == ['a']
        assert page.locator('#panel').is_hidden()
        assert not errors, errors
        print('PASS: card finder filters and opens the chosen card')
    finally:
        browser.close()
