"""Exercise indexed history paging through the real desktop IPC and renderer."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/desktop-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/desktop-ui.py')}
for statement in tree.body:
    if isinstance(statement, (ast.With, ast.Try)):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<desktop-fixture>', 'exec'), scope)

rpc, driver = scope['rpc'], scope['driver']
try:
    session_id = rpc('seedLongHistory', {'count': 10000})['result']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1200, 'height': 820})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(scope['bridge'])
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=claude', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate('(id) => openHistorySession(id)', session_id)
        expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(100)
        expect(page.locator('.history-earlier')).to_have_count(1)
        baseline = rpc('historyMetrics')['result']
        page.locator('.history-earlier').click()
        page.wait_for_function('!document.querySelector(".history-earlier").disabled')
        expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(200)
        texts = page.locator('#chat > .msg-user .bubble, #chat > .turn .md').all_text_contents()
        assert texts == [f'History message {i}' for i in range(9800, 10000)], texts[:5]
        after = rpc('historyMetrics')['result']
        assert after['parsedRows'] - baseline['parsedRows'] <= 100
        assert after['historyBytes'] - baseline['historyBytes'] < 20000
        assert after['cacheBytes'] <= 16 * 1024 * 1024

        # An already opened conversation can be reloaded from the same index.
        page.evaluate('(id) => openHistorySession(id)', session_id)
        expect(page.locator('#chat > .msg-user, #chat > .turn')).to_have_count(100)
        warm = rpc('historyMetrics')['result']
        assert warm['parsedRows'] == after['parsedRows']
        assert warm['historyBytes'] == after['historyBytes']
        assert not errors, errors
        browser.close()
    print('PASS real desktop IPC: 10,000-message paging, cached reload and bounded history cache')
finally:
    try:
        rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
