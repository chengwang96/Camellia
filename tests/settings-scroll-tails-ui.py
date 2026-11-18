"""Every settings category must stop at its last visible content, without a
trailing empty scroll range. The inset below Settings belongs to its frame, not
to the scroller that carries the page."""
from pathlib import Path
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const empty = { ok: true, result: {}, engines: [], providers: [], models: [],
    config: { providers: [], usage: {}, active: {} }, state: {} };
  window.dshDesktop = new Proxy({}, { get: (_target, name) => {
    if (String(name).startsWith('on')) return () => () => {};
    if (name === 'remoteControl') return async () => ({ ok: true, result: {
      running: true, enabled: true, address: '100.80.1.2:43127', computerName: 'Test computer',
      devices: [], pending: [], workspaces: [], closeToTray: false, language: 'en', theme: 'light',
      tailscale: { configured: true, state: 'connected', devices: [], acl: { present: true, hasRelayGrant: true } },
      tailnetUpdate: { supported: true, current: 'v1.104.7' }
    } });
    if (name === 'workbenchSettings') return async () => ({ ...empty,
      version: '1.0.0', dataPath: '/test-profile/camellia', language: 'en', theme: 'light', portableSkills: true });
    if (name === 'apiRouterGetState') return async () => ({ ...empty, enabled: true, models: [], modelThinking: {} });
    if (name === 'providerInsights') return async () => ({ ok: true, providers: {}, keys: {} });
    if (name === 'networkTest') return async () => ({ ok: true, results: [],
      summary: { total: 0, direct: 0, proxy: 0, unreachable: [] } });
    return () => Promise.resolve({ ...empty });
  } });
})();"""

views = ['subscriptions', 'providers', 'usage', 'general', 'shortcuts', 'engines',
         'models', 'network', 'mobile', 'data', 'archived']

measure = """view => {
  const scroller = document.querySelector('.scroll-content');
  const page = document.getElementById(view + 'Page');
  const visible = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const visibleChildren = [...page.children].filter(visible);
  const last = visibleChildren.at(-1);
  return {
    maxScroll: scroller.scrollHeight - scroller.clientHeight,
    scrollTop: scroller.scrollTop,
    documentScrollTop: document.scrollingElement.scrollTop,
    documentHeight: document.scrollingElement.scrollHeight,
    viewportHeight: innerHeight,
    paddingBottom: getComputedStyle(scroller).paddingBottom,
    frameInset: document.querySelector('.settings-main').getBoundingClientRect().bottom
      - scroller.getBoundingClientRect().bottom,
    gap: last ? scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom : 0,
    pageBottom: page.getBoundingClientRect().bottom,
    frameBottom: scroller.getBoundingClientRect().bottom
  };
}"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width, height in [(1180, 820), (900, 720), (700, 650), (520, 700)]:
            page = browser.new_page(viewport={'width': width, 'height': height}, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri() + '?page=general')
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(250)
            for view in views:
                page.locator(f'[data-view={view}]').click()
                page.wait_for_timeout(350)
                page.locator('.scroll-content').evaluate('element => element.scrollTop = element.scrollHeight')
                page.wait_for_timeout(80)
                tail = page.evaluate(measure, view)
                assert tail['frameInset'] == 24, (width, view, tail)
                if tail['maxScroll'] > 0:
                    assert tail['scrollTop'] == tail['maxScroll'], (width, view, tail)
                    assert tail['paddingBottom'] == '0px', (width, view, tail)
                    assert abs(tail['gap']) <= 1, (width, view, tail)
                else:
                    assert tail['scrollTop'] == 0, (width, view, tail)
                    assert tail['pageBottom'] <= tail['frameBottom'] + 1, (width, view, tail)
                assert tail['documentHeight'] <= tail['viewportHeight'] + 1, (width, view, tail)
                assert tail['documentScrollTop'] == 0, (width, view, tail)
                box = page.locator('.scroll-content').bounding_box()
                page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] - 24)
                for _ in range(4):
                    page.mouse.wheel(0, 400)
                page.wait_for_timeout(50)
                after = page.evaluate(measure, view)
                assert after['scrollTop'] == tail['scrollTop'], (width, view, tail, after)
                assert after['documentScrollTop'] == 0, (width, view, tail, after)
            assert not errors, (width, errors)
            page.close()
        print('PASS: all settings categories stop at their last content at wide, medium and narrow widths')
    finally:
        browser.close()
