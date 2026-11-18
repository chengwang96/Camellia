import json
import ast
import subprocess
import tempfile
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from pptx import Presentation
from pptx.util import Inches, Pt
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='camellia-office-render-') as directory:
    folder = Path(directory)
    document = Document()
    document.add_heading('Rendered Word report', level=1)
    document.add_paragraph().add_run('Bold document text').bold = True
    document.add_table(rows=1, cols=2).cell(0, 0).text = 'Table value'
    document.add_picture(str(root / 'assets/icon-256.png'))
    document.sections[0].header.paragraphs[0].text = 'Document header'
    document.sections[0].footer.paragraphs[0].text = 'Document footer'
    document.add_page_break()
    document.add_paragraph('Second page')
    document.save(folder / 'report.docx')

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    title = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    title.text_frame.paragraphs[0].text = 'Rendered slide'
    title.text_frame.paragraphs[0].runs[0].font.size = Pt(28)
    slide.shapes.add_picture(str(root / 'assets/icon-256.png'), Inches(1), Inches(2), Inches(2))
    # A grouped pair of boxes verifies that group transforms and theme colours
    # survive the local renderer, which previously dropped every group shape.
    group = slide.shapes.add_group_shape()
    for offset, label in [(0, 'Grouped left'), (1, 'Grouped right')]:
        box = group.shapes.add_textbox(Inches(6 + offset * 2), Inches(1), Inches(1.8), Inches(0.6))
        box.text_frame.paragraphs[0].text = label
    second_slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    second_title = second_slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    second_title.text_frame.paragraphs[0].text = 'Second slide'
    presentation.save(folder / 'slides.pptx')

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Results'
    sheet['A1'] = 'Completion'
    sheet['A1'].font = Font(bold=True, color='123456')
    sheet['A1'].fill = PatternFill('solid', fgColor='EEEEEE')
    sheet['B1'] = 0.25
    sheet['B1'].number_format = '0.00%'
    sheet.merge_cells('A2:B3')
    sheet['A2'] = 'Merged cells'
    sheet.column_dimensions['A'].width = 28
    sheet.row_dimensions[2].height = 36
    for row in range(4, 41):
        sheet.cell(row=row, column=1, value=row)
        sheet.cell(row=row, column=2, value=f'Value {row}')
    for column in range(3, 11):
        sheet.column_dimensions[get_column_letter(column)].width = 22
        for row in range(1, 41):
            sheet.cell(row=row, column=column, value=f'{get_column_letter(column)}{row}')
    sheet.freeze_panes = 'B2'
    workbook.create_sheet('Second sheet')['A1'] = 'Another worksheet'
    workbook.save(folder / 'results.xlsx')

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 960, 'height': 900})
        previews = {}
        for filename, kind in [('report.docx', 'word'), ('slides.pptx', 'presentation'), ('results.xlsx', 'spreadsheet')]:
            result = subprocess.run(['node', '-e', "require('./src/main/office-preview').readOfficePreview(process.argv[1], process.argv[2]).then(result => process.stdout.write(JSON.stringify(result)))", str(folder / filename), kind], cwd=root, check=True, capture_output=True, encoding='utf-8')
            preview = json.loads(result.stdout)
            previews[filename] = preview
            sandbox = 'allow-scripts' if kind == 'word' else ''
            page.set_content(f'<iframe sandbox="{sandbox}" style="width:100%;height:850px;border:0"></iframe>')
            page.locator('iframe').evaluate('(frame, html) => frame.srcdoc = html', preview.get('wordHtml') or preview['html'])
            frame = page.frame_locator('iframe')
            if kind == 'word':
                expect(frame.get_by_text('Rendered Word report', exact=True)).to_be_visible()
                expect(frame.locator('td').first).to_have_text('Table value')
                expect(frame.get_by_text('Bold document text')).to_have_css('font-weight', '700')
                expect(frame.locator('img')).to_be_visible()
                expect(frame.locator('section.docx')).to_have_count(2)
                expect(frame.get_by_text('Document header', exact=True).first).to_be_visible()
                expect(frame.get_by_text('Document footer', exact=True).first).to_be_visible()
                assert page.locator('iframe').evaluate('(frame) => frame.contentDocument === null')
                assert frame.locator('body').evaluate("""body => [...body.querySelectorAll('*')].every(
                    element => !['fixed', 'sticky'].includes(getComputedStyle(element).position))""")
                second_page = frame.get_by_text('Second page', exact=True)
                second_page.scroll_into_view_if_needed()
                expect(second_page).to_be_in_viewport()
                frame.get_by_text('Rendered Word report', exact=True).scroll_into_view_if_needed()
            elif kind == 'presentation':
                expect(frame.locator('.slide').first).to_be_visible()
                expect(frame.get_by_text('Rendered slide')).to_be_visible()
                expect(frame.locator('.group')).to_have_count(1)
                expect(frame.get_by_text('Grouped left')).to_be_visible()
                expect(frame.get_by_text('Grouped right')).to_be_visible()
                # A grouped child must sit inside the group, not at the slide origin.
                assert frame.locator('.group .shape').first.evaluate(
                    '(el) => { const group = el.closest(".group").getBoundingClientRect(); const child = el.getBoundingClientRect(); return child.width <= group.width + 1 && child.height <= group.height + 1; }')
                expect(frame.locator('img')).to_be_visible()
                assert frame.locator('img').evaluate('(image) => image.complete && image.naturalWidth > 0')
                expect(frame.locator('.slide')).to_have_count(2)
                assert frame.locator('body').evaluate("""body => [...body.querySelectorAll('*')].every(
                    element => !['fixed', 'sticky'].includes(getComputedStyle(element).position))""")
                assert frame.locator('.slide').evaluate_all("""slides => slides.every(slide => {
                    const bounds = slide.getBoundingClientRect();
                    return [...slide.querySelectorAll('.shape,.group,.picture,.chart,.connector')].every(element => {
                        const rect = element.getBoundingClientRect();
                        return rect.left >= bounds.left - 1 && rect.top >= bounds.top - 1
                            && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1;
                    });
                })""")
                second_slide = frame.get_by_text('Second slide', exact=True)
                second_slide.scroll_into_view_if_needed()
                expect(second_slide).to_be_in_viewport()
                frame.get_by_text('Rendered slide', exact=True).scroll_into_view_if_needed()
            else:
                expect(frame.locator('h2').first).to_have_text('Results')
                expect(frame.locator('td').nth(1)).to_have_text('25.00%')
                expect(frame.locator('td').first).to_have_css('font-weight', '700')
                expect(frame.locator('td[colspan="2"][rowspan="2"]')).to_have_text('Merged cells')
                expect(frame.locator('td').first).to_have_css('position', 'sticky')
                sheet_view = frame.locator('.sheet').first
                sheet_view.evaluate('(element) => { element.scrollTop = 240; element.scrollLeft = 260; }')
                assert frame.locator('td').first.evaluate("""cell => {
                    const rect = cell.getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2);
                    return hit === cell || cell.contains(hit);
                }""")
                first_row_number = frame.locator('tbody tr').first.locator('th')
                expect(first_row_number).to_have_text('1')
                assert first_row_number.evaluate("""cell => {
                    const rect = cell.getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2);
                    return hit === cell || cell.contains(hit);
                }""")
                column_a = frame.locator('thead th').nth(1)
                expect(column_a).to_have_text('A')
                assert column_a.evaluate("""header => {
                    const rect = header.getBoundingClientRect();
                    const cell = document.querySelector('tbody td').getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return Math.abs(rect.left - cell.left) < 1 && (hit === header || header.contains(hit));
                }""")
                assert frame.locator('thead th').first.evaluate("""header => {
                    const rect = header.getBoundingClientRect();
                    const sheet = document.querySelector('.sheet').getBoundingClientRect();
                    return Math.abs(rect.left - sheet.left) < 1;
                }""")
                assert frame.locator('tbody tr').nth(1).locator('th').evaluate("""header => {
                    const rect = header.getBoundingClientRect();
                    const sheet = document.querySelector('.sheet').getBoundingClientRect();
                    return Math.abs(rect.left - sheet.left) < 1;
                }""")
                sheet_view.evaluate('(element) => { element.scrollTop = 0; element.scrollLeft = 0; }')
            output = root / 'dist/ui-preview'
            output.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output / f'office-render-{kind}.png'))
        page.close()
        module = ast.parse((root / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
        fixture = next(ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
        bridge_node = next(node for node in module.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
        files = [dict(name=name, path='C:/outputs/' + name, extension=name.split('.')[-1], kind=kind, size=1024) for name, kind in [('report.docx', 'word'), ('results.xlsx', 'spreadsheet')]]
        fixture['messages'][-1]['artifacts'] = files
        bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
        bridge += """
        window.dshDesktop.resolveArtifacts = async () => ({ok:true,files:FILES});
        window.dshDesktop.previewFile = async path => {const file=FILES.find(item=>item.path===path);return {ok:true,file:{...file,office:PREVIEWS[file.name]}}};
        """.replace('FILES', json.dumps(files)).replace('PREVIEWS', json.dumps(previews))
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((root / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('.artifact-file').filter(has=page.get_by_text('report.docx', exact=True)).click()
        frame = page.frame_locator('.file-preview-office-document')
        expect(frame.locator('section.docx')).to_have_count(2)
        expect(page.locator('.file-preview-office-document')).to_have_attribute('sandbox', 'allow-scripts')
        assert page.locator('.file-preview-office-document').evaluate('(frame) => frame.contentDocument === null')
        page.locator('.artifact-file').filter(has=page.get_by_text('results.xlsx', exact=True)).click()
        expect(frame.locator('td[colspan="2"][rowspan="2"]')).to_have_text('Merged cells')
        page.locator('.office-sheet-select').select_option(label='Second sheet')
        expect(frame.locator('td')).to_have_text('Another worksheet')
        expect(page.locator('.file-preview-office-document')).to_have_attribute('sandbox', '')
        assert not errors, errors
        page.close()
        browser.close()
print('Real DOCX, PPTX and XLSX files render formatted documents, images, slides and cells')
