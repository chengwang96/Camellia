"""Failed sends reuse a committed user message and keep an uncommitted draft editable."""
import ast
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge'].replace('window.fixturePreferences =',
    'fixture.messages[0].seq=1; fixture.messages[0].at=Date.now(); window.fixturePreferences =')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('.msg-user')).to_have_count(1)
    page.evaluate('''() => {
      const user = document.querySelector('.msg-user').messageData;
      showFailedSend({text: user.text, at: user.at, error: 'Engine unavailable'});
    }''')
    expect(page.locator('.msg-user')).to_have_count(1)
    expect(page.locator('.failed-send')).to_contain_text('Engine unavailable')
    page.locator('.failed-send button').click()
    expect(page.locator('.message-editor')).to_be_visible()
    expect(page.locator('.msg-user')).to_have_count(1)
    page.locator('.message-editor button', has_text='Cancel').click()

    page.evaluate("showFailedSend({text:'New attempt',at:Date.now(),error:'Connection failed'})")
    expect(page.locator('.msg-user')).to_have_count(2)
    page.locator('.failed-send button').click()
    expect(page.locator('#input')).to_have_value('New attempt')
    expect(page.locator('.msg-user')).to_have_count(1)
    assert not errors, errors
    browser.close()

print('Failed send UI checks passed')
