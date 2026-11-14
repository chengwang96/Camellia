"""Stop, change model and resend without stale compaction errors or progress."""
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
bridge = scope['bridge'].replace('const fixture = ', 'const fixture = window.retryFixture = ')
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
bridge = bridge.replace('onConversationStatus:()=>{}', 'onConversationStatus:fn=>{window.deliverStatus=fn;}')
bridge += r"""(() => {
  const original = dshDesktop.conversationCommand;
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  const sid = 'shared-fixture';
  let latest, compaction = null;
  window.attempts = [];
  retryFixture.messages[0].seq = 1;
  retryFixture.messages[1].seq = 2;
  retryFixture.messages.push({role:'notice',text:'Context compacted',seq:3,compaction:{durationMs:42000}});
  window.compactionStatus = (attempt, state, extra = {}) => {
    compaction = {state,startedAt:attempt.startedAt,...extra};
    deliverStatus({sessionId:sid,text:state==='running'?'Asking the engine to summarize the conversation…':'',compaction});
  };
  window.completeAttempt = () => {
    compactionStatus(latest,'completed',{seq:4,durationMs:8000});
    latest.resolve({ok:true,sessionId:sid,runId:42,userSeq:5});
    deliverEvent({type:'conversation:started',session_id:sid,engine:'codex',runId:42,userSeq:5,prompt:latest.payload.prompt});
    deliverEvent({type:'assistant',session_id:sid,engine:'codex',runId:42,message:{content:[{type:'text',text:'Continued after compaction'}]}});
    deliverEvent({type:'result',session_id:sid,engine:'codex',runId:42,subtype:'success',result:'Continued after compaction'});
    deliverEvent({type:'conversation:activity',session_id:sid,activity:null});
    compaction = null;
  };
  window.failAttempt = () => {
    compactionStatus(latest,'failed',{error:'Compaction summary request limit reached'});
    deliverEvent({type:'conversation:activity',session_id:sid,activity:null});
    latest.resolve({ok:false,error:'Compaction summary request limit reached'});
  };
  dshDesktop.conversationCommand = async request => {
    const {action,payload} = request;
    if (action==='get-settings') return {...settings};
    if (action==='save-settings') { Object.assign(settings,payload); return {ok:true,settings:{...settings}}; }
    if (action==='load-session') return {...await original(request),compaction,settings:{...settings}};
    if (action==='send') return new Promise(resolve => {
      latest = {resolve,payload,startedAt:Math.max(Date.now(),(latest?.startedAt||0)+1)};
      attempts.push(latest);
      deliverEvent({type:'conversation:activity',session_id:sid,activity:'running'});
      compactionStatus(latest,'running',{stage:'summarizing',completedChunks:1,totalChunks:5});
    });
    if (action==='cancel') {
      compactionStatus(latest,'cancelled',{error:'Compaction canceled'});
      deliverEvent({type:'conversation:activity',session_id:sid,activity:null});
      latest.resolve({ok:false,error:'Compaction canceled'});
      return {ok:true};
    }
    return original(request);
  };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for theme, language in [('light', 'en'), ('dark', 'zh-CN')]:
        page = browser.new_page(viewport={'width': 1100, 'height': 820}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('#chat')).to_contain_text('Experiment review')
        page.evaluate('language => changeLanguage(language)', language)
        page.evaluate("attachments=[{path:'D:/input.csv',name:'input.csv'}];renderAttachments()")
        page.locator('#input').fill('Continue with the attached data')
        page.locator('#send').click()
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(1)
        page.locator('#input').fill('An independent new draft')
        page.locator('#handoffStop').click()
        page.wait_for_function('!sending && !running && !conversationActivity')
        expect(page.locator('.context-compaction[data-state="cancelled"]')).to_have_count(1)
        expect(page.locator('.failed-send')).to_have_attribute('data-state', 'cancelled')
        expect(page.locator('.failed-send > span')).to_have_text('Not sent' if language == 'en' else '未发送')
        expect(page.locator('.context-recovery')).to_have_count(0)
        expect(page.locator('.run-result.err')).to_have_count(0)
        expect(page.locator('.run-status')).to_have_count(0)
        expect(page.locator('.turn')).to_have_count(1)
        expect(page.locator('#input')).to_have_value('An independent new draft')
        page.screenshot(path=str(scope['preview'] / f'compaction-cancel-{theme}.png'))

        # Reload restores the cancelled attempt once, without recovery buttons.
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('language => changeLanguage(language)', language)
        expect(page.locator('.failed-send[data-state="cancelled"]')).to_have_count(1)
        expect(page.locator('.context-recovery')).to_have_count(0)
        expect(page.locator('#input')).to_have_value('An independent new draft')
        # Reload resets the fixture bridge, so restore the old terminal status
        # as the backend would when loading the current compaction boundary.
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'cancelled',startedAt:Date.now()-1000,error:'Compaction canceled'}})")

        page.locator('.failed-send button').click()
        expect(page.locator('#input')).to_have_value('Continue with the attached data')
        expect(page.locator('#attachRow')).to_contain_text('input.csv')
        page.evaluate("persistSettings({model:'retry-model'},'Model changed')")
        page.locator('#send').click()
        page.wait_for_function('attempts.length===1 && sending')
        assert page.evaluate('attempts[0].payload.settings.model') == 'retry-model'
        expect(page.locator('.failed-send')).to_have_count(0)
        expect(page.locator('.context-compaction[data-state="cancelled"]')).to_have_count(0)
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(1)
        expect(page.locator('.context-compaction[data-seq="3"]')).to_have_count(1)
        expect(page.locator('.context-recovery')).to_have_count(0)
        # Late terminal/progress callbacks from the stopped attempt must not
        # complete the running row, change its progress or add another notice.
        page.evaluate("""() => {
          for (const state of ['cancelled','failed','completed','running'])
            deliverStatus({sessionId:'shared-fixture',text:'Obsolete progress',
              compaction:{state,startedAt:attempts[0].startedAt-1000,error:'Old failure',seq:99}});
        }""")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(1)
        expect(page.locator('.context-compaction[data-seq="99"]')).to_have_count(0)
        expect(page.locator('#chat')).not_to_contain_text('Obsolete progress')
        expect(page.locator('.run-result.err')).to_have_count(0)
        page.screenshot(path=str(scope['preview'] / f'compaction-retry-{theme}.png'))
        page.evaluate('completeAttempt()')
        expect(page.locator('#chat')).to_contain_text('Continued after compaction')
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(0)
        expect(page.locator('.context-compaction[data-seq="4"]')).to_have_count(1)
        expect(page.locator('.run-status')).to_have_count(0)

        # Real failures keep one error and their recovery controls.
        page.locator('#input').fill('Rejected attempt')
        page.locator('#send').click()
        page.wait_for_function('attempts.length===2 && sending')
        page.evaluate('failAttempt()')
        page.wait_for_function('!sending && !running && !conversationActivity')
        expect(page.locator('.failed-send')).to_have_attribute('data-state', 'failed')
        expect(page.locator('.context-recovery')).to_have_count(1)
        expect(page.locator('.run-result.err')).to_have_count(0)
        page.locator('.failed-send button').click()
        page.locator('#send').click()
        page.wait_for_function('attempts.length===3 && sending')
        expect(page.locator('.context-compaction[data-state="failed"]')).to_have_count(0)
        expect(page.locator('.context-recovery')).to_have_count(0)
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(1)
        page.locator('#send').click()
        page.wait_for_function('!sending && !running && !conversationActivity')
        assert not errors, errors
        page.close()
    browser.close()

print('PASS compaction cancellation, reload, model change, retry and stale callbacks in both themes')
