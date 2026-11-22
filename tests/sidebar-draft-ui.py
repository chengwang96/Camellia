"""A saved composer draft uses the sidebar's existing status slot. No model calls."""
import ast
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 960, 'height': 700})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri()
              + '?harness=claude&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady')
    status = page.locator('[data-sid="shared-fixture"] .session-item-time')
    expect(status).not_to_have_text('Draft')
    ordinary_color = status.evaluate('(element) => getComputedStyle(element).color')
    page.evaluate("""() => {
      window.initialDraftRow = document.querySelector('[data-sid="shared-fixture"]');
      window.draftReadKeys = [];
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        if (String(key).startsWith('camellia-chat-draft:')) draftReadKeys.push(String(key));
        return read.call(this, key);
      };
    }""")

    page.locator('#input').fill('Unsent draft')
    expect(status).to_have_text('Draft')
    assert page.evaluate('initialDraftRow === document.querySelector(\'[data-sid="shared-fixture"]\')'), 'Draft status rebuilt the conversation row'
    assert page.evaluate('draftReadKeys.every(key => key === "camellia-chat-draft:shared-fixture")'), page.evaluate('draftReadKeys')
    assert 'is-draft' in status.get_attribute('class')
    assert status.evaluate('(element) => getComputedStyle(element).color') != ordinary_color
    page.locator('#input').fill('')
    expect(status).not_to_have_text('Draft')
    assert 'is-draft' not in status.get_attribute('class')
    assert status.evaluate('(element) => getComputedStyle(element).color') == ordinary_color

    page.evaluate('addAttachments(["D:/Fixture/attachment-only.txt"])')
    expect(status).to_have_text('Draft')
    assert 'is-draft' in status.get_attribute('class')
    page.locator('#attachRow .attchip-x').first.click()
    expect(status).not_to_have_text('Draft')
    assert 'is-draft' not in status.get_attribute('class')

    page.evaluate('CamelliaI18n.setLanguage("zh-CN")')
    page.locator('#input').fill('中文草稿')
    expect(status).to_have_text('草稿')
    page.locator('#input').fill('')
    expect(status).not_to_have_text('草稿')

    assert not errors, errors
    browser.close()
    print('Sidebar draft status checks passed')
