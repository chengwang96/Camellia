"""Native and streamed assistant questions open a usable reply dialog promptly."""
import ast
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge']
choice = ('你已有 Camellia Android 的 release keystore 吗？若有，请提供文件路径和别名；若没有，我可以在本机生成并配置。\n\n'
          '- 没有，请在本机生成（推荐）\n- 已有，稍后提供路径和别名')
page_url = (repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&fixtureHarness=codex&conversation=shared-fixture'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto(page_url, wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "shared-fixture" && !loadingSession')
    page.evaluate('''() => {
      const original = window.dshDesktop.conversationCommand;
      window.sentChoices = [];
      window.dshDesktop.conversationCommand = async request => {
        if (request.action === 'send') {
          sentChoices.push(request.payload);
          return {ok:true,sessionId:'shared-fixture',runId:43,userSeq:4};
        }
        return original(request);
      };
    }''')
    page.evaluate('''reply => {
      const event = (type, more={}) => handleEvent({type,session_id:'shared-fixture',engine:'codex',runId:42,...more});
      event('conversation:started',{prompt:'Build a release APK',userSeq:3});
      event('stream_event',{event:{type:'message_start'}});
      event('stream_event',{event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      event('stream_event',{event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:reply}}});
      event('stream_event',{event:{type:'content_block_stop',index:0}});
      event('result',{subtype:'success',result:'Earlier reply\\n\\n'+reply,
        outputBlocks:[{phase:'final_answer',text:'Earlier reply'},{phase:'final_answer',text:reply}]});
    }''', choice)
    dialog = page.locator('#textChoiceDialog')
    expect(dialog).to_be_visible()
    expect(page.locator('#questionDialog')).not_to_be_visible()
    expect(dialog.locator('input:checked')).to_have_count(0)
    page.screenshot(path=str(preview / 'assistant-choice-dialog.png'), animations='disabled')
    dialog.get_by_role('button', name='Send reply').click()
    expect(dialog.locator('[role="alert"]')).to_contain_text('Answer each question')
    dialog.get_by_role('radio', name='没有，请在本机生成（推荐）').check()
    dialog.get_by_role('button', name='Send reply').click()
    page.wait_for_function('sentChoices.length === 1')
    assert page.evaluate('sentChoices[0].prompt') == '没有，请在本机生成（推荐）'
    expect(dialog).not_to_be_visible()
    expect(page.locator('.text-choice-pending')).to_have_count(0)
    page.close()

    # A native question opens as soon as Codex requests input, before any
    # answer item or turn result is complete.
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto(page_url, wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "shared-fixture" && !loadingSession')
    page.evaluate('''() => {
      const event = (type, more={}) => handleEvent({type,session_id:'shared-fixture',engine:'codex',runId:51,...more});
      event('conversation:started',{prompt:'Build a release APK',userSeq:3});
      event('gui:permission',{requestId:'native-choice',questions:[{id:'key',question:'Do you have a release keystore?',
        options:[{label:'Create one here'},{label:'I have one'}]}]});
    }''')
    expect(page.locator('#questionDialog')).to_be_visible()
    expect(page.locator('#questionDialog')).to_contain_text('Do you have a release keystore?')
    page.close()

    # A plain-text choice can open during a live answer, before its text block
    # stops. The selection steers that run instead of waiting for the result.
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto(page_url, wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "shared-fixture" && !loadingSession')
    page.evaluate('''reply => {
      const original = window.dshDesktop.conversationCommand;
      window.steeredChoices = [];
      window.dshDesktop.conversationCommand = async request => {
        if (request.action === 'steer') {
          steeredChoices.push(request.payload);
          return window.failSteer ? {ok:false,error:'Retry later'} : {ok:true};
        }
        return original(request);
      };
      const event = (type, more={}) => handleEvent({type,session_id:'shared-fixture',engine:'codex',runId:52,...more});
      window.choiceEvent = event;
      event('conversation:started',{prompt:'Build a release APK',userSeq:3});
      event('stream_event',{event:{type:'message_start'}});
      event('stream_event',{event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      event('stream_event',{event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:reply}}});
    }''', choice)
    live_dialog = page.locator('#textChoiceDialog')
    expect(live_dialog).to_be_visible()
    live_dialog.get_by_role('radio', name='没有，请在本机生成（推荐）').check()
    page.evaluate('window.failSteer = true')
    live_dialog.get_by_role('button', name='Send reply').click()
    expect(live_dialog.locator('[role="alert"]')).to_contain_text('Retry later')
    expect(live_dialog).to_be_visible()
    page.evaluate('window.failSteer = false')
    live_dialog.get_by_role('button', name='Send reply').click()
    page.wait_for_function('steeredChoices.length === 2')
    assert page.evaluate('steeredChoices[1].prompt') == '没有，请在本机生成（推荐）'
    assert page.evaluate('steeredChoices[1].runId') == 52
    expect(live_dialog).not_to_be_visible()
    page.evaluate('''reply => {
      choiceEvent('stream_event',{event:{type:'content_block_start',index:1,content_block:{type:'text',text:'',phase:'final_answer'}}});
      choiceEvent('stream_event',{event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:reply}}});
    }''', choice)
    expect(live_dialog).to_be_visible()
    page.evaluate('''() => choiceEvent('stream_event',{event:{type:'content_block_delta',index:1,
      delta:{type:'text_delta',text:'\\n\\nI will proceed with the existing key.'}}})''')
    expect(live_dialog).not_to_be_visible()
    page.evaluate('''() => choiceEvent('stream_event',{event:{type:'content_block_start',index:2,content_block:{type:'thinking',thinking:''}}})''')
    expect(live_dialog).not_to_be_visible()
    page.evaluate('''reply => choiceEvent('result',{subtype:'success',result:reply+'\\n\\nThe APK is ready.',
      outputBlocks:[{phase:'final_answer',text:reply},{phase:'final_answer',text:'The APK is ready.'}]})''', choice)
    expect(live_dialog).not_to_be_visible()
    page.close()

    # Finishing the turn keeps the already open dialog and switches its answer
    # path from steering the run to sending the next message.
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto(page_url, wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "shared-fixture" && !loadingSession')
    page.evaluate('''reply => {
      const original = window.dshDesktop.conversationCommand;
      window.sentAfterFinish = [];
      window.dshDesktop.conversationCommand = async request => {
        if (request.action === 'send') {
          sentAfterFinish.push(request.payload);
          return {ok:true,sessionId:'shared-fixture',runId:63,userSeq:5};
        }
        return original(request);
      };
      const event = (type, more={}) => handleEvent({type,session_id:'shared-fixture',engine:'codex',runId:62,...more});
      window.finishChoiceEvent = event;
      event('conversation:started',{prompt:'Build a release APK',userSeq:3});
      event('stream_event',{event:{type:'message_start'}});
      event('stream_event',{event:{type:'content_block_start',index:0,content_block:{type:'text',text:'',phase:'final_answer'}}});
      event('stream_event',{event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:reply}}});
    }''', choice)
    finished_dialog = page.locator('#textChoiceDialog')
    expect(finished_dialog).to_be_visible()
    page.evaluate('window.choiceCard = document.querySelector("#textChoiceDialog form")')
    page.evaluate('''reply => finishChoiceEvent('result',{subtype:'success',result:reply,
      outputBlocks:[{phase:'final_answer',text:reply}]})''', choice)
    expect(finished_dialog).to_be_visible()
    assert page.evaluate('choiceCard === document.querySelector("#textChoiceDialog form")')
    finished_dialog.get_by_role('radio', name='没有，请在本机生成（推荐）').check()
    finished_dialog.get_by_role('button', name='Send reply').click()
    page.wait_for_function('sentAfterFinish.length === 1')
    assert page.evaluate('sentAfterFinish[0].prompt') == '没有，请在本机生成（推荐）'
    page.close()

    # A reload keeps the choice available without reopening a modal on its own.
    page = browser.new_page(viewport={'width': 1100, 'height': 760})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto(page_url, wait_until='networkidle')
    page.wait_for_function('uiReady && context.sessionId === "shared-fixture" && !loadingSession')
    page.evaluate('''async reply => {
      const original = window.dshDesktop.conversationCommand;
      window.dshDesktop.conversationCommand = async request => {
        const result = await original(request);
        if (request.action === 'load-session') {
          result.messages.push({role:'assistant',engine:'codex',seq:3,at:Date.now(),text:'Earlier reply\\n\\n'+reply,
            outputBlocks:[{phase:'final_answer',text:'Earlier reply'},{phase:'final_answer',text:reply}]});
        }
        return result;
      };
      await openHistorySession('shared-fixture');
    }''', choice)
    expect(page.locator('.text-choice-pending')).to_have_count(1)
    expect(page.locator('#textChoiceDialog')).not_to_be_visible()
    page.evaluate('CamelliaI18n.setLanguage("zh-CN")')
    page.locator('.text-choice-pending button').click()
    expect(page.locator('#textChoiceDialog')).to_be_visible()
    expect(page.locator('#textChoiceTitle')).to_have_text('选择回复')
    page.keyboard.press('Escape')
    expect(page.locator('#textChoiceDialog')).not_to_be_visible()
    assert not errors, errors
    browser.close()

print('Assistant choice UI checks passed')
