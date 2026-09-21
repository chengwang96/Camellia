"""Turn artifact cards and both open actions in the real renderer, without model calls."""
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
files = [{'path': 'C:/outputs/' + name, 'name': name, 'extension': name.split('.')[-1].upper(), 'kind': kind, 'size': 1536}
         for name, kind in [('实验报告.docx', 'word'), ('figure.svg', 'image'), ('results.xlsx', 'spreadsheet'), ('slides.pptx', 'presentation')]]
fixture['messages'][-1]['artifacts'] = files
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge += r"""(() => {
  const files = FILES;
  window.resolveRequests = [];
  window.openedExternally = [];
  window.dshDesktop.resolveArtifacts = async request => {
    resolveRequests.push(request);
    return {ok:true,files:files.filter(file => request.paths?.includes(file.path))};
  };
  window.dshDesktop.previewFile = async path => ({ok:true,file:{...files.find(file=>file.path===path),
    office:{sections:[{title:'Report',paragraphs:['Preview content']}],truncated:false}}});
  window.dshDesktop.openFileExternally = async path => { openedExternally.push(path); return {ok:true}; };
})();""".replace('FILES', json.dumps(files))
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for theme, width in [('light', 1440), ('dark', 960)]:
        page = browser.new_page(viewport={'width': width, 'height': 900}, color_scheme=theme)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        cards = page.locator('.turn-artifacts')
        expect(cards.locator('.artifact-row')).to_have_count(4)
        cards.locator('.artifact-file').first.click()
        expect(page.locator('#fileViewer')).to_be_visible()
        expect(page.locator('.office-preview-section')).to_contain_text('Preview content')
        page.locator('#fileViewerClose').click()
        menu = cards.locator('.artifact-open').first
        menu.click()
        expect(page.get_by_role('menuitem')).to_have_count(2)
        page.keyboard.press('Escape')
        expect(menu).to_be_focused()
        menu.click()
        page.get_by_role('menuitem').last.click()
        assert page.evaluate('openedExternally') == [files[0]['path']]
        menu.click()
        page.get_by_role('menuitem').first.click()
        expect(page.locator('#fileViewer')).to_be_visible()
        page.locator('#fileViewerClose').click()
        page.evaluate("changeLanguage('zh-CN')")
        expect(menu).to_have_text('打开方式')
        menu.click()
        expect(page.get_by_role('menuitem').first).to_have_text('在 Camellia 内打开')
        expect(page.get_by_role('menuitem').last).to_have_text('使用系统默认软件打开')
        page.keyboard.press('Escape')
        page.screenshot(path=str(preview / f'turn-artifacts-{theme}.png'))
        page.evaluate("""files => {
          window.emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:901,...event});
          emit({type:'conversation:started',prompt:'Create files',userSeq:3});
          emit({type:'assistant',message:{content:[{type:'text',text:'Your files are ready.'}]}});
          emit({type:'result',subtype:'success',artifacts:files});
        }""", files)
        expect(page.locator('.turn').last.locator('.artifact-row')).to_have_count(4)
        assert page.locator('.turn').last.locator('.turn-artifacts + .run-result').count() == 1
        page.evaluate("""() => {
          emit({type:'conversation:started',runId:902,prompt:'Thanks',userSeq:4});
          emit({type:'assistant',runId:902,message:{content:[{type:'text',text:'Welcome.'}]}});
          emit({type:'result',runId:902,subtype:'success',artifacts:[]});
        }""")
        expect(page.locator('.turn').last.locator('.artifact-row')).to_have_count(0)
        assert page.locator('.turn-artifacts').count() == 2
        page.close()
    browser.close()
    assert not errors, errors
print('Turn artifact UI checks passed')
