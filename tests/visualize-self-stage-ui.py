"""A card that owns its presentation stage must not be double-scaled.

Regression: the wave explainer switches to a 1280x720 stage by adding a
`stage-mode` class and scaling a `.wrap` element itself (--stage-scale). It
does not use data-viz-presentation="slides". The host's presentation rule then
also forced that root to width:100%, so the card laid out at the viewport
width and applied its own scale on top: presented content came out zoomed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]

deck = """<style>
html,body{margin:0;background:#e7e3d8}
.wrap{max-width:1180px;margin:0 auto;padding:20px 18px;background:#f3f0e7}
html.stage-mode,html.stage-mode body{width:100%;height:100%;overflow:hidden}
.stage-mode .wrap{position:absolute;left:50%;top:50%;width:1280px;height:720px;max-width:none;
  margin:0;transform:translate(-50%,-50%) scale(var(--stage-scale,1));transform-origin:center center;}
</style>
<div class="wrap"><h1>Wave</h1></div>
<script>
(function(){
  var wrap=document.querySelector('.wrap');
  function fit(){
    if(innerWidth<700){document.documentElement.classList.remove('stage-mode');
      wrap.style.removeProperty('--stage-scale');return;}
    document.documentElement.classList.add('stage-mode');
    wrap.style.setProperty('--stage-scale',String(Math.min(innerWidth/1280,innerHeight/720)));
  }
  addEventListener('resize',fit);
  addEventListener('camellia:presentation',function(){setTimeout(fit,60)});
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
            visualizeGet: async ({ cardId }) => ({ ok: true, card: { cardId, title: 'Wave', mode: 'wide',
              style: 'paper', html: fragment, state: {} }}),
            visualizeState: async () => ({ ok: true }),
          };
          const card = CamelliaVisualize.mount({ cardId: 'w', title: 'Wave', mode: 'wide' },
            { sessionId: 's' });
          document.querySelector('#host').append(card);
        }""", [deck])
    page.wait_for_timeout(1400)
    return page.frames[-1]


def stage(frame):
    return frame.evaluate("""() => {
      const wrap = document.querySelector('.wrap').getBoundingClientRect();
      return { wrap: [Math.round(wrap.width), Math.round(wrap.height)],
               viewport: [innerWidth, innerHeight],
               selfStage: document.documentElement.getAttribute('data-viz-self-stage') === '1',
               presenting: document.documentElement.getAttribute('data-viz-presenting') === '1' };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        frame = mount(page, 1100)
        inline = stage(frame)
        initial_frame = page.evaluate(
            "Math.round(document.querySelector('iframe').getBoundingClientRect().height)")
        page.evaluate("document.querySelector('.visualize-present').click()")
        page.wait_for_timeout(1800)
        presented = stage(frame)
        assert presented['presenting'] is True, presented
        assert presented['selfStage'] is True, presented
        # The painted stage keeps the 16:9 ratio of its 1280x720 design box and
        # fills the viewport instead of inheriting the narrow inline width.
        # Double-scaling showed up as a stage wider than the viewport.
        width, height = presented['viewport']
        assert abs(presented['wrap'][0] - round(1280 * min(width / 1280, height / 720))) <= 2, presented
        assert abs(presented['wrap'][1] - round(720 * min(width / 1280, height / 720))) <= 2, presented
        assert presented['wrap'][0] <= width + 1, presented
        assert presented['wrap'][1] <= height + 1, presented

        page.evaluate("document.exitFullscreen()")
        page.wait_for_timeout(1800)
        restored = stage(frame)
        assert restored['presenting'] is False, restored
        assert abs(restored['wrap'][0] - inline['wrap'][0]) <= 3, (inline, restored)
        assert abs(restored['wrap'][1] - inline['wrap'][1]) <= 3, (inline, restored)
        # The inline frame must also return to its pre-presentation height; a
        # plain-content default (560px) shrank a 16:9 stage to ~505px and left
        # empty bands on both sides.
        restored_frame = page.evaluate(
            "Math.round(document.querySelector('iframe').getBoundingClientRect().height)")
        assert abs(restored_frame - initial_frame) <= 3, (initial_frame, restored_frame)
        # And the stage must fill the frame width, so no side bands remain.
        assert abs(restored['wrap'][0] - restored_frame * 16 / 9) <= 6, (restored, restored_frame)

        # Presenting after Expand used to come back at the expanded 760px
        # height, because expandedHeight() floors there and the fullscreen
        # frame had already recorded that height as the card's own.
        page.evaluate("document.querySelector('.visualize-expand').click()")
        page.wait_for_timeout(900)
        expanded_frame = page.evaluate(
            "Math.round(document.querySelector('iframe').getBoundingClientRect().height)")
        page.evaluate("document.querySelector('.visualize-present').click()")
        page.wait_for_timeout(1500)
        page.evaluate("document.exitFullscreen()")
        page.wait_for_timeout(1500)
        after_expanded = page.evaluate(
            "Math.round(document.querySelector('iframe').getBoundingClientRect().height)")
        assert after_expanded < expanded_frame - 40, (expanded_frame, after_expanded)
        assert not errors, errors
        print('PASS: a self-managed stage presents at its own scale and restores on Esc')
    finally:
        browser.close()
