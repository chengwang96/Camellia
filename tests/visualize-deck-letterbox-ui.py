"""A 16:9 slide deck must not get black letterbox bars in the chat column.

The frame used to be a fixed 560px tall, while a 1280x720 deck scaled to the
column width only painted ~430px of that. The remaining space showed the
iframe backdrop, i.e. bars above and below the slide.
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
<div class="deck" data-viz-presentation="slides"><h1>Slide</h1></div>
<script>
(function(){
  var deck=document.querySelector('.deck');
  function fit(){
    var scale=Math.min(window.innerWidth/1280,window.innerHeight/720);
    deck.style.transform='scale('+scale+')';
    document.body.style.height=window.innerHeight+'px';
  }
  window.addEventListener('resize',fit);
  fit();
  window.dispatchEvent(new Event('resize'));
})();
</script>"""

bridge = (repo / 'src/renderer/chat/visualize-card.js').read_text(encoding='utf-8')
theme = (repo / 'src/renderer/shared/ui-theme.css').read_text(encoding='utf-8')
host_css = (repo / 'src/renderer/chat/visualize-card.css').read_text(encoding='utf-8')


def mount(page, fragment, column):
    page.set_content(
        '<html><head><style>' + host_css + '</style><style>' + theme + '</style></head>'
        '<body style="margin:0"><div style="width:' + str(column) + 'px">'
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
    page.wait_for_timeout(1500)
    frame_height = page.evaluate("Math.round(document.querySelector('iframe').getBoundingClientRect().height)")
    frame_width = page.evaluate("Math.round(document.querySelector('iframe').getBoundingClientRect().width)")
    inside = page.frames[-1].evaluate("""() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      return { viewport: [window.innerWidth, window.innerHeight],
               top: Math.round(deck.top), bottom: Math.round(window.innerHeight - deck.bottom),
               left: Math.round(deck.left), right: Math.round(window.innerWidth - deck.right) };
    }""")
    return {'frame': [frame_width, frame_height], **inside}


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # Wide columns show the 16:9 stage. Below the deck's 700px breakpoint it
        # reflows to portrait, which is intentionally content-tall — bars do not
        # apply there, so only the stage layout is asserted.
        for column in (766, 1000):
            measured = mount(page, deck, column)
            # The old fixed 560px frame left ~65px bars on each side. A few
            # pixels of rounding/centering may remain; bars must not.
            for edge in ('top', 'bottom', 'left', 'right'):
                assert abs(measured[edge]) <= 5, (column, edge, measured)
        assert not errors, errors
        print('PASS: 16:9 decks fill their frame without letterbox bars')
    finally:
        browser.close()
