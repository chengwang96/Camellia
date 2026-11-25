"""Present/Esc the real wave card: the inline frame must keep its stage ratio.

Regression: a card that scales its own 1280x720 stage returned at the plain
content height (560px) after Esc. Its stage then shrank to ~505px and left
empty bands on both sides of the card.
"""
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
CARD = Path(r'C:\Users\45846\AppData\Roaming\camellia\conversations\visualize'
            r'\a4619f9e-00da-464b-b5e0-979d9032d940\fa57580b-2c1f-4c34-a77c-f64ab3a17e9a.html')

if not CARD.exists():
    print('SKIP: the reference card is no longer on this machine')
    sys.exit(0)

html = CARD.read_text(encoding='utf-8')
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
          const c = CamelliaVisualize.mount({ cardId: 'w', title: 'Wave', mode: 'wide' }, { sessionId: 's' });
          document.querySelector('#host').append(c);
        }""", [html])
    page.wait_for_timeout(2200)


def frame_height(page):
    return page.evaluate("Math.round(document.querySelector('iframe').getBoundingClientRect().height)")


def stage(page):
    return page.frames[-1].evaluate("""() => {
      const wrap = document.querySelector('.wrap');
      const r = wrap.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height),
               viewport: [innerWidth, innerHeight] };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1800, 'height': 960})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        mount(page, 900)
        before = frame_height(page)
        before_stage = stage(page)

        page.evaluate("document.querySelector('.visualize-present').click()")
        page.wait_for_timeout(2400)
        page.evaluate("document.exitFullscreen()")
        page.wait_for_timeout(2400)
        after = frame_height(page)
        after_stage = stage(page)

        assert abs(after - before) <= 4, (before, after)
        # The stage must fill the frame: frame width equals stage width, and the
        # frame height equals the stage height (both are the 16:9 box).
        after_width = page.evaluate(
            "Math.round(document.querySelector('iframe').getBoundingClientRect().width)")
        assert abs(after_stage['width'] - after_width) <= 6, (after_stage, after_width)
        assert abs(after_stage['height'] - after) <= 6, (after_stage, after)
        assert abs(after_stage['width'] / after_stage['height'] - 16 / 9) <= 0.05, after_stage
        assert not errors, errors
        print('PASS: real stage card keeps its 16:9 frame after Esc')
    finally:
        browser.close()
