"""A deleted card must render a placeholder, never a load error, on reload."""
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
        page.set_content('<html><head><style>' + host_css + '</style><style>' + theme + '</style></head>'
                         '<body style="margin:0"><div style="width:900px"><div id="host"></div></div></body></html>')
        page.add_script_tag(content=bridge)
        page.evaluate(
            """() => {
              window.dshDesktop = {
                visualizeGet: async () => ({ ok: true, deleted: true, card: null }),
                visualizeState: async () => ({ ok: true }),
              };
              const card = CamelliaVisualize.mount({ cardId: 'gone', title: 'Gone', mode: 'card' },
                { sessionId: 's' });
              document.querySelector('#host').append(card);
            }""")
        page.wait_for_timeout(1200)
        state = page.evaluate("""() => {
          const block = document.querySelector('.visualize-block');
          return { error: block.querySelector('.visualize-error')?.textContent || null,
                   deleted: block.classList.contains('is-deleted'),
                   text: block.querySelector('.visualize-deleted')?.textContent || '',
                   iframe: !!block.querySelector('iframe'),
                   actions: block.querySelectorAll('.visualize-actions').length };
        }""")
        assert state['error'] is None, state
        assert state['deleted'] is True, state
        assert state['text'].strip(), state
        assert state['iframe'] is False, state
        assert state['actions'] == 0, state
        assert not errors, errors
        print('PASS: a deleted card renders a placeholder instead of a load error')
    finally:
        browser.close()
