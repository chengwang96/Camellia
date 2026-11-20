"""Word paragraph editing in the real preview renderer. No model calls.

This fixture mounts the production preview module in a minimal host page, the
same way the external-navigation regression does, so it exercises the actual
editor DOM and save bridge without starting an Electron app or an engine.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
renderer = (repo / 'src/renderer/shared/file-preview-panel.js').as_uri()

# A long paragraph wraps to several lines even though it has one newline, the
# shape that used to be clipped to a single row.
PARAGRAPHS = ['Report title', 'Intro paragraph', '', 'Second paragraph',
              'This paragraph is deliberately long enough that it wraps onto several lines inside the right-hand panel, '
              'which is exactly where a textarea sized from its newline count used to cut the overflow off. '
              'It must still show every line after the panel opens and after the panel gets narrower.']
state = {'paragraphs': list(PARAGRAPHS), 'saves': [], 'structures': [], 'editable': [True, True, True, False, True]}

host = '''<!doctype html><meta charset="utf-8">
<title>Camellia Word editing fixture</title>
<link rel="stylesheet" href="WORKBENCH_CSS">
<style>
body{margin:0;overflow:hidden;font:14px Arial,sans-serif;background:#f4f5f7}
#fileViewer{display:flex;flex-direction:column;width:760px;max-width:calc(100vw - 24px);
  height:860px;max-height:calc(100vh - 24px);margin:12px auto;box-sizing:border-box;
  background:#fff;border:1px solid #d5d9df}
.file-viewer-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e3e6ea}
.file-viewer-title-wrap{flex:1;min-width:0}
.file-viewer-kicker{display:block;font-size:11px;color:#68707a}
.file-viewer-title{display:block;font-size:15px}
.file-viewer-actions{display:flex;gap:6px}
#fileViewerBody{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column}
#fileViewer[hidden]{display:none}
button{font:13px Arial;padding:5px 10px;cursor:pointer}
.file-viewer-actions button{width:auto;padding:0 10px;font:12px Arial}
.file-preview-editor-actions .btn-primary{color:#fff;background:#365ee8;border:0;border-radius:6px}
.file-preview-editor-actions .btn-secondary{border:1px solid #e3e6ea;border-radius:6px;background:#fff}
.file-preview-editor-actions button:disabled{opacity:.45}
</style>
<aside id="fileViewer">
  <header class="file-viewer-header">
    <div class="file-viewer-title-wrap"><span class="file-viewer-kicker" id="fileViewerType"></span><strong class="file-viewer-title" id="fileViewerTitle"></strong></div>
    <div class="file-viewer-actions">
      <button id="fileViewerReveal">Reveal</button>
      <button id="fileViewerExternal">Open</button>
      <button id="fileViewerClose">Close</button>
    </div>
  </header>
  <div class="file-viewer-meta" id="fileViewerMeta"></div>
  <div id="fileViewerBody"></div>
</aside>
<div id="inputCard"></div>
<script>window.CamelliaI18n = {t: value => value};</script>
<script src="RENDERER"></script>
<script>
window.state = STATE;
const legacy = location.search.includes('legacy=1');
const notebook = location.search.includes('notebook=1');
const cells = () => state.paragraphs.map((_, index) => ({index, parent: 0, canMove: state.paragraphs.length > 1}));
const file = () => legacy
  ? {kind: 'document', paragraphEditability: EDITABLE.slice(), name: 'legacy.doc', path: 'C:/outputs/legacy.doc', extension: 'DOC',
    size: 4096, url: 'about:blank', wordEditToken: 'word-token', wordFormat: 'doc',
    paragraphs: state.paragraphs, office: {html: '<p>Report title</p>', sections: []}}
  : {kind: 'word', name: 'report.docx', path: 'C:/outputs/report.docx', extension: 'DOCX',
    size: 2048, url: 'about:blank', wordEditToken: 'word-token', wordFormat: 'docx',
    paragraphs: state.paragraphs, paragraphEditability: notebook ? state.editable.slice() : EDITABLE.slice(),
    ...(notebook ? {wordCells: cells()} : {}),
    office: {wordHtml: '<p>Report title</p>', sections: []}};
window.dshDesktop = {
  platform: 'win32',
  previewFile: async () => ({ok: true, file: file()}),
  savePreviewWord: async (token, paragraphs) => {
    if (token !== 'word-token') return {ok: false, error: 'Reopen the document before editing it.'};
    state.saves.push(paragraphs);
    for (const edit of paragraphs) state.paragraphs[edit.index] = edit.text;
    return {ok: true, file: {size: 2048, modifiedAt: Date.now()}, paragraphs: state.paragraphs};
  },
  previewWordCell: async (token, index) => ({ok: true,
    html: '<p class="cell-preview" style="font-weight:700">' + String(state.paragraphs[index])
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'}),
  structurePreviewWord: async (token, operation) => {
    state.structures.push(operation);
    if (operation.type === 'insertAfter') {
      state.paragraphs.splice(operation.index + 1, 0, '');
      state.editable.splice(operation.index + 1, 0, true);
    } else {
      const [paragraph] = state.paragraphs.splice(operation.from, 1);
      const [editable] = state.editable.splice(operation.from, 1);
      let target = operation.to;
      if (operation.from < target) target--;
      target += operation.position === 'after' ? 1 : 0;
      state.paragraphs.splice(target, 0, paragraph);
      state.editable.splice(target, 0, editable);
    }
    return {ok: true, file: {size: 2048, modifiedAt: Date.now()}, paragraphs: state.paragraphs.slice(),
      editable: state.editable.slice(), cells: cells()};
  },
  previewWordParagraphs: async () => ({ok: true, paragraphs: state.paragraphs.slice(), editable: EDITABLE.slice()}),
  savePreviewDoc: async (token, paragraphs) => {
    if (token !== 'word-token') return {ok: false, error: 'Reopen the document before editing it.'};
    state.saves.push(paragraphs);
    for (const edit of paragraphs) state.paragraphs[edit.index] = edit.text;
    return {ok: true, file: {size: 4096, modifiedAt: Date.now()}, paragraphs: state.paragraphs};
  },
  openFileExternally: async () => ({ok: true}),
  revealFile: async () => ({ok: true}),
};
window.viewer = CamelliaFilePreview.create({
  fileViewer: document.getElementById('fileViewer'), inputCard: document.getElementById('inputCard'),
  mdRender: value => value, setStatus: value => console.error(value),
});
window.ready = viewer.openFilePreview(file().path);
</script>'''.replace('WORKBENCH_CSS', (repo / 'src/renderer/chat/workbench.css').as_uri()).replace('RENDERER', renderer).replace('STATE', json.dumps(state)).replace('EDITABLE', json.dumps([True, True, True, False, True]))
(preview / 'word-edit-host.html').write_text(host, encoding='utf-8')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for width, height, legacy in [(1280, 900, False), (390, 844, False), (1280, 900, True)]:
        page = browser.new_page(viewport={'width': width, 'height': height})
        page.on('pageerror', lambda error: errors.append(str(error)))
        url = (preview / 'word-edit-host.html').as_uri() + ('?legacy=1' if legacy else '')
        page.goto(url, wait_until='networkidle')
        page.wait_for_function('window.ready')
        viewer = page.locator('#fileViewer')
        expect(viewer.locator('iframe')).to_be_visible()
        expect(viewer.locator('#fileViewerMeta')).to_contain_text('Document preview · Complex layouts may differ from the original.')
        expect(viewer.locator('#fileViewerMeta')).not_to_contain_text('C:/outputs/')
        expect(viewer.locator('.file-preview-meta-summary')).to_have_attribute(
            'title', 'C:/outputs/legacy.doc' if legacy else 'C:/outputs/report.docx')
        expect(viewer.locator('.office-preview-notice')).to_have_count(0)
        viewer.get_by_role('button', name='Edit', exact=True).click()
        blocks = viewer.locator('.file-preview-word-block textarea')
        status = viewer.locator('.file-preview-editor-status')
        save = viewer.get_by_role('button', name='Save', exact=True)
        expect(blocks).to_have_count(4)
        if not legacy:
            # A DOCX paragraph with a direct page break is read-only, just like
            # the Word-listed legacy paragraph below.
            locked = blocks.evaluate_all('els => els.map(el => el.readOnly)')
            assert locked == [False, False, True, False], locked
        # Wrapped text must show all of its lines before anything is edited:
        # this is the shape that used to be clipped to one row.
        sizes = blocks.evaluate_all('els => els.map(el => ({scroll: el.scrollHeight, client: el.clientHeight}))')
        assert all(item['client'] + 1 >= item['scroll'] for item in sizes), sizes
        assert sizes[3]['client'] > sizes[1]['client'], sizes
        if legacy:
            # The exact Word list is fetched before the editor appears, so the
            # table cell row already carries Word's index 4.
            expect(status).to_have_text('Text only · formatting is kept', timeout=15000)
            # A paragraph holding a picture or page break is listed read-only;
            # editing it would delete the picture.
            locked = page.evaluate("""() => {
              const rows = [...document.querySelectorAll('#fileViewer .file-preview-word-block textarea')];
              return rows.map(row => row.readOnly);
            }""")
            assert locked == [False, False, True, False]
            blocks.nth(3).fill('Edited long paragraph')
            save.click()
            expect(status).to_have_text('Saved')
            assert page.evaluate('window.state.saves') == [[{'index': 4, 'text': 'Edited long paragraph'}]]
        else:
            blocks.nth(1).fill('Edited intro')
            expect(status).to_have_text('Unsaved changes')
            save.click()
            expect(status).to_have_text('Saved')
            assert page.evaluate('window.state.saves') == [[{'index': 1, 'text': 'Edited intro'}]]
            if width > 1000:
                page.screenshot(path=str(preview / 'word-edit-desktop.png'), animations='disabled')
            else:
                viewer.screenshot(path=str(preview / 'word-edit-mobile.png'), animations='disabled')
        # Closing an editor with an unsaved DOCX change must not silently
        # discard it: the first close saves it and leaves the rendered preview,
        # and a failed save leaves the editor usable for a retry.
        if not legacy:
            # A keystroke made while Word is still saving must remain dirty,
            # otherwise the success handler for the old submission could
            # silently mark the newer text as saved.
            page.evaluate("""() => {
              const save = window.dshDesktop.savePreviewWord;
              window.dshDesktop.savePreviewWord = (token, paragraphs) => new Promise(resolve => {
                window.finishSlowWordSave = () => resolve(save(token, paragraphs));
              });
              window.restoreWordSave = () => { window.dshDesktop.savePreviewWord = save; };
            }""")
            blocks.nth(1).fill('First submitted')
            save.click()
            blocks.nth(1).fill('Typed during save')
            expect(status).to_have_text('Saving… newer edits are not saved yet')
            page.evaluate('window.finishSlowWordSave()')
            expect(status).to_have_text('Unsaved changes')
            page.evaluate('window.restoreWordSave()')
            save.click()
            expect(status).to_have_text('Saved')
            assert page.evaluate('window.state.paragraphs[1]') == 'Typed during save'

            saved_before_close = page.evaluate('window.state.saves.length')
            blocks.nth(1).fill('Unsaved close check')
            viewer.get_by_role('button', name='Close', exact=True).click()
            expect(viewer).to_be_hidden()
            assert page.evaluate('window.state.saves.length') == saved_before_close + 1
            assert page.evaluate('window.state.paragraphs[1]') == 'Unsaved close check'
            page.evaluate('viewer.openFilePreview("C:/outputs/report.docx")')
            expect(viewer.locator('iframe')).to_be_visible()
            viewer.get_by_role('button', name='Edit', exact=True).click()
            blocks = viewer.locator('.file-preview-word-block textarea')
            expect(blocks.nth(1)).to_have_value('Unsaved close check')
            page.evaluate("""() => {
              const save = window.dshDesktop.savePreviewWord;
              window.dshDesktop.savePreviewWord = async () => ({ok:false,error:'Simulated save failure'});
              window.restoreWordSave = () => { window.dshDesktop.savePreviewWord = save; };
            }""")
            blocks.nth(1).fill('Failed close draft')
            page.once('dialog', lambda dialog: dialog.dismiss())
            viewer.get_by_role('button', name='Close', exact=True).click()
            expect(viewer.locator('.file-preview-editor')).to_be_visible()
            expect(blocks.nth(1)).to_have_value('Failed close draft')
            expect(viewer.locator('.file-preview-editor-status')).to_have_text('Simulated save failure')
            page.evaluate('window.restoreWordSave()')
        viewer.get_by_role('button', name='Preview', exact=True).click()
        expect(viewer.locator('iframe')).to_be_visible()
        page.close()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto((preview / 'word-edit-host.html').as_uri() + '?notebook=1', wait_until='networkidle')
    page.wait_for_function('window.ready')
    viewer = page.locator('#fileViewer')
    expect(viewer.locator('iframe')).to_be_visible()
    viewer.screenshot(path=str(preview / 'word-preview-compact.png'), animations='disabled')
    viewer.get_by_role('button', name='Edit', exact=True).click()
    cells = viewer.locator('.file-preview-word-block.notebook')
    expect(cells).to_have_count(5)
    for index in range(5):
        expect(cells.nth(index).locator('.file-preview-word-cell-actions button')).to_have_count(3)
    first = cells.nth(0)
    first.locator('textarea').fill('Cell draft')
    first.get_by_role('button', name='Preview', exact=True).click()
    expect(first.locator('.file-preview-word-cell-preview')).to_be_visible()
    expect(first.locator('.cell-preview')).to_have_text('Cell draft')
    assert page.evaluate('window.state.saves') == [[{'index': 0, 'text': 'Cell draft'}]]
    first.get_by_role('button', name='Edit', exact=True).click()
    expect(first.locator('textarea')).to_be_visible()

    cells.nth(1).get_by_role('button', name='New same format', exact=True).click()
    expect(cells).to_have_count(6)
    assert page.evaluate('window.state.structures[0]') == {'type': 'insertAfter', 'index': 1}
    created = cells.nth(2)
    expect(created.locator('textarea')).to_have_value('')
    expect(created.locator('textarea')).to_be_focused()
    created.locator('textarea').fill('Created cell')
    viewer.get_by_role('button', name='Save', exact=True).click()
    expect(viewer.locator('.file-preview-editor-status')).to_have_text('Saved')

    cells.nth(0).locator('.file-preview-word-cell-grip').drag_to(
        cells.nth(2), target_position={'x': 180, 'y': 75})
    page.wait_for_function('window.state.structures.length === 2')
    assert page.evaluate('window.state.structures[1]') == {'type': 'move', 'from': 0, 'to': 2, 'position': 'after'}
    assert page.evaluate('window.state.paragraphs.slice(0, 3)') == ['Intro paragraph', 'Created cell', 'Cell draft']
    values = cells.locator('textarea').evaluate_all('els => els.slice(0, 3).map(el => el.value)')
    assert values == ['Intro paragraph', 'Created cell', 'Cell draft'], values
    page.screenshot(path=str(preview / 'word-cells-desktop.png'), animations='disabled')
    page.set_viewport_size({'width': 390, 'height': 844})
    expect(cells.nth(0).get_by_role('button', name='New same format', exact=True)).to_be_visible()
    assert page.evaluate("document.querySelector('.file-preview-word-blocks').scrollWidth <= document.querySelector('.file-preview-word-blocks').clientWidth")
    viewer.screenshot(path=str(preview / 'word-cells-mobile.png'), animations='disabled')
    page.close()
    assert not errors, errors
    browser.close()
print('Word edit UI checks passed')
