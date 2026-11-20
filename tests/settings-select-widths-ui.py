"""Check settings dropdowns and disclosure layouts across pages and responsive widths."""
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
  .filter(select => select.getClientRects().length && select.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}))
  .map(select => {
    const box = select.getBoundingClientRect();
    const owner = select.closest(
      '.setting-row, .engine-field, .filter-row label, .section-head, ' +
      '.balance-filter, .quick-switch-row, .document-toolbar, .device-field, .row, dialog');
    return {
      id: select.id,
      field: select.dataset.field || '', details: select.closest('details')?.id || '',
      left: box.left,
      right: box.right,
      width: box.width,
      ownerWidth: owner?.getBoundingClientRect().width ?? null,
      capped: select.matches(
        '.setting-row > select, .engine-field > select, .section-head > select, ' +
        '.document-toolbar > select, .vscode-controls select'),
    };
  })"""

def disclosure_position(locator):
    return locator.evaluate('''element => {
      const bounds = element.getBoundingClientRect();
      const scroller = element.closest('.scroll-content');
      return {x: bounds.x, y: bounds.y + (scroller ? scroller.scrollTop : window.scrollY)};
    }''')

def audit_disclosures(page, view, label, seen):
    if view == "data":
        page.evaluate("document.querySelector('#storageDetails').hidden = false")
    if view == "subscriptions":
        page.evaluate("""() => {
          for (const id of ['googleAccountPanel', 'googleQuotaErrorDetails']) {
            const element = document.getElementById(id);
            if (!element) throw new Error('Missing disclosure fixture: ' + id);
            element.hidden = false;
          }
          document.getElementById('googleQuotaErrorRaw').textContent = 'Layout-only quota error fixture';
        }""")
    if view == "engines":
        page.evaluate("document.querySelector('#engineContent').hidden = false")
    if view == "providers":
        provider = page.locator('#providers [data-select="test"]').first
        if provider.count() and provider.is_visible():
            provider.click()
        routing = page.locator('#providerRoutingToggle')
        if routing.is_visible():
            routing.scroll_into_view_if_needed()
            before = disclosure_position(routing)
            routing.click()
            after = disclosure_position(routing)
            assert abs(after['x'] - before['x']) < 1 and abs(after['y'] - before['y']) < 1, (label, before, after)
            layout = page.locator('.provider-options').evaluate('''options => ({
              left: options.getBoundingClientRect().left,
              right: options.getBoundingClientRect().right,
              noteLeft: document.querySelector('#providerRoutingHelp > p').getBoundingClientRect().left,
              noteRight: document.querySelector('#providerRoutingHelp > p').getBoundingClientRect().right
            })''')
            assert abs(layout['noteLeft'] - layout['left']) < 1 and layout['noteRight'] <= layout['right'] + 1, (label, layout)
            seen.add('providerRoutingHelp')
            routing.click()
    details = page.locator('.page:not([hidden]) details:visible')
    for index in range(details.count()):
        detail = details.nth(index)
        summary = detail.locator(':scope > summary').first
        if not summary.count() or not summary.is_visible():
            continue
        identifier = detail.get_attribute('id') or view + ':' + (detail.get_attribute('class') or str(index))
        was_open = detail.evaluate('detail => detail.open')
        if was_open:
            summary.click()
        summary.scroll_into_view_if_needed()
        before = disclosure_position(summary)
        summary.click()
        assert detail.evaluate('detail => detail.open'), (label, identifier)
        after = disclosure_position(summary)
        assert abs(after['x'] - before['x']) < 1 and abs(after['y'] - before['y']) < 1, (label, identifier, before, after)
        children = detail.evaluate('''detail => {
          const container = detail.getBoundingClientRect();
          return [...detail.children].filter(child => child.tagName !== 'SUMMARY' && child.getClientRects().length)
            .map(child => { const box = child.getBoundingClientRect(); return {
              tag: child.tagName, id: child.id, left: box.left, right: box.right,
              containerLeft: container.left, containerRight: container.right,
              help: detail.classList.contains('settings-help')
            }; });
        }''')
        for child in children:
            assert child['left'] >= child['containerLeft'] - 1, (label, identifier, child)
            assert child['right'] <= child['containerRight'] + 1, (label, identifier, child)
            if child['help']:
                assert abs(child['left'] - child['containerLeft']) < 1, (label, identifier, child)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (label, identifier)
        seen.add(identifier)
        if not was_open:
            summary.click()

try:
    rpc("fixtures")
    rpc("configureTestApi")
    seen_disclosures = set()
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
            "engines", "models", "archived", "mobile",
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
                    audit_disclosures(page, view, (language, width, view), seen_disclosures)
        assert audited > 100, audited
        expected_disclosures = {
            'providerRoutingHelp', 'conversationHandoffHelp', 'storageCleanupHelp', 'storageDetails',
            'modelAdvanced', 'connectionAdvanced', 'providers:advanced section',
            'engineScopeDetails', 'nativeDocuments', 'googleQuotaErrorDetails',
            'mobile:mobile-help device-help', 'mobile:device-section device-card advanced-settings',
        }
        assert expected_disclosures <= seen_disclosures, sorted(expected_disclosures - seen_disclosures)
        assert not errors, errors
        browser.close()
    print(f"Settings dropdowns and {len(seen_disclosures)} disclosure regions: all pages and responsive widths passed")
finally:
    try:
        rpc("cleanup")
    finally:
        driver.terminate()
        driver.wait(timeout=10)
