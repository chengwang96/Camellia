"""Preview image attachment drops in the real renderer, without model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in fixture_module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in fixture_module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
image_path = 'C:/outputs/实验 image #1.png'
image_file = {'path': image_path, 'name': '实验 image #1.png', 'extension': 'PNG', 'kind': 'image', 'size': 68}
fixture['messages'][-1]['artifacts'] = [image_file]
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const file = IMAGE_FILE;
  window.dshDesktop.resolveArtifacts = async () => ({ok:true,files:[file]});
  window.dshDesktop.previewFile = async () => ({ok:true,file:{...file,
    url:'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="green"/></svg>')}});
  window.dshDesktop.attachmentPath = file => 'C:/external/' + file.name;
})();""".replace('IMAGE_FILE', json.dumps(image_file))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for engine in ['codex', 'antigravity']:
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + f'?harness={engine}&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('.artifact-file').click()
        image = page.locator('.file-preview-image img')
        expect(image).to_have_attribute('draggable', 'true')
        page.locator('#input').fill('Keep this draft')
        image.drag_to(page.locator('#input'))
        chips = page.locator('#attachRow .attchip')
        expected_count = 1 if engine == 'codex' else 0
        expect(chips).to_have_count(expected_count)
        expect(page.locator('#input')).to_have_value('Keep this draft')
        expect(page.locator('#inputCard')).not_to_have_class('input-card dragging')
        if expected_count:
            expect(chips.first).to_have_attribute('title', image_path)
            expect(chips.first.locator('.attchip-name')).to_have_text(image_file['name'])
            image.drag_to(page.locator('#input'))
            expect(chips).to_have_count(1)
            chips.first.locator('.attchip-x').click()
            expect(chips).to_have_count(0)
        else:
            expect(page.locator('body')).to_contain_text('Antigravity currently supports text and code attachments.')
        page.evaluate("""() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(['hello'], 'notes.txt', {type:'text/plain'}));
          document.getElementById('inputCard').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
        }""")
        expect(chips).to_have_count(1)
        expect(chips.first).to_have_attribute('title', 'C:/external/notes.txt')
        page.evaluate("""() => {
          const transfer = new DataTransfer();
          transfer.setData('text/uri-list', 'https://example.com/image.png');
          document.getElementById('inputCard').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
        }""")
        expect(chips).to_have_count(1)
        expect(page.locator('#input')).to_have_value('Keep this draft')
        page.close()
    browser.close()
    assert not errors, errors
print('PASS: preview image drag, deduplication, image restrictions, external files, and draft preservation')
