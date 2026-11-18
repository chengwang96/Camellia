"""A single enormous Markdown paragraph must not monopolize the renderer."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'fixture' for t in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == 'bridge' for t in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const text = '# One block' + String.fromCharCode(10, 10)
    + 'single long block with **bold** and [link](https://example.com). '.repeat(20000);
  window.dshDesktop.previewFile = async path => ({
    ok: true,
    file: { name: 'one-block.md', path, url: 'file:///' + path, kind: 'text', extension: 'MD',
      text, size: 1600000 }
  });
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate("""() => {
      window.longTasks = [];
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    }""")
    page.evaluate("async () => { await openFilePreview('C:/project/one-block.md'); }")
    expect(page.locator('.file-preview-markdown h1')).to_have_text('One block')
    expect(page.locator('.file-preview-markdown strong').first).to_be_visible()
    expect(page.locator('.file-preview-markdown a').first).to_have_attribute('target', '_blank')
    longest = page.evaluate('Math.max(0, ...longTasks)')
    print('longest long task (ms):', longest, flush=True)
    assert longest < 1500, longest
    page.locator('#fileViewerClose').click()
    assert not errors, errors
    browser.close()
print('PASS: a single large Markdown block leaves the renderer responsive')
