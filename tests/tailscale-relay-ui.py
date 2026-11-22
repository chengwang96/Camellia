"""An existing relay grant stays enabled across the real service's cached state reads."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = """(() => {
  const control = async (action, payload) => {
    if (action === 'tailscale-apply-peer-relay' || action === 'tailscale-rename-device') {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return window.relayCommand({ action, payload });
  };
  window.dshDesktop = { remoteControl: control };
  window.camelliaRemote = { control };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for embedded, language in [(True, 'en'), (False, 'zh')]:
            process = subprocess.Popen(
                ['node', str(repo / 'tests/fixtures/tailscale-relay-service.cjs'), language],
                cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            page = browser.new_page(viewport={'width': 760, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))

            def command(_source, request):
                process.stdin.write(json.dumps(request) + '\n')
                process.stdin.flush()
                line = process.stdout.readline()
                if not line:
                    raise AssertionError('Relay service ended: ' + process.stderr.read())
                return json.loads(line)

            try:
                page.expose_binding('relayCommand', command)
                page.add_init_script(bridge)
                target = 'tests/fixtures/mobile-access-settings-host.html' if embedded else 'src/renderer/remote/remote.html'
                prefix = 'mobile-' if embedded else ''
                node = lambda name: page.locator('#' + prefix + name)
                page.goto((repo / target).as_uri())
                page.wait_for_load_state('networkidle')
                if embedded:
                    page.evaluate('window.mobileAccessUI.setVisible(true)')
                expect(page.locator('.network-path > .device-heading')).to_have_count(0)
                expect(node('relayUse')).to_be_enabled()
                expect(node('relayUse')).not_to_be_checked()
                node('relayUse').check()
                expect(node('relayUse')).to_be_disabled()
                expect(node('relayStatus')).to_have_text('Validating and applying…' if language == 'en' else '正在验证并应用…')
                expect(node('relayUse')).to_be_enabled()
                expect(node('relayUse')).to_be_checked()
                expect(node('relayChoice')).to_be_visible()
                # Exercise two automatic state polls, then a new renderer.
                page.wait_for_timeout(10500)
                expect(node('relayUse')).to_be_checked()
                expect(node('relayStatus')).to_be_hidden()
                page.reload()
                page.wait_for_load_state('networkidle')
                if embedded:
                    page.evaluate('window.mobileAccessUI.setVisible(true)')
                expect(node('relayUse')).to_be_checked()
                expect(node('relayDevice')).to_have_value('relay1')
                # Edit in the same field; polling must not replace a draft.
                node('relayRename').click()
                expect(node('relayDevice')).to_be_hidden()
                expect(node('relayName')).to_have_value('izwz94tkwtju32rm6f4f9mz')
                node('relayName').fill('draft-name')
                page.evaluate('window.mobileAccessUI.refresh()')
                expect(node('relayName')).to_have_value('draft-name')
                node('relayName').press('Escape')
                expect(node('relayName')).to_be_hidden()
                node('relayRename').click()
                node('relayName').fill('bad name')
                node('relayName').press('Enter')
                expect(node('relayName')).to_have_attribute('aria-invalid', 'true')
                assert command(None, {'action': 'test-rename-mode', 'payload': {'mode': 'timeout-before'}})['result']['renameWrites'] == 0
                node('relayName').fill('aliyun')
                node('relayName').press('Enter')
                expect(node('relayName')).to_be_disabled()
                expect(node('relayName')).to_be_enabled()
                expect(node('relayStatus')).to_have_text('The rename could not be confirmed. Try again shortly.' if language == 'en' else '重命名尚未确认，请稍后重试。')
                expect(node('relayName')).to_have_value('aliyun')
                page.evaluate('window.mobileAccessUI.refresh()')
                expect(node('relayName')).to_have_value('aliyun')
                assert command(None, {'action': 'test-rename-mode', 'payload': {'mode': 'timeout-after'}})['result']['renameWrites'] == 1
                node('relayRenameSave').click()
                expect(node('relayName')).to_be_hidden()
                expect(node('relayDevice').locator('option:checked')).to_have_text('aliyun · 100.64.0.9')
                expect(node('relayUse')).to_be_checked()
                expect(node('relayStatus')).to_have_text('Relay name saved.' if language == 'en' else '中继名称已保存。')
                # The OS hostname never changes; edit the canonical device name.
                node('relayRename').click()
                expect(node('relayName')).to_have_value('aliyun')
                node('relayRenameCancel').click()
                assert command(None, {'action': 'test-rename-mode', 'payload': {'mode': 'read-failure'}})['result']['renameWrites'] == 2
                node('relayRename').click()
                node('relayName').fill('aliyun-2')
                node('relayName').press('Enter')
                expect(node('relayName')).to_be_hidden()
                expect(node('relayDevice')).to_contain_text('aliyun-2')
                expect(node('relayUse')).to_be_checked()
                expect(node('relayStatus')).to_have_text('Name saved; device details could not be refreshed.' if language == 'en' else '名称已保存，暂时无法刷新设备信息。')
                for width in [760, 480]:
                    page.set_viewport_size({'width': width, 'height': 900})
                    node('relayRename').click()
                    layout = page.evaluate("""prefix => {
                      const box = name => document.getElementById(prefix + name).getBoundingClientRect();
                      return { inputRight: box('relayName').right, saveLeft: box('relayRenameSave').left,
                        cancelRight: box('relayRenameCancel').right, cardRight: document.querySelector('.network-path').getBoundingClientRect().right,
                        overflow: document.documentElement.scrollWidth > innerWidth };
                    }""", prefix)
                    assert layout['inputRight'] < layout['saveLeft'], layout
                    assert layout['cancelRight'] < layout['cardRight'], layout
                    assert not layout['overflow'], layout
                    page.screenshot(path=str(repo / f'.tmp-relay-inline-{"settings" if embedded else "panel"}-{width}.png'), full_page=True)
                    node('relayName').press('Escape')
                assert not errors, errors
                print(('Embedded settings' if embedded else 'Standalone panel') + ': relay persistence, inline rename, cancellation, validation, timeout recovery and narrow layout passed')
            finally:
                page.close()
                if process.poll() is None:
                    process.stdin.write('{"action":"close"}\n')
                    process.stdin.flush()
                    process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                assert process.returncode == 0, process.stderr.read()
    finally:
        browser.close()
