"""Home update reminders: real renderer, controlled runtime/registry responses."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1100, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.calls = {checks: 0, settings: [], launches: []};
      window.rows = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi'].map(id => ({
        id, name: id, status: 'ready', version: '1.0.0', mode: 'api'
      }));
      rows[0].name = 'Claude Code';
      rows[3].status = 'missing';
      rows[4].mode = 'subscription';
      rows[5].external = true;
      window.dshDesktop = {
        onRuntimeState(fn) { window.runtimeChanged = fn; },
        onNetworkHealth() {}, onLanguageChanged() {},
        async workbenchSettings() { return {ok: true, language: 'zh-CN'}; },
        async listCliServers() { return {ok: true, devices: [], language: 'zh-CN'}; },
        async runtimeState() { return {ok: true, engines: structuredClone(rows)}; },
        async runtimeCheckUpdates() {
          calls.checks++;
          const engines = rows.map(row => ({id: row.id, installed: row.version, latest: '2.0.0',
            checkable: true, updateAvailable: row.id !== 'codex' && row.version !== '2.0.0', error: row.id === 'dsh' ? 'offline' : null}));
          if (window.holdCheck) await new Promise(resolve => { window.finishCheck = resolve; });
          if (window.failCheck) throw new Error('offline');
          return {ok: true, engines};
        },
        async openSettingsWindow(target) { calls.settings.push(target); return {ok: true}; },
        async switchMode(mode) { calls.launches.push(mode); return {ok: true, canceled: true}; }
      };
    """)
    page.goto((repo / 'src/renderer/home/home.html').as_uri(), wait_until='networkidle')
    badge = page.locator('[data-runtime-update=claude]')
    expect(badge).to_be_visible()
    expect(badge).to_contain_text('有更新')
    expect(badge).to_have_attribute('title', 'Claude Code runtime：v1.0.0 → v2.0.0。查看更新')
    expect(page.locator('.runtime-update:visible')).to_have_count(1)
    expect(page.locator('.harness-card .entry-description')).to_have_count(0)
    badge.click()
    assert page.evaluate('calls.settings') == [{'page': 'engines', 'engine': 'claude', 'focus': 'updates'}]
    assert page.evaluate('calls.launches') == []
    page.evaluate("rows[0].updating = true; runtimeChanged(structuredClone(rows))")
    expect(page.locator('#enterClaude')).to_be_disabled()
    expect(badge).to_be_hidden()
    page.evaluate("rows[0].updating = false; runtimeChanged(structuredClone(rows))")
    expect(badge).to_be_visible()
    page.locator('#enterClaude').click()
    expect(page.locator('#enterClaude')).to_be_enabled()
    assert page.evaluate('calls.launches') == ['claude']
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.wait_for_function('!checkingRuntimeUpdates')
    assert page.evaluate('calls.checks') == 1, 'Focus should reuse a recent check'

    screenshots = repo / 'dist/home-runtime-updates-qa'
    screenshots.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(screenshots / 'home-zh.png'), full_page=True)
    page.evaluate("CamelliaI18n.setLanguage('en')")
    expect(badge).to_contain_text('Update available')
    expect(badge).to_have_attribute('title', 'Claude Code runtime: v1.0.0 → v2.0.0. View update')
    for scheme in ['light', 'dark']:
        page.emulate_media(color_scheme=scheme)
        for width in [1100, 720, 375, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            icon = page.locator('#enterClaude .agent-symbol').bounding_box()
            update = badge.bounding_box()
            title = page.locator('#enterClaude .entry-title').bounding_box()
            assert update['x'] >= icon['x'] + icon['width']
            assert update['y'] + update['height'] <= title['y'], 'Badge must not overlap the engine name'
        page.screenshot(path=str(screenshots / f'home-mobile-{scheme}.png'), full_page=True)

    # An update completed in Settings must clear the stale reminder on return.
    page.evaluate("rows[0].version = '2.0.0'; window.dispatchEvent(new Event('focus'))")
    expect(badge).to_be_hidden()
    page.wait_for_function('calls.checks === 2 && !checkingRuntimeUpdates')
    expect(badge).to_be_hidden()
    # No stale registry response may revive a reminder after the runtime changes.
    page.evaluate("rows[0].version = '1.0.0'; holdCheck = true; window.dispatchEvent(new Event('focus'))")
    page.wait_for_function('typeof window.finishCheck === "function"')
    page.evaluate("rows[0].status = 'missing'; runtimeChanged(structuredClone(rows)); finishCheck()")
    page.wait_for_function('!checkingRuntimeUpdates')
    expect(badge).to_be_hidden()
    # Registry failure leaves launch status intact and never reports an update.
    page.evaluate("holdCheck = false; failCheck = true; rows[0].status = 'ready'; document.getElementById('homeStatus').textContent = 'Launch error'; runtimeChanged(structuredClone(rows))")
    page.wait_for_function('!checkingRuntimeUpdates')
    expect(page.locator('.runtime-update:visible')).to_have_count(0)
    expect(page.locator('#homeStatus')).to_have_text('Launch error')
    assert not errors, errors
    browser.close()
print('Home runtime reminders: filtering, navigation, refresh, races, failure, languages and responsive layout passed')
