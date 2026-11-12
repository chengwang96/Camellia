"""Check every visible settings dropdown across pages and responsive widths."""
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright


repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(
    ["node", str(repo / "tests/desktop-ui-driver.cjs")],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
)


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({"method": method, "payload": payload}) + "\n")
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError("Test driver exited: " + driver.stderr.read())
    response = json.loads(line)
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


measure = """() => [...document.querySelectorAll('select')]
  .filter(select => select.getClientRects().length)
  .map(select => {
    const box = select.getBoundingClientRect();
    const owner = select.closest(
      '.setting-row, .engine-field, .filter-row label, .section-head, ' +
      '.balance-filter, .quick-switch-row, .document-toolbar, .device-field, .row, dialog');
    return {
      id: select.id,
      left: box.left,
      right: box.right,
      width: box.width,
      ownerWidth: owner?.getBoundingClientRect().width ?? null,
      capped: select.matches(
        '.setting-row > select, .engine-field > select, .section-head > select, ' +
        '.document-toolbar > select, .vscode-controls select'),
    };
  })"""

try:
    rpc("fixtures")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1180, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.expose_function("testRpc", rpc)
        page.add_init_script("""
          window.dshDesktop = new Proxy({}, { get: (_, method) => {
            if (method === 'platform') return 'win32';
            if (method.startsWith('on')) return () => () => {};
            return payload => testRpc(method, payload);
          }});
        """)
        page.goto((repo / "src/renderer/settings/api-settings.html").as_uri() + "?page=general",
                  wait_until="networkidle")
        views = [
            "subscriptions", "providers", "usage", "general", "data", "network",
            "engines", "models", "archived", "mobile", "devices",
        ]
        audited = 0
        for language in ["en", "zh-CN"]:
            page.evaluate("language => CamelliaI18n.setLanguage(language)", language)
            for width in [1180, 900, 700, 390, 320]:
                page.set_viewport_size({"width": width, "height": 900})
                for view in views:
                    page.locator(f'.settings-nav nav [data-view="{view}"]').click()
                    page.wait_for_timeout(80)
                    for select in page.evaluate(measure):
                        audited += 1
                        label = (language, width, view, select["id"])
                        assert select["left"] >= -1 and select["right"] <= width + 1, (label, select)
                        if select["ownerWidth"] is not None:
                            assert select["width"] <= select["ownerWidth"] + 1, (label, select)
                        if select["capped"]:
                            assert select["width"] <= 280.5, (label, select)
        assert audited > 100, audited
        assert not errors, errors
        browser.close()
    print("Settings dropdown widths: all pages and responsive widths passed")
finally:
    try:
        rpc("cleanup")
    finally:
        driver.terminate()
        driver.wait(timeout=10)
