"""Exercise VS Code preferences through the real settings renderer and IPC."""
import argparse
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--screenshot', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
driver = subprocess.Popen(['node', str(repo / 'tests/desktop-ui-driver.cjs')], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')


def rpc(method, payload=None):
    driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
    driver.stdin.flush()
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError('Test driver exited: ' + driver.stderr.read())
    response = json.loads(line)
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response['result']


try:
    fixtures = rpc('fixtures')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 850})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script("""
          window.dshDesktop = new Proxy({}, { get: (_, method) => {
            if (method === 'platform') return 'win32';
            if (method.startsWith('on')) return () => () => {};
            return payload => testRpc(method, payload);
          }});
        """)
        page.goto((repo / 'src/renderer/settings/api-settings.html').as_uri(), wait_until='networkidle')
        choice = page.locator('#vscodeChoice')
        expect(choice).to_have_value('')
        expect(page.locator('#vscodeDetectedPath')).to_have_count(0)
        assert fixtures['vscode'] not in page.locator('.vscode-setting').inner_text()
        assert fixtures['vscode'] not in (choice.get_attribute('title') or '')
        layout = page.evaluate("""() => {
          const row = document.querySelector('.vscode-setting');
          return {
            copy: row.firstElementChild.getBoundingClientRect().width,
            controls: row.querySelector('.vscode-controls').getBoundingClientRect().width,
            select: row.querySelector('#vscodeChoice').getBoundingClientRect().width,
          };
        }""")
        assert layout['controls'] <= 280.5, layout
        assert layout['select'] <= 280.5, layout
        assert layout['copy'] > layout['controls'], layout
        option_values = choice.locator('option').evaluate_all('options => options.map(option => option.value)')
        assert fixtures['vscode'] in option_values
        assert fixtures['vscodeInsiders'] in option_values

        choice.select_option(fixtures['vscodeInsiders'])
        expect(page.locator('#status')).to_have_text('Preferences saved')
        assert rpc('workbenchSettings')['vscodePath'] == fixtures['vscodeInsiders']
        page.reload(wait_until='networkidle')
        expect(choice).to_have_value(fixtures['vscodeInsiders'])
        expect(page.locator('#vscodeCustomPath')).to_be_hidden()

        choice.select_option('__custom__')
        custom = page.locator('#vscodePath')
        expect(custom).to_be_visible()
        custom.fill('relative/Code.exe')
        custom.press('Tab')
        expect(page.locator('#status')).to_have_text('Use an absolute path for the VS Code executable.')
        expect(custom).to_have_value('relative/Code.exe')
        assert rpc('workbenchSettings')['vscodePath'] == fixtures['vscodeInsiders']

        custom.fill(fixtures['vscodeCustom'])
        custom.press('Tab')
        expect(page.locator('#status')).to_have_text('Preferences saved')
        assert rpc('workbenchSettings')['vscodePath'] == fixtures['vscodeCustom']
        page.reload(wait_until='networkidle')
        expect(choice).to_have_value('__custom__')
        expect(custom).to_have_value(fixtures['vscodeCustom'])

        page.locator('#chooseVscodePath').click()
        expect(page.locator('#status')).to_have_text('Preferences saved')
        expect(choice).to_have_value(fixtures['vscodeInsiders'])
        assert rpc('workbenchSettings')['vscodePath'] == fixtures['vscodeInsiders']
        choice.select_option('')
        expect(page.locator('#status')).to_have_text('Preferences saved')
        assert rpc('workbenchSettings')['vscodePath'] == ''
        assert fixtures['vscode'] not in page.locator('.vscode-setting').inner_text()
        assert fixtures['vscode'] not in (choice.get_attribute('title') or '')

        page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
        expect(choice.locator('option[value=""]')).to_have_text('自动检测')
        expect(page.locator('.vscode-setting .hint').first).to_have_text('选择用于打开工作区的已安装版本，或输入可执行文件的绝对路径。')
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.screenshot), full_page=True)
        page.set_viewport_size({'width': 620, 'height': 800})
        choice.select_option('__custom__')
        expect(page.locator('#vscodeCustomPath')).to_be_visible()
        container = page.locator('#vscodeCustomPath').bounding_box()
        button = page.locator('#chooseVscodePath').bounding_box()
        assert button['x'] + button['width'] <= container['x'] + container['width'] + 1
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        if args.screenshot:
            page.screenshot(path=str(args.screenshot.with_name(args.screenshot.stem + '-narrow.png')), full_page=True)
        assert not errors, errors
        browser.close()
        print('VS Code settings UI: detect, select, persist, validate, browse, translate and narrow layout passed')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
