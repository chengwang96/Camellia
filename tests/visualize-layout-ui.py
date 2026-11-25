"""Exercise the shared layout contract through desktop and remote rendering."""
import json
from pathlib import Path
import subprocess

from playwright.sync_api import expect, sync_playwright

repo = Path(__file__).resolve().parents[1]
chat = repo / "src/renderer/chat"
bridge = (chat / "visualize-card.js").read_text(encoding="utf-8")
css = (chat / "visualize-card.css").read_text(encoding="utf-8")

ratio_card = """
<style>
:root { --viz-padding: 0; }
.viz-theme { display: grid; place-items: center; }
main { width: 100%; aspect-ratio: 4/3; background: white; }
html[data-viz-presenting="1"] main { width: min(100%, calc(100vh * 4 / 3)); }
</style>
<main class="viz-stage" MARKER>
  <p>Page one</p><button>Pause</button>
</main>
<script>
window.commands = [];
window.addEventListener("camellia:presentation-command", event => commands.push(event.detail.command));
</script>
"""


def mount(page, fragment):
    page.set_content(f'<style>{css}</style><div id="column" style="width:900px;max-width:100%"></div>')
    page.add_script_tag(content=bridge)
    page.evaluate("""html => {
      window.dshDesktop = {
        visualizeGet: async ({cardId}) => ({ok:true, card:{cardId,title:'Demo',layoutVersion:2,html,state:{}}}),
      };
      column.append(CamelliaVisualize.mount({cardId:'demo',title:'Demo'},{sessionId:'session'}));
    }""", fragment)
    frame = page.frame_locator("iframe")
    expect(frame.locator("main")).to_be_visible()
    return frame


def rendered_height(page, pixels):
    page.wait_for_function(
        "height => Math.abs(document.querySelector('iframe').clientHeight - height) <= 1",
        arg=pixels,
    )


def remote_document(fragment):
    return subprocess.check_output(
        ["node", "-e", """
          const { visualizationDocument } = require('./src/main/remote/visualizations.js');
          const card = JSON.parse(require('node:fs').readFileSync(0,'utf8'));
          process.stdout.write(visualizationDocument(card));
        """],
        input=json.dumps({"layoutVersion": 2, "html": fragment}).encode(),
        cwd=repo,
    ).decode()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    for marker in ("", 'data-viz-presentation="slides"'):
        frame = mount(page, ratio_card.replace("MARKER", marker))
        rendered_height(page, 675)
        page.locator(".visualize-present").click()
        expect(frame.locator("html")).to_have_attribute("data-viz-presenting", "1")
        assert abs(frame.locator("main").bounding_box()["width"] - 1333) <= 2
        frame.get_by_role("button", name="Pause").click()
        frame.get_by_text("Page one").click()
        assert page.frames[-1].evaluate("commands") == (["next"] if marker else [])
        page.keyboard.press("Escape")
        expect(frame.locator("html")).not_to_have_attribute("data-viz-presenting", "1")
        rendered_height(page, 675)

    frame = mount(page, '<main style="width:320px;max-width:100%;height:48px"><input value="42"></main>')
    expect(page.locator(".visualize-block")).to_have_class("visualize-block is-compact")
    rendered_height(page, 80)
    frame.locator("input").fill("97")
    page.locator(".visualize-expand").click()
    rendered_height(page, 760)
    page.locator(".visualize-present").click()
    expect(frame.locator("html")).to_have_attribute("data-viz-presenting", "1")
    page.keyboard.press("Escape")
    expect(frame.locator("html")).not_to_have_attribute("data-viz-presenting", "1")
    rendered_height(page, 760)
    expect(frame.locator("input")).to_have_value("97")
    page.locator(".visualize-expand").click()
    rendered_height(page, 80)
    page.frames[-1].evaluate("document.querySelector('main').style.height = '280px'")
    rendered_height(page, 312)
    for width, expected_width in [(280, 280), (900, 352)]:
        page.locator("#column").evaluate("(element, width) => element.style.width = width + 'px'", width)
        page.wait_for_function(
            "width => document.querySelector('iframe').clientWidth === width", arg=expected_width,
        )

    for width, height in [(390, 844), (844, 390)]:
        page.set_viewport_size({"width": width, "height": height})
        for marker in ("", 'data-viz-presentation="slides"'):
            page.set_content(remote_document(ratio_card.replace("MARKER", marker)))
            page.evaluate("window.__camelliaSetPresenting(true)")
            assert abs(page.locator("main").bounding_box()["width"] - min(width, height * 4/3)) <= 2
            page.get_by_role("button", name="Pause").click()
            page.get_by_text("Page one").click()
            page.evaluate("window.__camelliaPresentationCommand('previous')")
            assert page.evaluate("commands") == (["next", "previous"] if marker else [])

    assert not errors, errors
    browser.close()
    print("PASS: CSS determines card size, presentation preserves the view, and navigation is opt-in")
