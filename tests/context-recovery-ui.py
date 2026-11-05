"""Recover context failures in place without losing edits or composer drafts."""
import ast
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)

bridge = scope['bridge'].replace('window.fixturePreferences =', '''
  fixture.messages[0].seq = 1;
  fixture.messages[0].at = Date.now();
  fixture.messages[0].attachments = [{path:'D:/review/source.csv',name:'source.csv',isImage:false}];
  window.compactCalls = []; window.sendCalls = []; window.cancelCalls = [];
  window.fixturePreferences =''')
bridge = bridge.replace("if(action==='list-sessions')", '''
  if(action==='compact') {
    compactCalls.push(payload);
    return new Promise(resolve=>{window.resolveCompact=resolve;});
  }
  if(action==='send') {sendCalls.push(payload);return {ok:false,error:'Compaction summary request limit reached'};}
  if(action==='cancel') {
    cancelCalls.push(payload);
    window.resolveSwitch?.({ok:false,error:'Handoff canceled'});
    return {ok:true};
  }
  if(action==='list-sessions')''')
bridge = bridge.replace('onConversationStatus:()=>{}', 'onConversationStatus:fn=>{window.deliverStatus=fn;}')
bridge = bridge.replace('window.switches.push(payload);return {ok:true};',
    'if(payload.navigate)return {ok:true};window.switches.push(payload);return new Promise(resolve=>{window.resolveSwitch=resolve;});')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, theme, language in [(1200, 'light', 'en'), (420, 'dark', 'zh-CN')]:
        page = browser.new_page(viewport={'width': width, 'height': 850}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=kimi&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.wait_for_function('!loadingSession')
        page.evaluate('(language)=>changeLanguage(language)', language)
        page.locator('#input').fill('Independent composer draft')
        page.evaluate("attachments=[{path:'D:/review/notes.md',name:'notes.md',isImage:false}];renderAttachments();saveDraft()")

        # Unrelated errors keep the usual edit action without recovery choices.
        page.evaluate('''() => {
          const user = document.querySelector('.msg-user').messageData;
          showFailedSend({text:user.text,at:user.at,error:'Engine unavailable'});
        }''')
        expect(page.locator('.context-recovery')).to_have_count(0)
        page.locator('.failed-send > button').click()
        editor = page.locator('.message-editor')
        edited = 'Analyze the source data.\nKeep the original files and verify every result.'
        editor.locator('textarea').fill(edited)
        editor.locator('button[type="submit"]').click()
        recovery = editor.locator('.context-recovery')
        expect(recovery).to_be_visible()
        compact = recovery.locator('[data-recovery-action="compact"]')
        markdown = recovery.locator('[data-recovery-action="markdown"]')
        expect(compact).to_have_text('Compact context' if language == 'en' else '手动压缩')
        expect(markdown).to_have_text('Markdown handoff' if language == 'en' else 'Markdown 交接')

        # A double click makes one request; failure re-enables both choices.
        compact.evaluate('(button)=>{button.click();button.click();}')
        page.wait_for_function('compactCalls.length===1')
        expect(compact).to_be_disabled()
        expect(markdown).to_be_disabled()
        page.evaluate("resolveCompact({ok:false,error:'Summary service unavailable'})")
        expect(recovery).to_contain_text('Summary service unavailable')
        expect(compact).to_be_enabled()
        expect(editor.locator('textarea')).to_have_value(edited)
        compact.click()
        page.wait_for_function('compactCalls.length===2')
        page.evaluate('resolveCompact({ok:true,durationMs:1000})')
        expect(editor.locator('.context-recovery')).to_have_count(0)
        expect(editor.locator('.message-edit-status')).not_to_have_class('message-edit-status error')
        expect(editor.locator('textarea')).to_have_value(edited)

        # Markdown uses the current harness. A failed handoff retains the editor;
        # a successful handoff reloads the conversation and restores the edit.
        editor.locator('button[type="submit"]').click()
        markdown = editor.locator('[data-recovery-action="markdown"]')
        expect(markdown).to_be_visible()
        markdown.click()
        page.wait_for_function('switches.length===1')
        expect(markdown).to_be_disabled()
        assert page.evaluate('switches[0]') == {
            'engine': 'kimi', 'sessionId': 'shared-fixture', 'mode': 'markdown', 'inPlace': True,
        }
        page.evaluate("resolveSwitch({ok:false,error:'Handoff unavailable'})")
        expect(editor.locator('.context-recovery')).to_contain_text('Handoff unavailable')
        expect(editor.locator('textarea')).to_have_value(edited)
        markdown.click()
        page.wait_for_function('switches.length===2')
        # A handoff keeps running in the background: other conversations open
        # normally while it is pending, and the origin shows its stop action.
        if width < 720: page.locator('#workbenchSidebarToggle').click()
        page.locator('[data-sid="another-session"]').click()
        page.wait_for_function('context.sessionId === "another-session" && !loadingSession')
        assert page.evaluate('handoffSessions.has("shared-fixture")')
        expect(page.locator('#engineSwitch')).to_be_enabled()
        assert page.evaluate('switches.length') == 2
        if width < 720: page.locator('#workbenchSidebarToggle').click()
        page.locator('[data-sid="shared-fixture"]').click()
        page.wait_for_function('context.sessionId === "shared-fixture" && !loadingSession')
        if width < 720: page.keyboard.press('Escape')
        assert page.evaluate('handoffSessions.has("shared-fixture")')
        expect(page.locator('#handoffStop')).to_be_visible()
        expect(page.locator('#engineSwitch')).to_be_disabled()
        expect(page.locator('#input')).to_be_disabled()
        page.evaluate('resolveSwitch({ok:true})')
        expect(editor.locator('textarea')).to_have_value(edited)
        page.wait_for_function('!handoffSessions.has("shared-fixture") && !loadingSession && editingMessage !== null')
        expect(editor.locator('.message-edit-status')).to_have_text(
            'Context ready. Send your message again.' if language == 'en' else '上下文已准备好，可以重新发送消息。')
        assert page.evaluate('editingMessage.div.messageData.attachments[0].path') == 'D:/review/source.csv'
        expect(page.locator('#input')).to_have_value('Independent composer draft')
        expect(page.locator('#attachRow')).to_contain_text('notes.md')
        editor.locator('button[type="button"]').click()

        # An uncommitted failed send and its attachment survive the same reload.
        page.evaluate('''() => {
          const attempt = {text:'Uncommitted review',at:Date.now(),error:'Compaction summary request limit reached',
            attachments:[{path:'D:/review/figure.svg',name:'figure.svg',isImage:false}]};
          writeUi('failed-send:'+context.sessionId,attempt);showFailedSend(attempt);
        }''')
        page.locator('.failed-send [data-recovery-action="markdown"]').click()
        page.wait_for_function('switches.length===3')
        page.evaluate('resolveSwitch({ok:true})')
        page.wait_for_function('!handoffSessions.has("shared-fixture") && !loadingSession')
        expect(page.locator('.msg-user').last).to_contain_text('Uncommitted review')
        expect(page.locator('.msg-user').last).to_contain_text('figure.svg')
        expect(page.locator('#input')).to_have_value('Independent composer draft')

        # A pending handoff stays cancellable after navigating to another
        # conversation; cancelling targets the origin, not the open conversation.
        page.evaluate('() => { void switchConversation("kimi", "markdown"); }')
        page.wait_for_function('handoffSessions.has("shared-fixture") && switches.length === 4')
        if width < 720: page.locator('#workbenchSidebarToggle').click()
        page.locator('[data-sid="another-session"]').click()
        page.wait_for_function('context.sessionId === "another-session" && !loadingSession')
        expect(page.locator('#handoffStop')).to_be_visible()
        page.locator('#handoffStop').click()
        page.wait_for_function('cancelCalls.length === 1 && !handoffSessions.has("shared-fixture")')
        assert page.evaluate('cancelCalls[0].sessionId') == 'shared-fixture'
        assert page.evaluate('context.sessionId') == 'another-session'
        expect(page.locator('#handoffStop')).to_be_hidden()
        if width < 720: page.locator('#workbenchSidebarToggle').click()
        page.locator('[data-sid="shared-fixture"]').click()
        page.wait_for_function('context.sessionId === "shared-fixture" && !loadingSession')
        if width < 720: page.keyboard.press('Escape')

        # A stalled handoff releases its lock automatically and requests cancel.
        page.evaluate('handoffTimeoutMs = 100; void switchConversation("kimi", "markdown")')
        page.wait_for_function('handoffSessions.has("shared-fixture") && switches.length === 5')
        page.evaluate('conversationActivity = "running"; updateConversationControls()')
        expect(page.locator('#engineSwitch')).to_be_disabled()
        page.wait_for_function('cancelCalls.length === 2 && !handoffSessions.has("shared-fixture")')
        expect(page.locator('#engineSwitch')).to_be_enabled()

        # Failed compaction notices and terminal turn errors offer the same actions.
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'failed',error:'Summary request failed'}})")
        expect(page.locator('.context-compaction [data-recovery-action="compact"]')).to_be_visible()
        page.evaluate('''() => {
          const {chip} = runResultChip({is_error:true,subtype:'error',result:'maximum context length is 8192 tokens'},false);
          chat.appendChild(chip);
        }''')
        expect(page.locator('.run-result [data-recovery-action="markdown"]')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        for button in page.locator('.context-recovery button').all():
            assert button.evaluate('(el)=>el.scrollWidth<=el.clientWidth && el.getBoundingClientRect().right<=innerWidth'), button.inner_text()
        page.screenshot(path=str(scope['preview'] / f'context-recovery-{theme}.png'), full_page=True)
        assert not errors, errors
        page.close()
    browser.close()

print('PASS context recovery: edits, attachments, drafts, retries, same-harness handoff, narrow UI and translations')
