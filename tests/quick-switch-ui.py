"""The model pill applies its configured model and reasoning level in one gesture."""
import ast
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
bridge = next(ast.literal_eval(node.value) for node in ast.walk(module)
              if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'swap_bridge'
                                                   for target in node.targets))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 820})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&new=1', wait_until='networkidle')
    page.wait_for_function('uiReady')

    page.locator('#modelPill').click()
    page.locator('.pop-row').first.click()
    page.locator('.dsh-pop').last.locator('.pop-opt').get_by_text('model-c', exact=True).click()
    expect(page.locator('#modelPillName')).to_have_text('model-c')

    before = page.evaluate('window.actions.length')
    page.locator('#modelPill').dblclick()
    expect(page.locator('#modelPillName')).to_have_text('model-b')
    expect(page.locator('#modelPillLevel')).to_have_text('High')
    saves = page.evaluate("start => window.actions.slice(start).filter(item => item.action === 'save-settings').map(item => item.payload)", before)
    assert len(saves) == 1, saves
    assert saves[0]['model'] == 'model-b' and saves[0]['thinkingBudget'] == 'high', saves

    page.evaluate("window.quickSwitchModels = {codex:'model-a'}; window.quickSwitchLevels = {codex:'low'}")
    before = page.evaluate('window.actions.length')
    page.locator('#modelPill').dblclick()
    expect(page.locator('#modelPillName')).to_have_text('model-a')
    expect(page.locator('#modelPillLevel')).to_have_text('Low')
    saves = page.evaluate("start => window.actions.slice(start).filter(item => item.action === 'save-settings').map(item => item.payload)", before)
    assert len(saves) == 1, saves
    assert saves[0]['model'] == 'model-a' and saves[0]['thinkingBudget'] == 'low', saves

    assert not errors, errors
    browser.close()

print('PASS: each model-pill double-click saves and displays the configured model and reasoning level together')
