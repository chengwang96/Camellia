"""The card finder can reveal a current card or preview a saved revision."""
from pathlib import Path
import re
from playwright.sync_api import expect, sync_playwright

repo = Path(__file__).resolve().parents[1]
chat = repo / 'src/renderer/chat'
workbench = (chat / 'workbench.html').read_text(encoding='utf-8')
finder_markup = re.search(r'<aside id="cardFinder".*?</aside>', workbench, re.S).group()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(
            '<html><head></head><body style="margin:0"><main class="main" style="position:relative;height:100vh">'
            '<button id="toggle" aria-expanded="false"></button>'
            '<aside id="peer" class="work-panel is-open"></aside>'
            + finder_markup + '</main></body></html>')
        page.add_style_tag(path=str(chat / 'workbench.css'))
        page.add_style_tag(path=str(chat / 'visualize-card.css'))
        page.add_script_tag(path=str(chat / 'panel-motion.js'))
        page.add_script_tag(path=str(chat / 'visualize-card.js'))
        page.add_script_tag(path=str(chat / 'card-finder.js'))
        page.evaluate(
            """() => {
              const cards = [
                { cardId: 'a', title: 'Wave basics', summary: 'wavelength and period', revision: 3, createdAt: 1000, updatedAt: 2000,
                  revisions: [{ cardId: 'a', title: 'Wave basics', summary: 'early demonstration', revision: 2, updatedAt: 1700 }] },
                { cardId: 'b', title: 'Element delay', summary: '128 channels after the v2 test', revision: 1 },
                { cardId: 'c', title: 'Hardware model', summary: 'printable parts', revision: 2 },
                { cardId: 'd', title: 'Wave basics', summary: 'second copy', revision: 1, createdAt: 3000, updatedAt: 4000 },
                ...Array.from({length: 56}, (_, i) => ({ cardId: 'extra-' + i, title: 'Extra card' })),
              ];
              window.opened = [];
              window.dshDesktop = {
                visualizeList: async ({ includeRevisions }) => ({
                  ok: true, cards: includeRevisions ? cards : cards.map(({ revisions, ...card }) => card),
                }),
                visualizeGet: async (request) => {
                  window.requestedRevision = request;
                  return { ok: true, card: { ...request, layoutVersion: 2, html: '<h1>Archived card</h1>' } };
                },
              };
              window.finder = CamelliaCardFinder.mount({
                button: document.querySelector('#toggle'),
                panel: document.querySelector('#cardFinder'),
                input: document.querySelector('#cardFinderInput'),
                status: document.querySelector('#cardFinderStatus'),
                list: document.querySelector('#cardFinderList'),
                getSessionId: () => 'session-1',
                onOpen: card => {
                  if (card.historical) void CamelliaVisualize.previewRevision(card, 'session-1');
                  else opened.push(card.cardId);
                },
              });
            }""")
        page.click('#toggle')
        page.wait_for_selector('.card-finder-row')
        expect(page.locator('#cardFinderInput')).to_be_focused()
        assert page.locator('.main').evaluate("(el) => el.classList.contains('has-card-finder')")
        for width in (1200, 540):
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.locator('#cardFinder').evaluate('(el) => el.offsetWidth') == page.locator('#peer').evaluate('(el) => el.offsetWidth')
        assert page.locator('.card-finder-row').count() == 60
        expect(page.locator('.card-finder-row.is-version')).to_have_count(0)
        versions = page.get_by_role('button', name='Version history for Wave basics')
        expect(versions).to_have_attribute('aria-expanded', 'false')
        versions.click()
        expect(versions).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('.is-historical .card-finder-row')).to_have_attribute('data-revision', '2')
        expect(page.locator('.card-finder-row.is-version strong')).to_have_text('v2')
        versions.click()
        expect(page.locator('.is-historical .card-finder-row')).to_have_count(0)
        page.fill('#cardFinderInput', 'delay')
        assert page.locator('.card-finder-row').count() == 1
        assert 'Element delay' in page.locator('.card-finder-row strong').inner_text()
        page.fill('#cardFinderInput', '128')
        assert page.locator('.card-finder-row').count() == 1
        expect(page.locator('.card-finder-row')).not_to_contain_text('128 channels')
        page.fill('#cardFinderInput', 'zzz')
        assert page.locator('.card-finder-row').count() == 0
        assert 'No card matches' in page.locator('#cardFinderStatus').inner_text()
        page.fill('#cardFinderInput', 'wave')
        rows = page.locator('.card-finder-row')
        assert rows.count() == 3
        expect(page.locator('#cardFinderStatus')).to_be_hidden()
        assert rows.first.get_attribute('data-card-id') == 'd'
        assert 'Created' in rows.first.locator('span').inner_text()
        assert 'v3' in rows.nth(1).locator('span').inner_text()
        page.locator('#cardFinderInput').press('ArrowDown')
        page.locator('#cardFinderInput').press('Enter')
        assert page.evaluate('opened') == ['a']
        expect(page.locator('#cardFinder')).to_be_hidden()
        page.click('#toggle')
        page.fill('#cardFinderInput', 'v2')
        assert rows.count() == 2
        page.locator('#cardFinderInput').press('Enter')
        expect(page.locator('.visualize-revision-dialog')).to_be_visible()
        expect(page.frame_locator('.visualize-revision-dialog iframe').locator('h1')).to_have_text('Archived card')
        assert page.evaluate('requestedRevision') == {'cardId': 'a', 'revision': 2, 'sessionId': 'session-1'}
        assert page.evaluate('opened') == ['a']
        page.get_by_role('button', name='Close', exact=True).click()
        expect(page.locator('.visualize-revision-dialog')).to_have_count(0)
        page.click('#toggle')
        expect(page.locator('#cardFinder')).to_have_class('work-panel card-finder is-open')
        page.evaluate("window.dispatchEvent(new CustomEvent('camellia:panel-open', {detail:{name:'review'}}))")
        expect(page.locator('#cardFinder')).to_be_hidden()
        assert not page.locator('.main').evaluate("(el) => el.classList.contains('has-card-finder')")
        page.click('#toggle')
        expect(page.locator('#cardFinderInput')).to_be_focused()
        page.keyboard.press('Escape')
        expect(page.locator('#toggle')).to_be_focused()
        assert not errors, errors
        print('PASS: card finder filters and opens the chosen card')
    finally:
        browser.close()
