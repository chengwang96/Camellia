"""Tailscale OAuth and explicit Peer Relay setup, using an isolated desktop bridge."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const state = { running: false, enabled: false, address: null, devices: [], pending: [], workspaces: [],
    closeToTray: false, language: 'en', theme: 'light',
    tailscale: { configured: false, state: 'unconfigured', changedAcl: false } };
  window.remoteTest = state;
  window.tailscaleCalls = [];
  window.dshDesktop = { remoteControl: async (action, payload) => {
    window.lastTailscaleAction = { action, payload };
    window.tailscaleCalls.push({ action, payload });
    if (action === 'tailscale-open-credentials') return { ok: true, result: { opened: true } };
    if (action === 'tailscale-save') {
      if (payload.clientSecret === 'mock-invalid-client-secret') return { ok: true, result: { saved: false, state: 'invalid', changedAcl: false } };
      state.tailscale = { configured: true, clientId: payload.clientId, state: 'connected', changedAcl: false,
        tailnet: { name: 'example.ts.net', deviceCount: 4, onlineCount: 3, taggedCount: 2 },
        devices: [{ id: 'relay', name: 'Aliyun Shenzhen', hostname: 'relay', os: 'linux', online: true, addresses: ['100.77.253.81'], tags: [], relayGranted: true },
          { id: 'laptop', name: 'Office laptop', hostname: 'laptop', os: 'windows', online: true, addresses: ['100.108.98.58'], tags: [], relayGranted: false },
          { id: 'phone', name: 'Android phone', hostname: 'phone', os: 'android', online: true, addresses: ['100.80.1.2'], tags: [], relayGranted: false },
          { id: 'no-ip', name: 'Unidentified node', hostname: 'node', os: 'linux', online: true, addresses: [], tags: [], relayGranted: false }],
        acl: { present: true, etag: 'W/\\"one\\"', hasRelayGrant: true } };
      return { ok: true, result: { saved: true, ...state.tailscale } };
    }
    if (action === 'tailscale-remove') {
      state.tailscale = { configured: false, state: 'unconfigured', changedAcl: false };
      return { ok: true, result: state.tailscale };
    }
    if (action === 'tailscale-apply-peer-relay') {
      state.tailscale = { ...state.tailscale, applied: true, changedAcl: true, changedDevices: false,
        devices: [{ id: 'relay', name: 'Aliyun Shenzhen', hostname: 'relay', os: 'linux', online: true, addresses: ['100.77.253.81'], tags: [], relayGranted: true, relaySelected: payload.enabled, relayExact: payload.enabled },
          { id: 'laptop', name: 'Office laptop', hostname: 'laptop', os: 'windows', online: true, addresses: ['100.108.98.58'], tags: [], relayGranted: false },
          { id: 'phone', name: 'Android phone', hostname: 'phone', os: 'android', online: true, addresses: ['100.80.1.2'], tags: [], relayGranted: false },
          { id: 'no-ip', name: 'Unidentified node', hostname: 'node', os: 'linux', online: true, addresses: [], tags: [], relayGranted: false }] };
      return { ok: true, result: state.tailscale };
    }
    if (action === 'tailscale-rename-device') {
      state.tailscale = { ...state.tailscale, renamed: true, renameVerified: true, devices: state.tailscale.devices.map(entry =>
        entry.id === payload.deviceId ? { ...entry, name: payload.name } : entry) };
      return { ok: true, result: structuredClone(state.tailscale) };
    }
    if (action === 'state') return { ok: true, result: structuredClone(state) };
    return { ok: true, result: structuredClone(state) };
  } };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 760, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'tests/fixtures/mobile-access-settings-host.html').as_uri())
        page.wait_for_load_state('networkidle')
        page.evaluate('window.mobileAccessUI.setVisible(true)')
        page.wait_for_function("document.getElementById('mobile-tailscaleStatus').textContent !== ''")
        page.locator('.advanced-settings > summary').click()
        expect(page.locator('#mobile-tailscaleStatus')).to_have_text('Not configured')
        expect(page.locator('#mobile-tailscaleForm')).to_be_visible()
        expect(page.locator('#mobile-tailscaleRemove')).to_be_hidden()
        expect(page.locator('#mobile-relayRename')).to_be_disabled()
        page.locator('#mobile-tailscaleOpen').click()
        expect(page.locator('#mobile-tailscaleFeedback')).to_have_text('Opened the Tailscale credentials page in the browser.')
        page.wait_for_timeout(100)
        assert page.evaluate("window.tailscaleCalls.some(call => call.action === 'tailscale-open-credentials')")
        page.locator('#mobile-tailscaleClientId').fill('client-id.example')
        page.locator('#mobile-tailscaleClientSecret').fill('mock-invalid-client-secret')
        page.locator('#mobile-tailscaleSave').click()
        expect(page.locator('#mobile-tailscaleFeedback')).to_contain_text('Invalid credentials')
        assert page.locator('#mobile-tailscaleClientSecret').input_value() == ''
        page.locator('#mobile-tailscaleClientSecret').fill('mock-oauth-client-secret')
        page.locator('#mobile-tailscaleSave').click()
        expect(page.locator('#mobile-tailscaleStatus')).to_have_text('Connected')
        expect(page.locator('#mobile-tailscaleDetails')).to_contain_text('Peer Relay access is present')
        expect(page.locator('#mobile-tailscaleForm')).to_be_hidden()
        expect(page.locator('#mobile-tailscaleRemove')).to_be_visible()
        expect(page.locator('#mobile-relayConfig')).to_be_visible()
        expect(page.locator('#mobile-relayDevice')).to_have_value('relay')
        expect(page.locator('#mobile-relayDevice option')).to_have_count(1)
        assert 'Office laptop' not in page.locator('#mobile-relayDevice').inner_text()
        assert page.evaluate("document.querySelector('#mobile-relayChoice').hidden")
        page.evaluate("document.querySelector('#mobile-relayUse').dispatchEvent(new Event('change'))")
        page.wait_for_timeout(200)
        expect(page.locator('#mobile-relayStatus')).to_be_hidden()
        assert page.evaluate("window.tailscaleCalls.some(call => call.action === 'tailscale-apply-peer-relay' && call.payload.enabled === false)")
        page.locator('#mobile-relayUse').check()
        expect(page.locator('#mobile-relayChoice')).to_be_visible()
        expect(page.locator('#mobile-relayDevice')).to_have_value('relay')
        switch_style = page.locator('#mobile-relayUse').evaluate("element => { const style = getComputedStyle(element); return { width: style.width, height: style.height, radius: style.borderRadius }; }")
        assert switch_style == {'width': '36px', 'height': '21px', 'radius': '20px'}, switch_style
        assert 'Android phone' not in page.locator('#mobile-relayDevice').inner_text()
        assert 'Unidentified node' not in page.locator('#mobile-relayDevice').inner_text()
        page.wait_for_timeout(200)
        assert page.evaluate("window.tailscaleCalls.some(call => call.action === 'tailscale-apply-peer-relay' && call.payload.enabled === true)")
        expect(page.locator('#mobile-relayDevice')).to_have_value('relay')
        assert 'Office laptop' not in page.locator('#mobile-relayDevice').inner_text()
        assert '100.77.253.81' in page.locator('#mobile-relayDevice').inner_text()
        relay_box = page.locator('#mobile-relayDevice').bounding_box()
        assert relay_box and relay_box['width'] <= 420
        # Older desktop processes expose ACL relay targets without the
        # per-device marker. The page must still offer the same relay.
        page.evaluate("""() => {
          remoteTest.tailscale.devices = remoteTest.tailscale.devices.map(device => ({
            ...device,
            relayGranted: false,
          }));
          remoteTest.tailscale.acl = { ...remoteTest.tailscale.acl, relayTargets: ['100.77.253.81'] };
        }""")
        page.evaluate('window.mobileAccessUI.refresh()')
        expect(page.locator('#mobile-relayUse')).to_be_enabled()
        expect(page.locator('#mobile-relayDevice')).to_have_value('relay')
        page.wait_for_timeout(5200)
        expect(page.locator('#mobile-relayDevice')).to_have_value('relay')
        assert page.evaluate("document.querySelector('#mobile-relayDevice').dataset.signature.length > 0")
        assert page.evaluate("window.tailscaleCalls.find(call => call.action === 'tailscale-save' && call.payload.clientSecret === 'mock-oauth-client-secret')")
        assert page.evaluate("window.tailscaleCalls.some(call => call.action === 'tailscale-apply-peer-relay' && call.payload.deviceId === 'relay' && call.payload.enabled === true)")
        page.locator('#mobile-relayRename').click()
        page.locator('#mobile-relayName').fill('vps-relay')
        page.locator('#mobile-relayRenameSave').click()
        expect(page.locator('#mobile-relayName')).to_be_hidden()
        assert page.evaluate("window.tailscaleCalls.some(call => call.action === 'tailscale-rename-device' && call.payload.deviceId === 'relay' && call.payload.name === 'vps-relay')")
        expect(page.locator('#mobile-relayDevice')).to_contain_text('vps-relay')
        page.locator('#mobile-tailscaleRemove').click()
        expect(page.locator('#mobile-tailscaleStatus')).to_have_text('Not configured')
        expect(page.locator('#mobile-tailscaleForm')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.evaluate("document.querySelector('.scroll-content').scrollTop = 1e6")
        page.wait_for_timeout(100)
        tail = page.evaluate("""() => {
          const scroller = document.querySelector('.scroll-content');
          const lastCard = document.querySelector('#mobilePage .tailscale-settings-group');
          return {
            atEnd: scroller.scrollTop === scroller.scrollHeight - scroller.clientHeight,
            cardBottom: lastCard.getBoundingClientRect().bottom,
            viewportBottom: scroller.getBoundingClientRect().bottom,
            actionsDisplay: getComputedStyle(document.querySelector('.mobile-page-actions')).display
          };
        }""")
        assert tail['atEnd'], tail
        assert abs(tail['cardBottom'] - tail['viewportBottom']) <= 1, tail
        assert tail['actionsDisplay'] == 'none', tail
        assert not errors, errors
        page.evaluate("document.querySelectorAll('img').forEach(image => image.remove())")
        page.screenshot(path=str(repo / '.tmp-tailscale-settings.png'), full_page=True)
        print('Tailscale OAuth and explicit Peer Relay setup UI passed')
    finally:
        browser.close()
