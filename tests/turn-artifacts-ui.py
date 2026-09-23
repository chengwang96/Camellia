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
         for name, kind in [('main.js', 'text'), ('实验报告.docx', 'word'), ('report.MD', 'text'), ('report.html', 'text'),
                            ('figure.svg', 'image'), ('slides.pptx', 'presentation'), ('results.xlsx', 'spreadsheet'), ('test.js', 'text')]]
packages = [{'path': 'C:/outputs/Camellia-Android-debug.apk', 'name': 'Camellia-Android-debug.apk',
             'extension': 'APK', 'kind': 'package', 'size': 46689292}]
fixture['messages'][-1]['artifacts'] = files
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge += r"""(() => {
  const files = FILES;
  const packages = PACKAGES;
  const all = [...packages, ...files];
  window.resolveRequests = [];
  window.openedExternally = [];
  window.revealed = [];
  window.dshDesktop.platform = 'win32';
  window.dshDesktop.resolveArtifacts = async request => {
    resolveRequests.push(request);
    return {ok:true,files:all.filter(file => request.paths?.includes(file.path))};
  };
  window.dshDesktop.previewFile = async path => {
    const file = all.find(item => item.path === path);
    const preview = {...file, url:'file:///' + path,
      text:path.endsWith('.MD') ? '# Report\n\n**Readable**\n\n| Name | Value |\n| --- | --- |\n| Result | 42 |\n\n```js\nconst value = 1;\n```\n<script>window.previewEscaped=true</script>'
        : '<h1>HTML report</h1><style>h1 { color: rgb(12, 34, 56); }</style><script>parent.previewEscaped=true</script><img src="missing.png" onerror="parent.previewEscaped=true"><a href="https://example.com" target="_top">Escape</a>'};
    if (['word', 'presentation', 'spreadsheet'].includes(file.kind))
      preview.office = {sections:[{title:'Report',paragraphs:['Preview content']}],truncated:false};
    return {ok:true,file:preview};
  };
  window.dshDesktop.openFileExternally = async path => { openedExternally.push(path); return {ok:true}; };
  window.dshDesktop.revealFile = async path => { revealed.push(path); return {ok:true}; };
})();""".replace('FILES', json.dumps(files)).replace('PACKAGES', json.dumps(packages))
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
        expect(cards.locator('.artifact-row')).to_have_count(8)
        expect(cards.locator('.artifact-row:visible')).to_have_count(4)
        assert cards.locator('.artifact-file strong').all_text_contents() == [
            'report.MD', 'report.html', 'figure.svg', 'slides.pptx', '实验报告.docx', 'results.xlsx', 'main.js', 'test.js']
        expect(cards.locator('summary')).to_have_text('Show 4 more filesShow fewer files')
        cards.locator('.artifact-file').first.click()
        expect(page.locator('#fileViewer')).to_be_visible()
        expect(page.locator('.file-preview-markdown h1')).to_have_text('Report')
        expect(page.locator('.file-preview-markdown strong')).to_have_text('Readable')
        expect(page.locator('.file-preview-markdown td').last).to_have_text('42')
        expect(page.locator('.file-preview-markdown pre code')).to_have_text('const value = 1;')
        assert page.evaluate('window.previewEscaped') is None
        page.screenshot(path=str(preview / f'markdown-preview-{theme}.png'), animations='disabled')
        page.locator('#fileViewerClose').click()
        cards.locator('.artifact-file').nth(1).click()
        frame = page.frame_locator('.file-preview-html')
        expect(frame.locator('h1')).to_have_text('HTML report')
        expect(frame.locator('h1')).to_have_css('color', 'rgb(12, 34, 56)')
        expect(page.locator('.file-preview-html')).to_have_attribute('sandbox', '')
        assert page.evaluate('window.previewEscaped') is None
        original_url = page.url
        frame.locator('a').click()
        assert page.url == original_url
        page.screenshot(path=str(preview / f'html-preview-{theme}.png'), animations='disabled')
        page.locator('#fileViewerClose').click()
        cards.locator('summary').focus()
        page.keyboard.press('Enter')
        expect(cards.locator('.artifact-row:visible')).to_have_count(8)
        cards.locator('.artifact-file').nth(4).click()
        expect(page.locator('.office-preview-section')).to_contain_text('Preview content')
        page.locator('#fileViewerClose').click()
        cards.locator('.artifact-file').nth(6).click()
        expect(page.locator('.file-preview-text')).to_contain_text('<h1>HTML report</h1>')
        expect(page.locator('#fileViewerBody iframe')).to_have_count(0)
        page.locator('#fileViewerClose').click()
        cards.locator('summary').click()
        expect(cards.locator('.artifact-row:visible')).to_have_count(4)
        menu = cards.locator('.artifact-open').first
        menu.click()
        expect(page.get_by_role('menuitem')).to_have_count(3)
        page.keyboard.press('Escape')
        expect(menu).to_be_focused()
        menu.click()
        page.get_by_role('menuitem').nth(1).click()
        assert page.evaluate('openedExternally') == [files[2]['path']]
        menu.click()
        page.get_by_role('menuitem').nth(2).click()
        assert page.evaluate('revealed') == [files[2]['path']]
        menu.click()
        page.get_by_role('menuitem').first.click()
        expect(page.locator('#fileViewer')).to_be_visible()
        page.locator('#fileViewerClose').click()
        page.evaluate("changeLanguage('zh-CN')")
        expect(menu).to_have_text('打开方式')
        expect(cards.locator('.artifact-show-more')).to_have_text('展开其余 4 个文件')
        menu.click()
        expect(page.get_by_role('menuitem').first).to_have_text('在 Camellia 内打开')
        expect(page.get_by_role('menuitem').nth(1)).to_have_text('使用系统默认软件打开')
        expect(page.get_by_role('menuitem').last).to_have_text('在文件资源管理器中显示')
        page.keyboard.press('Escape')
        page.screenshot(path=str(preview / f'turn-artifacts-{theme}.png'))
        page.evaluate("""files => {
          window.emit = event => deliverEvent({session_id:'shared-fixture',engine:'codex',runId:901,...event});
          emit({type:'conversation:started',prompt:'Create files',userSeq:3});
          emit({type:'assistant',message:{content:[{type:'text',text:'Your files are ready.'}]}});
          emit({type:'result',subtype:'success',artifacts:files});
        }""", files)
        expect(page.locator('.turn').last.locator('.artifact-row')).to_have_count(8)
        expect(page.locator('.turn').last.locator('.artifact-row:visible')).to_have_count(4)
        assert page.locator('.turn').last.locator('.turn-artifacts + .run-result').count() == 1
        page.evaluate("""() => {
          emit({type:'conversation:started',runId:902,prompt:'Thanks',userSeq:4});
          emit({type:'assistant',runId:902,message:{content:[{type:'text',text:'Welcome.'}]}});
          emit({type:'result',runId:902,subtype:'success',artifacts:[]});
        }""")
        expect(page.locator('.turn').last.locator('.artifact-row')).to_have_count(0)
        assert page.locator('.turn-artifacts').count() == 2
        page.evaluate("""files => {
          emit({type:'conversation:started',runId:903,prompt:'Four files',userSeq:5});
          emit({type:'assistant',runId:903,message:{content:[{type:'text',text:'Ready.'}]}});
          emit({type:'result',runId:903,subtype:'success',artifacts:files.slice(0,4)});
        }""", files)
        expect(page.locator('.turn').last.locator('.artifact-row:visible')).to_have_count(4)
        expect(page.locator('.turn').last.locator('details')).to_have_count(0)
        page.evaluate("""() => {
          const preview = window.dshDesktop.previewFile;
          window.dshDesktop.previewFile = async path => {
            const result = await preview(path); result.file.truncated = true; return result;
          };
        }""")
        page.locator('.turn').last.locator('.artifact-file').first.click()
        expect(page.locator('.file-preview-notice')).to_be_visible()
        page.locator('#fileViewerClose').click()
        page.evaluate("""deliverables => {
          emit({type:'conversation:started',runId:904,prompt:'Build the Android app',userSeq:6});
          emit({type:'assistant',runId:904,message:{content:[{type:'text',text:'Built the APK.'}]}});
          emit({type:'result',runId:904,subtype:'success',artifacts:deliverables});
        }""", packages + files[:1])
        rows = page.locator('.turn').last.locator('.artifact-row')
        expect(rows).to_have_count(2)
        assert rows.locator('.artifact-info strong').all_text_contents() == ['Camellia-Android-debug.apk', 'main.js']
        expect(rows.first.locator('.artifact-info > span')).to_contain_text('安装包')
        expect(rows.first.locator('.artifact-icon')).to_have_text('APK')
        rows.first.locator('.artifact-file').click()
        expect(page.locator('.file-preview-empty')).to_contain_text('Camellia 暂不支持预览此文件类型。')
        page.screenshot(path=str(preview / f'turn-artifacts-package-{theme}.png'), animations='disabled')
        page.locator('#fileViewerClose').click()
        page.close()
    browser.close()
    assert not errors, errors
print('Turn artifact UI checks passed')
