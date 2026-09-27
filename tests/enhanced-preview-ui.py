import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
screenshots = root / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
module = ast.parse((root / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
files = [dict(name=name, path='C:/outputs/' + name, extension=name.split('.')[-1], kind='text', size=1024) for name in ['math.md', 'rows.csv', 'rows.tsv', 'data.json', 'bad.json', 'large.json']]
fixture['messages'][-1]['artifacts'] = files
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
texts = {
    'math.md': '# Math\n\nInline $x^2$.[^note]\n\n$$\n\\frac{1}{2}\n$$\n\n```js\nconst answer = 42;\n```\n\n[^note]: Footnote body.',
    'rows.csv': 'name,value\n' + '\n'.join(f'row-{index},{index}' for index in range(205)),
    'rows.tsv': 'name\tvalue\nA\t"multi\nline"\nB\t<script>window.injected=true</script>',
    'data.json': json.dumps({'group': {'needle': '<script>window.injected=true</script>'}, 'items': list(range(205))}),
    'bad.json': '{invalid', 'large.json': '{"cut":',
}
bridge += """
window.dshDesktop.resolveArtifacts = async request => ({ok:true,files:FILES.filter(file => request.paths?.includes(file.path))});
window.dshDesktop.previewFile = async path => {
  const file = FILES.find(item => item.path === path);
  return {ok:true,file:{...file,url:'file:///' + path,text:TEXTS[file.name],truncated:file.name==='large.json'}};
};
""".replace('FILES', json.dumps(files)).replace('TEXTS', json.dumps(texts))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width in [1440, 960]:
        page = browser.new_page(viewport={'width': width, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((root / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('.artifact-overflow summary').click()

        def open_file(name):
            page.locator('.artifact-file').filter(has=page.get_by_text(name, exact=True)).click()

        open_file('math.md')
        expect(page.locator('.katex')).to_have_count(2)
        expect(page.locator('.katex-display')).to_be_visible()
        expect(page.locator('.hljs-keyword')).to_have_text('const')
        expect(page.locator('.md-code code')).to_have_text('const answer = 42;')
        page.locator('.footnote-ref a').click()
        expect(page.locator('.footnote-item')).to_contain_text('Footnote body')
        page.locator('.footnote-backref').click()
        if width == 1440:
            page.screenshot(path=str(screenshots / 'enhanced-markdown.png'))

        open_file('rows.csv')
        expect(page.locator('.data-preview tbody tr')).to_have_count(100)
        expect(page.locator('.data-preview thead')).to_contain_text('name')
        page.locator('.data-preview').get_by_role('button', name='Next', exact=True).click()
        expect(page.locator('.data-preview tbody tr').first).to_contain_text('row-100')
        page.locator('.data-preview').get_by_role('searchbox').fill('row-204')
        expect(page.locator('.data-preview tbody tr')).to_have_count(1)
        page.locator('.data-preview').get_by_role('searchbox').fill('')
        page.get_by_label('First row is header').uncheck()
        expect(page.locator('.data-preview tbody tr').first).to_contain_text('name')
        if width == 1440:
            page.screenshot(path=str(screenshots / 'enhanced-csv.png'))

        open_file('rows.tsv')
        expect(page.locator('.data-preview tbody tr')).to_have_count(2)
        expect(page.locator('.data-preview tbody td').nth(1)).to_have_text('multi\nline')
        assert page.evaluate('window.injected') is None

        open_file('data.json')
        expect(page.locator('.json-value')).to_have_count(0)
        page.locator('.json-node > summary').click()
        page.get_by_text('items [205]', exact=True).click()
        expect(page.locator('.json-value')).to_have_count(100)
        page.get_by_role('button', name='Load more', exact=True).click()
        expect(page.locator('.json-value')).to_have_count(200)
        page.locator('.data-preview').get_by_role('searchbox').fill('needle')
        expect(page.locator('.json-value')).to_contain_text('$["group"]["needle"]')
        assert page.evaluate('window.injected') is None
        page.locator('.data-preview').get_by_role('searchbox').fill('')
        expect(page.locator('.json-node[open]')).to_have_count(0)
        page.locator('.json-node > summary').click()
        page.get_by_text('group {1}', exact=True).click()
        if width == 1440:
            page.screenshot(path=str(screenshots / 'enhanced-json.png'))

        open_file('bad.json')
        expect(page.locator('.data-preview-status')).to_contain_text('Invalid JSON')
        expect(page.locator('.file-preview-text')).to_have_text('{invalid')
        open_file('large.json')
        expect(page.locator('.data-preview-status')).to_contain_text('exceeds the preview limit')
        assert not errors, errors
        page.close()
    browser.close()
print('Enhanced previews: math, footnotes, highlighting, CSV/TSV pagination and JSON lazy trees passed')
