"""Discussion entry shows the latest messages and preserves deliberate reading. No model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
scope = {'__file__': str(repo / 'tests/discussion-layout-ui.py')}
for statement in ast.parse((repo / 'tests/discussion-layout-ui.py').read_text(encoding='utf-8')).body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)

bridge = scope['bridge'] + r"""(() => {
  fixtureGroup.messages = Array.from({length:40}, (_, index) => ({
    id:'history-'+index, seq:index+1, role:index%2 ? 'assistant' : 'user',
    speakerId:'member-0', speakerName:'Reviewer', requestId:'request-'+index,
    text:'History message '+index+'\n\n'+('A long discussion paragraph.\n\n').repeat(8),
  }));
  fixtureGroups.push({...structuredClone(fixtureGroup), id:'other-group', title:'Another discussion'});
  localStorage.setItem('camellia:discussion:draft:group-fixture', JSON.stringify({
    text:'Unsent discussion draft\n'.repeat(12), selected:[], mode:'parallel', attachments:[],
  }));
})();"""


def settled(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def at_latest(scroll):
    expect(scroll).to_have_js_property('scrollTop', scroll.evaluate('(s) => s.scrollHeight-s.clientHeight'))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for embedded in [True, False]:
        for width, height, theme in [(1200, 800, 'light'), (390, 844, 'dark')]:
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            target = 'chat/claude.html' if embedded else 'discussions/discussions.html'
            query = '?harness=codex' if embedded else ''
            page.goto((repo / 'src/renderer' / target).as_uri() + query, wait_until='networkidle')
            if embedded:
                page.wait_for_function('uiReady')
            surface = page.locator('#discussionSurface') if embedded else page.locator('body')
            rows = '#discussionSessions' if embedded else '#groupList'

            def open_group(group_id):
                if width <= 680:
                    toggle = page.locator('#workbenchSidebarToggle') if embedded and not surface.is_visible() else surface.locator('#sidebarToggle')
                    toggle.click()
                page.locator(rows + f' [data-group-id="{group_id}"]').click()

            if embedded:
                open_group('group-fixture')
            expect(surface.locator('#groupTitle')).to_have_text(scope['group']['title'])
            scroll = surface.locator('#chatScroll')
            settled(page)
            assert scroll.evaluate('(s) => s.scrollHeight > s.clientHeight*3')
            at_latest(scroll)
            expect(surface.locator('#message')).to_have_value('Unsent discussion draft\n' * 12)

            # Explicitly reopening the same group or switching groups always shows the latest message.
            scroll.evaluate('(s) => s.scrollTop=600')
            open_group('group-fixture')
            settled(page)
            at_latest(scroll)
            scroll.evaluate('(s) => s.scrollTop=600')
            open_group('other-group')
            expect(surface.locator('#groupTitle')).to_have_text('Another discussion')
            settled(page)
            at_latest(scroll)
            open_group('group-fixture')
            expect(surface.locator('#groupTitle')).to_have_text(scope['group']['title'])
            settled(page)
            at_latest(scroll)

            # Updates follow new output at the bottom, then leave an earlier reading position alone.
            for index, reading in enumerate([False, True]):
                if reading:
                    scroll.hover()
                    page.mouse.wheel(0, -700)
                    expect(scroll).not_to_have_js_property('scrollTop', scroll.evaluate('(s) => s.scrollHeight-s.clientHeight'))
                    settled(page)
                before = scroll.evaluate('(s) => s.scrollTop')
                text = f'New discussion output {index}'
                page.evaluate('''text => {
                  fixtureGroup.messages.push({id:text,seq:fixtureGroup.messages.length+1,role:'assistant',
                    speakerId:'member-0',speakerName:'Reviewer',requestId:text,text});
                  fixtureGroup.revision++; emitDiscussion({discussionId:fixtureGroup.id});
                }''', text)
                expect(surface.locator('#messages')).to_contain_text(text)
                settled(page)
                if reading:
                    assert abs(scroll.evaluate('(s) => s.scrollTop')-before) <= 2
                else:
                    at_latest(scroll)

            if embedded:
                # Returning from ordinary chat reveals a previously hidden discussion after loading it.
                if width <= 680:
                    surface.locator('#sidebarToggle').click()
                page.locator('#sessionList [data-sid="chat-fixture"]').click()
                expect(surface).not_to_be_visible()
                open_group('group-fixture')
                settled(page)
                at_latest(scroll)
                expect(surface.locator('#message')).to_have_value('Unsent discussion draft\n' * 12)
            assert not errors, errors
            page.close()
    browser.close()
print('PASS: standalone and embedded discussion entry, reopening, switching, drafts, live following and reading position at desktop/mobile widths')
