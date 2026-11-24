"""Slide decks must size their frame from the column, not from a stale height.

Two regressions are covered:

1. A deck's own reported height is its frame height (the deck fills the
   iframe viewport), so trusting it made the height self-locking: cards first
   painted in a tall frame stayed tall, and cards first painted narrow stayed
   short. Identical decks ended up with different heights.
2. The height was only recomputed at mount, so a card painted narrow and then
   widened kept its old height (and its letterbox bars).
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

deck = """<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0d1117}
body{display:flex;align-items:center;justify-content:center}
.deck{width:1280px;height:720px;background:#fffdf8;flex:0 0 auto;transform-origin:center center}
@media(max-width:700px){body{display:block}.deck{width:100%;height:auto;transform:none}}
</style>
<div class="deck" data-viz-presentation="slides"><h1>Slide</h1><p style="height:900px">Tall body</p></div>
<script>
(function(){
  var deck=document.querySelector('.deck');
  function fit(){
    var scale=Math.min(window.innerWidth/1280,window.innerHeight/720);
    deck.style.transform=window.innerWidth<700?'none':'scale('+scale+')';
    document.body.style.height=window.innerHeight+'px';
  }
  window.addEventListener('resize',fit);
  fit();
})();
</script>"""

bridge = (repo / 'src/renderer/chat/visualize-card.js').read_text(encoding='utf-8')
theme = (repo / 'src/renderer/shared/ui-theme.css').read_text(encoding='utf-8')
host_css = (repo / 'src/renderer/chat/visualize-card.css').read_text(encoding='utf-8')


def mount(page, fragment, column):
    page.set_content(
        '<html><head><style>' + host_css + '</style><style>' + theme + '</style></head>'
        '<body style="margin:0"><div id="turn" style="width:' + str(column) + 'px">'
        '<div id="host"></div></div></body></html>')
    page.add_script_tag(content=bridge)
    page.evaluate(
        """([fragment]) => {
          window.dshDesktop = {
            visualizeGet: async ({ cardId }) => ({ ok: true, card: { cardId, title: 'Deck', mode: 'wide',
              style: 'paper', html: fragment, state: {} }}),
            visualizeState: async () => ({ ok: true }),
          };
          const card = CamelliaVisualize.mount({ cardId: 'deck', title: 'Deck', mode: 'wide' },
            { sessionId: 'deck' });
          document.querySelector('#host').append(card);
        }""", [fragment])
    page.wait_for_timeout(1400)
    return page.evaluate("""() => {
      const block = document.querySelector('.visualize-block');
      const frame = block.querySelector('iframe');
      return { width: Math.round(frame.getBoundingClientRect().width),
               height: Math.round(frame.getBoundingClientRect().height) };
    }""")


def bars(page):
    return page.frames[-1].evaluate("""() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      return [Math.round(deck.top), Math.round(window.innerHeight - deck.bottom)];
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        # Same column, different history: every card gets the same 16:9 height.
        first = mount(page, deck, 766)
        again = mount(page, deck, 766)
        assert first == again, (first, again)
        assert abs(first['height'] - round(first['width'] * 9 / 16)) <= 2, first
        for edge in bars(page):
            assert abs(edge) <= 5, bars(page)

        # Widening after the first paint must grow the frame and drop the bars.
        page.evaluate("document.querySelector('#turn').style.width='1000px'")
        page.wait_for_timeout(900)
        grown = page.evaluate("""() => {
          const frame = document.querySelector('iframe');
          return { width: Math.round(frame.getBoundingClientRect().width),
                   height: Math.round(frame.getBoundingClientRect().height) };
        }""")
        assert grown['width'] > first['width'] + 100, (first, grown)
        assert abs(grown['height'] - round(grown['width'] * 9 / 16)) <= 2, grown
        for edge in bars(page):
            assert abs(edge) <= 5, bars(page)

        assert not errors, errors
        print('PASS: deck frames follow the column width and keep a 16:9 body')
    finally:
        browser.close()
