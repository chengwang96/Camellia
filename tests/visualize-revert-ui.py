"""The stale-card banner's restore button must call the revert endpoint."""
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
              window.reverted = [];
              window.loads = 0;
              window.dshDesktop = {
                visualizeGet: async ({ cardId }) => {
                  loads += 1;
                  return { ok: true, card: { cardId, title: 'Edited', mode: 'card', style: 'paper',
                    html: '<div>content</div>', state: {},
                    externalEdit: loads === 1 } };
                },
                visualizeState: async () => ({ ok: true }),
                visualizeRevert: async ({ cardId }) => { reverted.push(cardId); return { ok: true }; },
              };
              const card = CamelliaVisualize.mount({ cardId: 'card-1', title: 'Edited', mode: 'card' },
                { sessionId: 's' });
              document.querySelector('#host').append(card);
            }""")
        page.wait_for_timeout(900)
        banner = page.locator('.visualize-stale')
        assert banner.is_visible(), 'stale banner must show for an externally edited card'
        page.locator('.visualize-revert').click()
        page.wait_for_timeout(700)
        assert page.evaluate('reverted') == ['card-1'], page.evaluate('reverted')
        assert page.evaluate('loads') >= 2, page.evaluate('loads')
        assert page.locator('.visualize-stale').is_hidden(), 'banner clears after restore'
        assert not errors, errors
        print('PASS: restore button reverts an externally edited card')
    finally:
        browser.close()
