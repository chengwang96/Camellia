"""Deleting a card from its menu leaves a placeholder and frees the slot."""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
bridge = (repo / 'src/renderer/chat/visualize-card.js').read_text(encoding='utf-8')
theme = (repo / 'src/renderer/shared/ui-theme.css').read_text(encoding='utf-8')
host_css = (repo / 'src/renderer/chat/visualize-card.css').read_text(encoding='utf-8')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1200, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(
            '<html><head><style>' + host_css + '</style><style>' + theme + '</style></head>'
            '<body style="margin:0"><div style="width:900px"><div id="host"></div></div></body></html>')
        page.add_script_tag(content=bridge)
        page.evaluate(
            """() => {
              window.removed = [];
              window.confirm = () => true;
              window.dshDesktop = {
                visualizeGet: async ({ cardId }) => ({ ok: true, card: { cardId, title: 'Card', mode: 'card',
                  style: 'paper', html: '<div>content</div>', state: {} }}),
                visualizeState: async () => ({ ok: true }),
                visualizeRemove: async ({ cardId }) => { removed.push(cardId); return { ok: true, cardId }; },
              };
              const card = CamelliaVisualize.mount({ cardId: 'card-1', title: 'Card', mode: 'card' },
                { sessionId: 's' });
              document.querySelector('#host').append(card);
            }""")
        page.wait_for_timeout(900)
        assert page.locator('.visualize-delete').count() == 1
        page.locator('.visualize-more summary').click()
        page.locator('[data-card-action="delete"]').click()
        page.wait_for_timeout(600)
        assert page.evaluate('removed') == ['card-1']
        assert page.locator('.visualize-block.is-deleted').count() == 1
        assert page.locator('.visualize-block iframe').count() == 0
        assert page.locator('.visualize-deleted').inner_text().strip() != ''
        assert page.locator('.visualize-actions').count() == 0
        assert not errors, errors
        print('PASS: deleting a card removes its frame and shows a placeholder')
    finally:
        browser.close()
