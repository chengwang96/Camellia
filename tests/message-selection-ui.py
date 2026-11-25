"""WeChat-style message selection in the real chat renderer."""
import ast
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture'
                                                        for target in node.targets))
fixture['messages'] = [
    {'role': 'user', 'seq': 1, 'text': 'FIRST user message to keep.'},
    {'role': 'assistant', 'seq': 2, 'engine': 'claude', 'text': 'FIRST assistant reply.'},
    {'role': 'user', 'seq': 3, 'text': 'SECOND user message to select.'},
    {'role': 'assistant', 'seq': 4, 'engine': 'claude', 'text': 'SECOND assistant reply.'},
    {'role': 'user', 'seq': 5, 'text': 'THIRD user message to select.'},
]
node = next(node for node in module.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge = bridge.replace(
    'return {ok:true};',
    'if(action==="delete-messages"){window.deletedSeqs=payload.seqs;'
    'fixture.messages=fixture.messages.filter(row=>!payload.seqs.includes(row.seq));'
    'return {ok:true,deleted:payload.seqs.length};}'
    'return {ok:true};', 1)
bridge = bridge.replace(
    'openFileExternally:async()=>({ok:true}),',
    'openFileExternally:async()=>({ok:true}),'
    'conversationExportMessages:async payload=>{window.exportPayload=payload;return {ok:true,canceled:false,count:payload.seqs.length};},')


def check_selection_background(view, sequences):
    scroll = view.locator('#chatScroll').bounding_box()
    column = view.locator('#chat').bounding_box()
    bands = view.locator('#chat > .message-selected').evaluate_all("""rows => rows.map(row => {
      const bounds = row.getBoundingClientRect();
      const paint = getComputedStyle(row, '::before');
      const check = row.querySelector('.message-select-check').getBoundingClientRect();
      const content = row.querySelector('.bubble, .turn-body').getBoundingClientRect();
      return {
        seq: Number(row.dataset.seq),
        left: bounds.left + parseFloat(paint.left), right: bounds.right - parseFloat(paint.right),
        top: bounds.top + parseFloat(paint.top), bottom: bounds.bottom - parseFloat(paint.bottom),
        checkLeft: check.left, checkRight: check.right, contentLeft: content.left,
        startRadius: paint.borderTopLeftRadius, endRadius: paint.borderBottomLeftRadius,
        joinsNext: row.nextElementSibling?.matches('.message-selected') ?? false,
      };
    })""")
    assert [band['seq'] for band in bands] == sequences
    for band in bands:
        assert abs(band['left'] - (column['x'] - 12)) < 1, band
        assert abs(band['right'] - (column['x'] + column['width'] + 12)) < 1, band
        assert scroll['x'] <= band['left'] < band['right'] <= scroll['x'] + scroll['width'], band
        assert abs(band['checkLeft'] - band['left'] - 12) < 1, band
        assert band['contentLeft'] - band['checkRight'] >= 3, band
    for previous, following in zip(bands, bands[1:]):
        if previous['joinsNext']:
            assert abs(following['top'] - previous['bottom']) < 1, (previous, following)
            assert previous['endRadius'] == following['startRadius'] == '0px'
        else:
            assert following['top'] > previous['bottom']
            assert previous['endRadius'] == following['startRadius'] == '8px'


def composer_frame(view):
    return view.locator('#inputCard').evaluate("""card => {
      const {x, y, width, height} = card.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        bounds: [x, y, width, height],
        appearance: [style.backgroundColor, style.border, style.borderRadius, style.boxShadow, style.padding],
      };
    }""")


def check_selection_composer(view, frame):
    card = view.locator('#inputCard')
    expect(card.locator('.composer-selection-toolbar')).to_be_visible()
    expect(card.locator('#input, .input-row')).to_have_count(2)
    expect(card.locator('#input')).to_be_hidden()
    expect(card.locator('.input-row')).to_be_hidden()
    current = composer_frame(view)
    assert current['appearance'] == frame['appearance'], (frame, current)
    assert all(abs(before - after) < 1 for before, after in zip(frame['bounds'], current['bounds'])), (frame, current)
    left, top, width, height = current['bounds']
    buttons = card.locator('[data-ms-action]')
    assert buttons.evaluate_all('buttons => buttons.map(button => button.dataset.msAction)') == ['copy', 'export', 'delete', 'exit']
    previous_right = left
    for button in buttons.all():
        bounds = button.bounding_box()
        assert previous_right <= bounds['x'] and bounds['x'] + bounds['width'] <= left + width
        previous_right = bounds['x'] + bounds['width']
        assert top <= bounds['y'] and bounds['y'] + bounds['height'] <= top + height
        assert abs(bounds['y'] + bounds['height'] / 2 - (top + height / 2)) < 2
        assert bounds['height'] >= 44


def check_content_drag(view):
    toolbar = view.locator('.composer-selection-toolbar')
    selecting = toolbar.is_visible()
    picked = view.locator('#chat > .message-selected')
    sequences = picked.evaluate_all('rows => rows.map(row => row.dataset.seq)')
    destination = view.locator('.msg-user[data-seq="5"]').bounding_box()
    for selector in ('.msg-user[data-seq="3"] .bubble', '.turn[data-seq="2"] .turn-body'):
        content = view.locator(selector).bounding_box()
        start_x = content['x'] + content['width'] - 8
        start_y = content['y'] + content['height'] / 2
        assert view.evaluate('([selector, x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(selector))',
                             [selector, start_x, start_y]), selector
        view.mouse.move(start_x, start_y)
        view.mouse.down()
        view.mouse.move(destination['x'] + 64, destination['y'] + destination['height'] / 2, steps=8)
        expect(view.locator('.message-selection-marquee'), selector).to_be_hidden(timeout=300)
        view.mouse.up()
        assert toolbar.is_visible() == selecting, selector
        assert picked.evaluate_all('rows => rows.map(row => row.dataset.seq)') == sequences, selector
        view.evaluate('window.getSelection().removeAllRanges()')


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 860}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error) + '\n' + str(getattr(error, 'stack', ''))))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="shared-fixture"]').click()
    expect(page.locator('#chat')).to_contain_text('FIRST assistant reply.')
    expect(page.locator('.message-select-toggle')).to_have_count(0)
    assert page.locator('.message-select-check:visible').count() == 0
    empty_frame = composer_frame(page)
    check_content_drag(page)

    # A mobile-style long press opens a menu without entering selection.
    row = page.locator('.msg-user[data-seq="1"]')
    box = row.bounding_box()
    page.mouse.move(box['x'] + 5, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.wait_for_timeout(520)
    page.mouse.up()
    expect(page.locator('.message-context-menu')).to_be_visible()
    assert page.locator('.message-select-check:visible').count() == 0
    page.locator('.message-context-menu [data-selection-action="select"]').click()
    check_selection_composer(page, empty_frame)
    expect(page.locator('.message-selection-count')).to_be_visible()
    expect(page.locator('.message-selection-count')).to_contain_text('1')
    check_content_drag(page)
    start = page.locator('.msg-user[data-seq="1"]').bounding_box()
    end = page.locator('.msg-user[data-seq="3"]').bounding_box()
    page.mouse.move(start['x'] + 5, start['y'] + start['height'] / 2)
    page.mouse.down()
    page.mouse.move(end['x'] + 64, end['y'] + end['height'] / 2, steps=14)
    expect(page.locator('.composer-selection-toolbar')).to_be_visible()
    assert page.locator('.message-selected').count() == 1
    expect(page.locator('.message-selection-marquee')).to_be_visible()
    expect(page.locator('.message-selection-count')).to_contain_text('1')
    page.mouse.up()
    expect(page.locator('.message-select-check')).to_have_count(5)
    expect(page.locator('.message-select-check').first).to_be_visible()
    expect(page.locator('#chat')).to_have_class(re.compile('message-selection-mode'))
    expect(page.locator('.message-select-check[aria-pressed="true"]')).to_have_count(3)

    # Exit, then drag from a clean state over every row. Height is the hit
    # test, so the pointer can stay far left of the bubbles.
    page.keyboard.press('Escape')
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
    chat_box = page.locator('#chatScroll').bounding_box()
    first = page.locator('.msg-user[data-seq="1"]').bounding_box()
    third = page.locator('.msg-user[data-seq="5"]').bounding_box()
    margin_x = chat_box['x'] + 24
    page.mouse.move(margin_x, first['y'] + first['height'] / 2)
    page.mouse.down()
    page.mouse.move(margin_x + 76, third['y'] + third['height'] / 2, steps=18)
    marquee = page.locator('.message-selection-marquee')
    expect(marquee).to_be_visible()
    assert abs(marquee.bounding_box()['width'] - 76) < 2
    expect(page.locator('.message-selected')).to_have_count(0)
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
    expect(page.locator('.input-card textarea')).to_be_visible()
    page.screenshot(path=preview / 'message-selection-marquee.png', animations='disabled')
    page.mouse.up()
    expect(marquee).to_be_hidden()
    expect(page.locator('.message-select-check[aria-pressed="true"]')).to_have_count(5)
    check_selection_background(page, [1, 2, 3, 4, 5])
    page.screenshot(path=preview / 'message-selection-contiguous.png', animations='disabled')

    # A circle click toggles only that message.
    target = page.locator('.msg-user[data-seq="3"]')
    was_selected = target.evaluate('node => node.classList.contains("message-selected")')
    target.locator('.message-select-check').click()
    if was_selected:
        expect(target).not_to_have_class(re.compile(r'\bmessage-selected\b'))
    else:
        expect(target).to_have_class(re.compile(r'\bmessage-selected\b'))
    check_selection_background(page, [1, 2, 4, 5])

    # A row click toggles only the row that was clicked.
    turn = page.locator('.turn[data-seq="4"]')
    was_selected = turn.evaluate('node => node.classList.contains("message-selected")')
    turn.locator('.turn-body').click()
    if was_selected:
        expect(turn).not_to_have_class(re.compile(r'\bmessage-selected\b'))
    else:
        expect(turn).to_have_class(re.compile(r'\bmessage-selected\b'))

    assert page.locator('.input-card .composer-selection-toolbar').is_visible()
    assert page.locator('.input-card textarea').is_hidden()
    page.screenshot(path=preview / 'message-selection-desktop.png', animations='disabled')

    # Export receives the original history order, not the click order.
    expected = page.evaluate("""() => [...document.querySelectorAll('.message-selected')]
      .map(row => Number(row.dataset.seq)).sort((a, b) => a - b)""")
    page.locator('[data-ms-action="export"]').click()
    expect(page.locator('#statusLine')).to_contain_text('Exported')
    assert page.evaluate('window.exportPayload.seqs') == expected

    page.once('dialog', lambda dialog: dialog.dismiss())
    page.locator('[data-ms-action="delete"]').click()
    assert page.evaluate('typeof window.deletedSeqs') == 'undefined'
    expect(page.locator('.message-selected')).to_have_count(len(expected))
    page.keyboard.press('Escape')
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()

    text_point = page.locator('.msg-user[data-seq="1"] .bubble').evaluate("""bubble => {
      const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect();
        if (rect.width > 8 && rect.height > 0) return {
          x: rect.left + 2, endX: rect.right - 2, y: rect.top + rect.height / 2,
        };
      }
      return null;
    }""")
    assert text_point is not None
    page.mouse.move(text_point['x'], text_point['y'])
    page.mouse.down()
    page.mouse.move(text_point['endX'], text_point['y'], steps=8)
    page.mouse.up()
    assert 'user message' in page.evaluate('window.getSelection().toString()')
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
    expect(marquee).to_be_hidden()
    page.evaluate('window.getSelection().removeAllRanges()')

    # Ending in a vertical gap cancels the preview without entering selection.
    first = page.locator('.msg-user[data-seq="1"]').bounding_box()
    reply = page.locator('.turn[data-seq="2"]').bounding_box()
    gap_y = (first['y'] + first['height'] + reply['y']) / 2
    page.mouse.move(first['x'] + 5, first['y'] + first['height'] / 2)
    page.mouse.down()
    page.mouse.move(first['x'] + 50, gap_y, steps=12)
    expect(page.locator('.message-selection-marquee')).to_be_visible()
    assert page.locator('.message-selected').count() == 0
    page.mouse.up()
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
    expect(page.locator('.message-selection-marquee')).to_be_hidden()

    first = page.locator('.msg-user[data-seq="1"]').bounding_box()
    third = page.locator('.msg-user[data-seq="5"]').bounding_box()
    mouse = page.context.new_cdp_session(page)
    conversation_url = page.url
    for button, flag in (('right', 2), ('middle', 4), ('back', 8), ('forward', 16)):
        start_y = first['y'] + first['height'] / 2
        end_y = third['y'] + third['height'] / 2
        page.mouse.move(margin_x, start_y)
        page.mouse.down()
        page.mouse.move(margin_x + 76, end_y, steps=8)
        expect(marquee).to_be_visible()
        point = {'x': margin_x + 76, 'y': end_y, 'button': button, 'clickCount': 1}
        mouse.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'buttons': 1 | flag, **point})
        expect(marquee).to_be_hidden()
        mouse.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'buttons': 1, **point})
        page.mouse.up()
        expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
        expect(page.locator('.message-context-menu')).to_have_count(0)
        assert page.url == conversation_url

    page.evaluate("""() => {
      const emit = event => deliverEvent({session_id:'shared-fixture',engine:'claude',runId:901,...event});
      emit({type:'conversation:started',prompt:'New user request',userSeq:6});
      emit({type:'assistant',message:{content:[{type:'text',text:'New Agent response'}]}});
      emit({type:'result',subtype:'success',result:'New Agent response',userSeq:6,assistantSeq:7});
    }""")
    latest = page.locator('.turn[data-seq="7"]')
    expect(latest).to_contain_text('New Agent response')
    latest.locator('.turn-body').click(button='right')
    page.locator('.message-context-menu [data-selection-action="select"]').click()
    expect(latest.locator('.message-select-check')).to_have_attribute('aria-pressed', 'true')
    page.locator('.msg-user[data-seq="6"] .message-select-check').click()
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('[data-ms-action="delete"]').click()
    expect(page.locator('#statusLine')).to_contain_text('Deleted 2 messages')
    assert page.evaluate('window.deletedSeqs') == [6, 7]

    page.emulate_media(reduced_motion='no-preference')
    draft = '\n'.join(f'Draft line {number}' for number in range(1, 7))
    editor = page.locator('#input')
    editor.fill(draft)
    page.locator('.turn[data-seq="4"] .turn-body').click(button='right')
    page.wait_for_function("document.querySelector('#inputCard').getAnimations().length === 0")
    draft_frame = composer_frame(page)
    assert draft_frame['bounds'][3] > empty_frame['bounds'][3]
    transition = page.locator('.message-context-menu [data-selection-action="select"]').evaluate("""action => {
      const controls = [...document.querySelectorAll('#inputCard :is(textarea, select, button)')]
        .filter(control => control.checkVisibility({checkVisibilityCSS: true, checkOpacity: true}));
      const toolbar = document.querySelector('.composer-selection-toolbar');
      action.click();
      return {
        controls: controls.map(control => control.id),
        lingering: controls.filter(control => getComputedStyle(control).visibility !== 'hidden').map(control => control.id),
        toolbarVisible: toolbar.checkVisibility({checkVisibilityCSS: true, checkOpacity: true}),
      };
    }""")
    assert {'input', 'attachBtn', 'selPermission', 'modelPill', 'send'} <= set(transition['controls']), transition
    assert not transition['lingering'] and transition['toolbarVisible'], transition
    page.locator('[data-ms-action="copy"]').focus()
    check_selection_composer(page, draft_frame)
    page.locator('#inputCard').dispatch_event('dragover')
    expect(page.locator('#inputCard')).not_to_have_class(re.compile(r'\bdragging\b'))
    page.locator('.turn[data-seq="4"] .message-select-check').click()
    expect(page.locator('.message-selected')).to_have_count(0)
    expect(page.locator('.composer-selection-toolbar button:disabled')).to_have_count(3)
    exit_button = page.get_by_role('button', name='Exit', exact=True)
    expect(exit_button).to_be_enabled()
    exit_button.click()
    expect(page.locator('.composer-selection-toolbar')).to_be_hidden()
    expect(editor).to_be_visible()
    expect(editor).to_have_value(draft)

    mobile = browser.new_page(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, reduced_motion='reduce')
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    mobile.add_init_script(bridge)
    mobile.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    mobile.wait_for_function('uiReady')
    if not mobile.locator('[data-sid="shared-fixture"]').is_visible():
        mobile.locator('#workbenchSidebarToggle').click()
        expect(mobile.locator('#sidebar')).to_be_visible()
    mobile.locator('[data-sid="shared-fixture"]').click()
    if mobile.locator('#workbenchSidebarBackdrop').is_visible():
        mobile.locator('#workbenchSidebarBackdrop').click()
    mobile_frame = composer_frame(mobile)
    # The phone keeps a fixed header above the scroll region. Use a row that is
    # already below it instead of the first message behind the header.
    mobile_row = mobile.locator('.turn[data-seq="2"]')
    mobile_box = mobile_row.bounding_box()
    touch = mobile.context.new_cdp_session(mobile)
    touch.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [
        {'x': mobile_box['x'] + 150, 'y': mobile_box['y'] + 30},
    ]})
    mobile.wait_for_timeout(520)
    touch.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    mobile.locator('.message-context-menu [data-selection-action="select"]').tap()
    check_selection_composer(mobile, mobile_frame)
    mobile.locator('.msg-user[data-seq="3"] .message-select-check').tap()
    check_selection_background(mobile, [2, 3])
    mobile.wait_for_timeout(200)
    assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert mobile.locator('.composer-selection-toolbar [data-ms-action="copy"]').bounding_box()['height'] >= 44
    mobile.screenshot(path=preview / 'message-selection-mobile.png', full_page=True, animations='disabled')
    mobile.evaluate("CamelliaI18n.setLanguage('zh-CN')")
    mobile.get_by_role('button', name='退出', exact=True).tap()
    expect(mobile.locator('.composer-selection-toolbar')).to_be_hidden()
    expect(mobile.locator('.message-selected')).to_have_count(0)
    expect(mobile.locator('#input')).to_be_visible()

    assert not errors, errors
    browser.close()

print('PASS: message selection supports copy, export, delete and exit on desktop and mobile')
