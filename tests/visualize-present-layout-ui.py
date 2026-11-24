"""Presenting must keep the deck's own scale, and Esc must restore inline size."""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

deck = """<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0d1117}
body{display:flex;align-items:center;justify-content:center}
.deck{width:1280px;height:720px;background:#fffdf8;flex:0 0 auto;transform-origin:center center}
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
})();
</script>"""

bridge = (repo / 'src/renderer/chat/visualize-card.js').read_text(encoding='utf-8')
theme = (repo / 'src/renderer/shared/ui-theme.css').read_text(encoding='utf-8')
host_css = (repo / 'src/renderer/chat/visualize-card.css').read_text(encoding='utf-8')


def mount(page, column):
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
        }""", [deck])
    page.wait_for_timeout(1500)


def stage(page):
    return page.frames[-1].evaluate("""() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      return { width: Math.round(deck.width), height: Math.round(deck.height),
               viewport: [window.innerWidth, window.innerHeight],
               presenting: document.documentElement.getAttribute('data-viz-presenting') === '1' };
    }""")


def frame_size(page):
    return page.evaluate("""() => {
      const block = document.querySelector('.visualize-block');
      const frame = block.querySelector('iframe');
      const frameWrap = block.querySelector('.visualize-frame-wrap');
      return { block: [Math.round(block.getBoundingClientRect().width),
                       Math.round(block.getBoundingClientRect().height)],
               frame: [Math.round(frame.getBoundingClientRect().width),
                       Math.round(frame.getBoundingClientRect().height)],
               wrap: [Math.round(frameWrap.getBoundingClientRect().width),
                      Math.round(frameWrap.getBoundingClientRect().height)],
               inlineWidth: block.style.width, inlineHeight: frame.style.height };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        mount(page, 900)
        inline = frame_size(page)
        before = stage(page)

        # Enter fullscreen the way the Present button does.
        page.evaluate("document.querySelector('.visualize-present').click()")
        page.wait_for_timeout(1200)
        during = stage(page)
        assert during['presenting'], during
        # The stage scales by min(viewport/1280, viewport/720); forcing the deck
        # to width:100% used to change its layout width first, so the painted
        # result overflowed the viewport.
        viewport_w, viewport_h = during['viewport']
        expected = min(viewport_w / 1280, viewport_h / 720)
        assert abs(during['width'] - round(1280 * expected)) <= 2, (during, expected)
        assert abs(during['height'] - round(720 * expected)) <= 2, (during, expected)
        assert during['width'] <= viewport_w + 1, during
        assert during['height'] <= viewport_h + 1, during

        page.evaluate("document.exitFullscreen()")
        page.wait_for_timeout(1200)
        after = stage(page)
        restored = frame_size(page)
        assert not after['presenting'], after
        assert abs(after['width'] - before['width']) <= 4, (before, after)
        assert abs(after['height'] - before['height']) <= 4, (before, after)
        assert abs(restored['block'][0] - inline['block'][0]) <= 4, (inline, restored)
        assert abs(restored['block'][1] - inline['block'][1]) <= 6, (inline, restored)
        assert restored['wrap'] == inline['wrap'], (inline, restored)
        assert restored['inlineHeight'] == inline['inlineHeight'], (inline, restored)
        assert not errors, errors
        print('PASS: present keeps deck scale; Esc restores the inline frame')
    finally:
        browser.close()
