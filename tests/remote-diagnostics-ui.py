"""Exercise path changes, cancellation and reports in both mobile-access panels."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
bridge = """(() => {
  const state = { running: true, enabled: true, address: 'http://100.80.1.2:43127', computerName: 'HP',
    diagnosticsAvailable: true, devices: [{id: 'phone', name: 'Xiaomi <test>', lastSeenAt: Date.now(), peerAddress: '100.90.1.2'}],
    pending: [], workspaces: [], network: {state: 'Running'}, language: 'zh-CN', theme: 'system', closeToTray: true };
  window.remoteTest = state; window.probes = []; window.pathScenario = 'transition';
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => { window.copiedDiagnostic = value; }}, configurable: true});
  const control = async (action, payload) => {
    if (action !== 'diagnose') return {ok: true, result: structuredClone(state)};
    window.probes.push(payload);
    if (window.pathScenario === 'error') return {ok: false, error: 'Open this computer on the phone first'};
    const index = (window.probes.length - 1) % 10;
    const paths = ['derp', 'derp', 'peer-relay', 'unreachable', 'unknown', 'direct', 'direct', 'direct', 'direct', 'direct'];
    const result = {checkedAt: Date.now(), peerAddress: '100.90.1.2', path: paths[index], latencyMs: paths[index] === 'unreachable' ? null : 23.5,
      endpoint: '203.0.113.4:41641', derpRegionId: 17, derpRegionCode: 'lax', derpRegionName: 'Los Angeles', peerRelay: '203.0.113.5:41641:vni:1'};
    if (window.pathScenario === 'delayed') await new Promise(resolve => { window.releaseProbe = resolve; });
    return {ok: true, result};
  };
  window.camelliaRemote = {control}; window.dshDesktop = {remoteControl: control};
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for embedded in [False, True]:
            page = browser.new_page(viewport={'width': 720, 'height': 850}, color_scheme='dark' if embedded else 'light')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            if embedded:
                html = (repo / 'src/renderer/settings/api-settings.html').read_text(encoding='utf-8')
                html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
                page.route('**/api-settings.html', lambda route: route.fulfill(body=html, content_type='text/html'))
                page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri())
                page.evaluate("remoteTest.language = 'en'; document.getElementById('mobilePage').hidden = false; document.documentElement.removeAttribute('data-i18n-pending')")
                page.add_script_tag(url=(repo / 'src/renderer/remote/diagnostics.js').as_uri())
                page.add_script_tag(url=(repo / 'src/renderer/remote/remote.js').as_uri())
                page.evaluate('window.mobileAccessUI.setVisible(true)')
            else:
                page.goto((repo / 'src/renderer/remote/remote.html').as_uri())
            page.wait_for_load_state('networkidle')
            button_name = 'Connection diagnostics' if embedded else '连接诊断'
            page.get_by_role('button', name=button_name, exact=True).click()
            dialog = page.locator('dialog.tailnet-diagnostics')
            expect(dialog).to_be_visible()
            expect(dialog.locator('tbody tr')).to_have_count(10, timeout=18000)
            expect(dialog.locator('.diagnostic-status')).to_have_text('Complete (10/10)' if embedded else '检测完成 (10/10)')
            expect(dialog.locator('tr[data-path=direct]')).to_have_count(5)
            expect(dialog.locator('tr[data-path=derp]').first).to_contain_text('lax / Los Angeles')
            expect(dialog.locator('tr[data-path=unreachable] td').last).to_have_text('—')
            assert page.evaluate("probes.every(payload => payload.id === 'phone' && Object.keys(payload).length === 1)")
            page.get_by_role('button', name='Copy report' if embedded else '复制报告', exact=True).click()
            report = page.evaluate('window.copiedDiagnostic')
            assert 'HP' in report and 'Xiaomi <test>' in report and 'lax / Los Angeles' in report and '203.0.113.4:41641' in report
            assert ('computer → phone' if embedded else '电脑 → 手机') in report
            assert dialog.locator('img').count() == 0
            page.set_viewport_size({'width': 480, 'height': 650})
            bounds = dialog.bounding_box()
            assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 480
            for button in dialog.locator('button').all():
                box = button.bounding_box()
                assert box and box['y'] >= bounds['y'] and box['y'] + box['height'] <= bounds['y'] + bounds['height']
            page.screenshot(path=str(screenshots / f'remote-diagnostics-{ "embedded" if embedded else "standalone" }.png'))
            page.get_by_role('button', name='Close' if embedded else '关闭', exact=True).click()
            expect(dialog).to_have_count(0)
            if not embedded:
                # Stopping cancels the gap before the next probe; closing also
                # ignores a late response from a probe already in flight.
                page.evaluate("window.probes = []")
                page.get_by_role('button', name=button_name, exact=True).click()
                expect(dialog.locator('tbody tr')).to_have_count(1)
                page.get_by_role('button', name='停止检测', exact=True).click()
                expect(dialog.locator('.diagnostic-status')).to_have_text('已停止 (1/10)')
                page.wait_for_timeout(1200)
                assert page.evaluate('probes.length') == 1
                page.get_by_role('button', name='关闭', exact=True).click()
                page.evaluate("window.pathScenario = 'delayed'; window.probes = []")
                page.get_by_role('button', name=button_name, exact=True).click()
                page.wait_for_function('typeof window.releaseProbe === "function"')
                page.get_by_role('button', name='关闭', exact=True).click()
                page.evaluate('window.releaseProbe()')
                page.wait_for_timeout(1200)
                assert page.evaluate('probes.length') == 1
                page.evaluate("window.pathScenario = 'error'")
                page.get_by_role('button', name=button_name, exact=True).click()
                expect(dialog.locator('.diagnostic-error')).to_have_text('请先在手机上打开这台电脑，再重新检测。')
                expect(dialog.locator('.diagnostic-status')).to_have_text('检测未完成 (0/10)')
                expect(page.get_by_role('button', name='复制报告', exact=True)).to_be_disabled()
                page.get_by_role('button', name='关闭', exact=True).click()
            assert not errors, errors
            page.close()
        print('PASS: actual panel entry, path transitions, relay region, timeout, reports, cancellation, localization and narrow layout')
    finally:
        browser.close()
