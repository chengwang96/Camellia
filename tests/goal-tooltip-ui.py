"""A running Goal keeps its hover hint stable while elapsed time refreshes."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in source.body
               if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in source.body
                   if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1100, 'height': 850})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri()
              + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady && !loadingSession')
    objective = 'Verify the completed work without interrupting the running conversation'
    page.evaluate("""objective => {
      currentGoal = {
        id: 'goal-tooltip', sessionId: context.sessionId, objective,
        phase: 'active', armed: true, verifying: true,
        elapsedMs: 125000, activeSince: Date.now(), roundsStarted: 2,
      };
      deliverGoal({sessionId: context.sessionId, goal: currentGoal});
    }""", objective)

    chip = page.locator('#goalChipRow .goal-chip').first
    expect(chip).to_contain_text('Verifying…')
    chip.evaluate("element => { element.dataset.originalNode = 'kept'; }")
    chip.hover()
    tooltip = page.locator('#camelliaTooltip')
    expect(tooltip).to_be_visible()
    expect(tooltip).to_have_text(objective)

    page.wait_for_timeout(1400)
    assert chip.evaluate("element => element.dataset.originalNode") == 'kept'
    expect(tooltip).to_be_visible()
    expect(tooltip).to_have_text(objective)
    assert not errors, errors
    page.close()
    browser.close()

print('PASS: Goal hover hint stays open while its status refreshes')
