"""A fit-to-height slide stage must report its layout width, not its scaled width.

Regression: the deck reported the painted width of the 1280px stage after it
was scaled down to fit a short frame. The host then shrank the card to that
width, which scaled the stage further on the next measurement, collapsing the
card to its 240px floor (titles wrap to one character per line).
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

deck = """<style>
html,body{margin:0;height:100%;overflow:hidden}
.viz-theme{height:100%}
.stage{position:absolute;top:50%;left:50%;width:1280px;height:720px;transform-origin:center center}
.narrow{width:300px}
</style>
<div class="stage" id="stage"><h1 id="title">Slide deck</h1>
<div class="narrow" id="narrow">Narrow panel</div></div>
<script>
(function(){
  var stage=document.getElementById('stage');
  function fit(){
    var scale=Math.min(window.innerWidth/1280,window.innerHeight/720);
    stage.style.transform='translate(-50%,-50%) scale('+scale+')';
    document.body.style.height=window.innerHeight+'px';
  }
  window.addEventListener('resize',fit);
  fit();
})();
</script>"""

bridge = (repo / 'src/renderer/chat/visualize-card.js').read_text(encoding='utf-8')
theme = (repo / 'src/renderer/shared/ui-theme.css').read_text(encoding='utf-8')
host_css = (repo / 'src/renderer/chat/visualize-card.css').read_text(encoding='utf-8')


def mount(page, fragment, container, frame_height=560):
    page.set_content(
        '<html><head><style>' + host_css + '</style><style>' + theme + '</style></head>'
        '<body style="margin:0"><div style="width:' + str(container) + 'px">'
        '<div id="host"></div></div>'
        '<style>.visualize-frame{height:' + str(frame_height) + 'px !important}</style></body></html>')
    page.add_script_tag(content=bridge)
    page.evaluate(
        """([fragment]) => {
          window.dshDesktop = {
            visualizeGet: async ({ cardId }) => ({ ok: true, card: { cardId, title: 'Stage', mode: 'wide',
              style: 'paper', html: fragment, state: {} }}),
            visualizeState: async () => ({ ok: true }),
          };
          const card = CamelliaVisualize.mount({ cardId: 'stage', title: 'Stage', mode: 'wide' },
            { sessionId: 'stage' });
          document.querySelector('#host').append(card);
        }""", [fragment])
    page.wait_for_timeout(1200)
    return page.evaluate("""() => {
      const block = document.querySelector('.visualize-block');
      return {
        width: Math.round(block.getBoundingClientRect().width),
        inline: block.style.width,
        compact: block.classList.contains('is-compact'),
        headHeight: Math.round(block.querySelector('.visualize-head').getBoundingClientRect().height),
      };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        # A short frame scales the 1280px stage to ~30% of its layout width.
        # The card must still fill the column instead of copying that scaled
        # width and collapsing to its 240px floor.
        wide = mount(page, deck, 1000, frame_height=200)
        assert wide['width'] == 1000, wide
        assert wide['inline'] == '', wide
        assert wide['headHeight'] < 90, wide

        # A narrow column still fills whatever space the chat gives the card.
        narrow = mount(page, deck, 480, frame_height=200)
        assert narrow['width'] == 480, narrow
        assert narrow['inline'] == '', narrow

        # The card also recovers when the column grows after the first paint.
        page.evaluate("document.querySelector('#host').parentElement.style.width='1000px'")
        page.wait_for_timeout(900)
        grown = page.evaluate("""() => {
          const block = document.querySelector('.visualize-block');
          return { width: Math.round(block.getBoundingClientRect().width),
                   inline: block.style.width, compact: block.classList.contains('is-compact') };
        }""")
        assert grown['width'] == 1000, grown
        assert grown['inline'] == '', grown
        assert grown['compact'] is False, grown

        # A genuinely small card keeps hugging its content, as before.
        compact = mount(page, '<div style="width:320px;border:1px solid #ccc">Small card</div>', 1000)
        assert 300 <= compact['width'] <= 380, compact
        assert compact['compact'] is True, compact
        assert not errors, errors
        print('PASS: slide stages report layout width; small cards still hug their content')
    finally:
        browser.close()
