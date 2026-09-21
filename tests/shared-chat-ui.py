"""Shared conversation UI, alignment and switch preferences. No model calls."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
fixture = {
    'id': 'shared-fixture', 'title': 'Compare the experiment results', 'origin': 'claude',
    'currentEngine': 'claude', 'workspaceId': None,
    'messages': [{'role': 'user', 'text': 'Check the experiment and record the next steps.'},
                 {'role': 'assistant', 'engine': 'claude', 'text': '## Experiment review\n\nThe results are ready. Next, validate the data and compare the two implementations.'}],
}
bridge = r"""(() => {
  const fixture = FIXTURE;
  window.fixturePreferences = {mode:'direct',warnOnSwitch:false,showOrigin:false};
  window.switches = [];
  window.currentGoal = null;
  const engine = new URLSearchParams(location.search).get('harness');
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:fn=>{window.changeLanguage=fn;return()=>{};},
    conversationCommand:async ({action,payload}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now(),showOrigin:window.fixturePreferences.showOrigin},{...fixture,id:'another-session',title:'Another task',mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,preferences:window.fixturePreferences,settings};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:window.currentGoal};
      if(action==='goal-start') {
        window.goalPayload=payload;
        window.currentGoal={id:'goal-fixture',objective:payload.objective,criterion:payload.criterion||null,sessionId:payload.sessionId,phase:'active',armed:true,elapsedMs:0,activeSince:Date.now(),roundsStarted:0};
        return {ok:true,goal:window.currentGoal};
      }
      if(action==='goal-pause') {
        Object.assign(window.currentGoal,{phase:'paused',armed:false,elapsedMs:window.currentGoal.elapsedMs+Date.now()-window.currentGoal.activeSince,activeSince:null});
        return {ok:true,goal:window.currentGoal};
      }
      if(action==='goal-resume') {Object.assign(window.currentGoal,{phase:'active',armed:true,activeSince:Date.now(),blockedReason:null});return {ok:true,goal:window.currentGoal};}
      if(action==='goal-clear') {window.currentGoal=null;return {ok:true,goal:null};}
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:window.fixturePreferences}),
    conversationSwitch:async payload=>{window.switches.push(payload);return {ok:true};},
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:()=>{},onConversationGoal:fn=>{window.deliverGoal=goal=>{window.currentGoal=goal;fn(goal);};},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('FIXTURE', json.dumps(fixture))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for width, height, theme in [(1440, 900, 'light'), (960, 720, 'dark')]:
        rects = []
        for engine in ['claude', 'codex', 'dsh', 'kimi', 'antigravity']:
            page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script(bridge)
            page.goto((repo/'src/renderer/chat/claude.html').as_uri()+f'?harness={engine}', wait_until='networkidle')
            page.wait_for_function('uiReady')
            assert page.locator('.logo-icon img').evaluate('(img) => img.complete && img.naturalWidth > 0'), engine
            empty = page.locator('#inputCard').bounding_box()
            page.locator('[data-sid="shared-fixture"]').click()
            expect(page.locator('#chat')).to_contain_text('Experiment review')
            assert page.locator('.turn-avatar img').evaluate_all('(images) => images.every(img => img.complete && img.naturalWidth > 0)'), engine
            expect(page.locator('#conversationOrigin')).to_be_hidden()
            expect(page.locator('#handoffStop')).to_be_hidden()
            active = page.locator('#inputCard').bounding_box()
            rects.append((empty, active))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(preview/f'shared-{engine}-{theme}.png'), animations='disabled')
            page.locator('#input').fill('/goal')
            page.locator('#input').press('Enter')
            expect(page.locator('#goalChipRow')).to_be_visible()
            expect(page.locator('#goalToggle')).to_have_attribute('aria-pressed','true')
            assert 'goal' in page.locator('#input').get_attribute('placeholder').lower()
            objective = 'Complete the experiment, compare the implementations, and verify the final results.'
            page.locator('#input').fill(objective)
            page.locator('#input').press('Enter')
            assert page.evaluate('goalPayload.sessionId') == 'shared-fixture'
            assert page.evaluate('goalPayload.objective') == objective
            assert page.evaluate('!("maxRounds" in goalPayload)')
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal ·')
            page.evaluate('deliverGoal({...currentGoal,elapsedMs:51339000,activeSince:Date.now()})')
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('14h 15m')
            page.locator('#inputCard').screenshot(path=str(preview/f'goal-{engine}-{theme}.png'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('#goalChipRow .goal-chip').first.click()
            expect(page.locator('.dsh-pop')).to_contain_text(objective)
            page.locator('.dsh-pop .pop-row',has_text='Pause goal').click()
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal paused')
            page.locator('#goalChipRow .goal-chip').first.click()
            page.locator('.dsh-pop .pop-row',has_text='Resume goal').click()
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal ·')
            page.evaluate('deliverGoal({...currentGoal,phase:"blocked",armed:false,activeSince:null,blockedReason:{message:"The required dataset is unavailable."}})')
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal blocked')
            page.locator('#goalChipRow .goal-chip').first.click()
            expect(page.locator('.dsh-pop')).to_contain_text('dataset is unavailable')
            page.locator('.dsh-pop .pop-row',has_text='Resume goal').click()
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal ·')
            page.evaluate('deliverGoal({...currentGoal,phase:"complete",armed:false,activeSince:null})')
            expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal completed')
            page.locator('#goalChipRow .goal-chip').first.click()
            page.locator('.dsh-pop .pop-row',has_text='Remove goal').click()
            expect(page.locator('#goalChipRow')).to_be_hidden()
            expect(page.locator('#goalToggle')).to_have_attribute('aria-pressed','false')
            page.select_option('#engineSwitch', 'kimi' if engine != 'kimi' else 'codex')
            expect(page.locator('#switchDialog')).not_to_be_visible()
            page.wait_for_function('window.switches.length === 1')
            assert page.evaluate('switches[0].sessionId') == 'shared-fixture'
            page.evaluate('fixturePreferences.warnOnSwitch = true')
            page.select_option('#engineSwitch', 'dsh' if engine != 'dsh' else 'claude')
            expect(page.locator('#switchDialog')).to_be_visible()
            page.locator('#switchCancel').click()
            assert page.evaluate('window.switches.length') == 1
            page.locator('#handoffBtn').click()
            expect(page.locator('#switchMethod')).to_have_value('markdown')
            page.screenshot(path=str(preview/f'handoff-{theme}.png'))
            page.locator('#switchCancel').click()
            page.evaluate('fixturePreferences.showOrigin=true; openHistorySession("shared-fixture")')
            expect(page.locator('#conversationOrigin')).to_be_visible()
            page.locator('#input').fill('Unsent notes for the shared task')
            page.evaluate('addAttachments(["D:/Code/DSH/README.md"])')
            page.locator('[data-sid="another-session"]').click()
            expect(page.locator('#input')).to_have_value('')
            page.locator('#input').fill('A different draft')
            page.locator('[data-sid="shared-fixture"]').click()
            expect(page.locator('#input')).to_have_value('Unsent notes for the shared task')
            expect(page.locator('#attachRow')).to_contain_text('README.md')
            target = 'dsh' if engine != 'dsh' else 'kimi'
            page.goto((repo/'src/renderer/chat/claude.html').as_uri()+f'?harness={target}', wait_until='networkidle')
            page.wait_for_function('uiReady')
            expect(page.locator('#chat')).to_contain_text('Experiment review')
            expect(page.locator('#input')).to_have_value('Unsent notes for the shared task')
            expect(page.locator('#attachRow')).to_contain_text('README.md')
            page.reload(wait_until='networkidle')
            page.wait_for_function('uiReady')
            expect(page.locator('#input')).to_have_value('Unsent notes for the shared task')
            page.close()
        for pair in rects:
            for state in (0,1):
                for key in ['x','y','width','height']:
                    assert abs(pair[state][key]-rects[0][state][key]) < 1, (width, key, rects)
    page = browser.new_page(viewport={'width': 1200, 'height': 720})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(bridge.replace('window.fixturePreferences =', r'fixture.messages[1].text += "\n\nA long experiment transcript with saved reading position.".repeat(160); window.fixturePreferences ='))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate('chatScroll.scrollTop=90; saveDraft()')
    assert page.locator('#chatScroll').evaluate('(el) => el.scrollTop') == 90
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    assert page.locator('#chatScroll').evaluate('(el) => el.scrollTop') == 90
    page.close()
    # Real renderer with independently running conversations behind the IPC bridge.
    concurrent_bridge = r"""(() => {
      const sessions = new Map(); let serial = 0;
      const engine = new URLSearchParams(location.search).get('harness');
      const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
      window.actions = [];
      window.pushEvent = event => {
        const s = sessions.get(event.session_id);
        if (s && s.live && event.type !== 'conversation:activity') {
          event.eventSeq = ++s.live.eventSeq; s.live.events.push(event);
          if(event.type==='gui:permission') s.activity=event.questions?.length?'question':'permission';
          if(event.type==='result') {
            s.messages.push({role:'assistant',seq:s.live.userSeq+1,engine:s.currentEngine,text:event.result});
            s.live=null; s.activity=null;
          }
        }
        window.receiveEvent(event);
        if (s) window.receiveEvent({type:'conversation:activity',session_id:s.id,engine:s.currentEngine,activity:s.activity});
      };
      window.dshDesktop = {
        sharedConversations:true,
        onLanguageChanged:()=>()=>{}, onEngineSettingsChanged:()=>{}, onApiRouterState:()=>{},
        onConversationEvent:fn=>window.receiveEvent=fn, onConversationGoal:fn=>window.receiveGoal=fn,
        onConversationStatus:()=>{},onHarnessNavigate:fn=>window.navigateHarness=fn,
        previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
        apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
        workbenchSettings:async()=>({ok:true,conversations:{mode:'direct'}}),
        conversationSwitch:async payload=>{actions.push({action:'switch',payload});return {ok:true};},
        conversationCommand:async ({action,payload})=>{
          actions.push({action,payload});
          if(action==='get-settings') return settings;
          if(action==='list-sessions') return {ok:true,sessions:[...sessions.values()],workspaces:[],pagination:{}};
          if(action==='load-session') {
            const snapshot = {ok:true,...structuredClone(sessions.get(payload)),settings};
            if(window.finishOnLoad===payload) {
              window.finishOnLoad=null;
              snapshot.live.engine = window.finishEngine || snapshot.live.engine || engine;
              pushEvent({type:'assistant',session_id:payload,engine:window.finishEngine||engine,runId:snapshot.live.runId,message:{content:[{type:'text',text:'Finished during navigation'}]}});
              pushEvent({type:'result',subtype:'success',session_id:payload,engine:window.finishEngine||engine,runId:snapshot.live.runId,result:'Finished during navigation'});
            }
            return snapshot;
          }
          if(action==='get-live') return {ok:true,live:sessions.get(payload?.sessionId)?.live || null};
          if(action==='goal-get') return {ok:true,goal:null};
          if(action==='send') {
            if(payload.editSeq && window.holdEdit) await new Promise(resolve=>window.releaseEdit=resolve);
            if(payload.editSeq && window.failEdit) return {ok:false,error:'Fixture send rejected'};
            const id = payload.sessionId || 'run-' + (++serial);
            const prior=sessions.get(id), runId=++serial;
            const userSeq=(prior?.messages.at(-1)?.seq||0)+1;
            let history=prior?.messages||[];
            if(payload.editSeq) history=history.slice(0,history.findIndex(m=>m.seq===payload.editSeq));
            const live={sessionId:id,workspaceId:null,engine,runId,userSeq,prompt:payload.prompt,displayText:payload.displayText,attachments:payload.attachments,messages:history,events:[],eventSeq:0};
            const s={id,title:payload.displayText||payload.prompt,mtimeMs:Date.now(),currentEngine:engine,activity:'running',messages:[...history,{role:'user',seq:userSeq,text:payload.prompt,displayText:payload.displayText,attachments:payload.attachments}],live};
            sessions.set(id,s);
            receiveEvent({type:'conversation:started',session_id:id,engine,runId,prompt:payload.prompt});
            pushEvent({type:'system',subtype:'init',session_id:id,engine,runId});
            pushEvent({type:'stream_event',session_id:id,engine,runId,event:{type:'message_start'}});
            pushEvent({type:'stream_event',session_id:id,engine,runId,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
            pushEvent({type:'stream_event',session_id:id,engine,runId,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Streaming '+payload.prompt}}});
            return {ok:true,sessionId:id,runId,userSeq};
          }
          if(action==='cancel') {const s=sessions.get(payload.sessionId);pushEvent({type:'result',subtype:'stopped',session_id:s.id,engine,runId:s.live.runId,result:'Stopped '+s.title});return {ok:true};}
          if(action==='control-respond') {
            if(window.failAnswer) return {ok:false,error:'Fixture answer rejected'};
            if(window.holdAnswer) await new Promise(resolve=>window.releaseAnswer=resolve);
            const s=sessions.get(payload.sessionId);if(!s.live) return {ok:false};
            s.live.events=s.live.events.filter(e=>e.type!=='gui:permission'||e.requestId!==payload.requestId);
            const pending=s.live.events.filter(e=>e.type==='gui:permission');
            s.activity=pending.some(e=>!e.questions?.length)?'permission':pending.length?'question':'running';
            receiveEvent({type:'conversation:activity',session_id:s.id,engine,activity:s.activity});return {ok:true};
          }
          return {ok:true};
        }
      };
      window.sessionFixtures = sessions;
    })();"""
    for engine in ['claude','codex','dsh','kimi','antigravity']:
        page = browser.new_page(viewport={'width':1200,'height':820})
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script(concurrent_bridge)
        page.goto((repo/'src/renderer/chat/claude.html').as_uri()+f'?harness={engine}',wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('#input').fill('Task A'); page.locator('#send').click()
        page.wait_for_function('running && !sending')
        a = page.evaluate('context.sessionId'); arun = page.evaluate('currentRunId')
        expect(page.locator('#chat')).to_contain_text('Streaming Task A')
        expect(page.locator('#newSessionBtn')).to_be_enabled()
        expect(page.locator('#engineSwitch')).to_be_disabled()
        expect(page.locator('#handoffBtn')).to_be_disabled()
        page.evaluate('navigateHarness("kimi")')
        assert page.evaluate('actions.filter(a=>a.action==="switch").length') == 0
        page.locator('#input').fill('Draft for A')
        page.locator('#newSessionBtn').click()
        page.wait_for_function('context.sessionId===null && !running')
        expect(page.locator('#engineSwitch')).to_be_enabled()
        page.evaluate('attachments=[{name:"data.csv",path:"D:/Fixture/data.csv",isImage:false}]; renderAttachments()')
        page.locator('#input').fill('Task B'); page.locator('#send').click()
        page.wait_for_function('running && !sending')
        b = page.evaluate('context.sessionId')
        page.evaluate('(a)=>pushEvent({type:"gui:permission",session_id:a.id,runId:a.runId,engine:document.body.dataset.harness,requestId:"approval-1",toolName:"Shell",input:{command:"echo Task A"}})', {'id':a,'runId':arun})
        expect(page.locator('#permMask')).not_to_have_class('perm-mask visible')
        expect(page.locator(f'[data-sid="{a}"]')).to_contain_text('Needs approval')
        expect(page.locator('#chat')).not_to_contain_text('Streaming Task A')
        page.locator(f'[data-sid="{a}"]').click()
        expect(page.locator('#chat')).to_contain_text('Streaming Task A')
        expect(page.locator('#permMask')).to_have_class('perm-mask visible')
        expect(page.locator('#input')).to_have_value('Draft for A')
        page.locator('#permLater').click()
        page.locator(f'[data-sid="{b}"]').click()
        expect(page.locator('#chat')).to_contain_text('Streaming Task B')
        expect(page.locator('#input')).to_have_value('')
        page.locator('#send').click()
        page.wait_for_function('!running')
        assert page.evaluate('actions.filter(a=>a.action==="cancel").map(a=>a.payload.sessionId)') == [b]
        expect(page.locator('#engineSwitch')).to_be_enabled()
        # Stop -> hover edit, cancel, failed submission retains text, then resend
        # in place while A is still working and the composer draft is untouched.
        page.locator('#input').fill('Unsent next message')
        page.mouse.move(2,2)
        user=page.locator('.msg-user').last
        expect(user.locator('.message-actions')).to_have_css('opacity','0')
        user.hover()
        expect(user.locator('.message-edit')).to_be_visible()
        user.locator('.message-edit').click()
        editor=page.locator('.message-editor textarea')
        expect(editor).to_have_value('Task B')
        editor.fill('Canceled edit')
        page.get_by_role('button',name='Cancel',exact=True).filter(visible=True).click()
        expect(user.locator('.bubble')).to_have_text('Task B')
        user.hover(); user.locator('.message-edit').focus(); user.locator('.message-edit').press('Enter')
        editor.fill('Corrected task B')
        page.evaluate('window.holdEdit=true')
        page.evaluate('window.failEdit=true')
        page.locator('.message-editor button.primary').click()
        expect(page.locator('.message-editor button.primary')).to_have_text('Sending…')
        expect(page.locator('.message-edit-status')).to_contain_text('Restarting this turn')
        expect(page.locator('#chat')).not_to_contain_text('Streaming Task B')
        page.evaluate('window.releaseEdit()')
        expect(editor).to_have_value('Corrected task B')
        expect(page.locator('.message-edit-status[role="alert"]')).to_contain_text('Fixture send rejected')
        expect(page.locator('#chat')).to_contain_text('Streaming Task B')
        expect(page.locator('#statusLine')).to_contain_text('Fixture send rejected')
        page.evaluate('window.failEdit=false')
        page.screenshot(path=str(preview/f'edit-message-{engine}.png'),animations='disabled')
        page.locator('.message-editor button.primary').click()
        expect(page.locator('.message-editor button.primary')).to_be_disabled()
        expect(page.locator('#chat')).not_to_contain_text('Streaming Task B')
        assert page.evaluate('actions.filter(a=>a.action==="send" && a.payload.editSeq).length')==2
        page.evaluate('window.releaseEdit()')
        page.wait_for_function('running && !sending')
        expect(page.locator('.msg-user')).to_have_count(1)
        expect(page.locator('.msg-user .bubble')).to_have_text('Corrected task B')
        expect(page.locator('.message-edit')).to_be_hidden()
        expect(page.locator('#chat')).not_to_contain_text('Stopped Task B')
        assert page.evaluate('(id)=>sessionFixtures.get(id).activity',a)=='permission'
        assert page.evaluate('actions.filter(a=>a.action==="send").at(-1).payload.editSeq')>0
        assert page.evaluate('actions.filter(a=>a.action==="send").at(-1).payload.attachments[0].path')=='D:/Fixture/data.csv'
        expect(page.locator('#input')).to_have_value('Unsent next message')
        page.evaluate("chat.insertAdjacentHTML('beforeend','<div style=\"height:1200px\"></div>');chatScroll.scrollTop=0")
        page.locator('#send').click()
        expect(page.locator('#messageQueue')).to_be_visible()
        expect(page.locator('.queue-text')).to_have_text('Unsent next message')
        page.wait_for_function('chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 2')
        page.evaluate("chat.insertAdjacentHTML('beforeend','<div style=\"height:900px\">Late agent output</div>');maybeScroll(false)")
        page.wait_for_function('chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 2')
        # Stop needs an empty composer; drop the queued draft first so stopping does not drain it into a new run.
        page.locator('.queue-remove').click()
        page.locator('#send').click()
        page.wait_for_function('!running')
        page.locator(f'[data-sid="{a}"]').click()
        expect(page.locator('#permMask')).to_have_class('perm-mask visible')
        page.locator('#permAllow').click()
        page.wait_for_function('!permRequestId')
        answered = page.evaluate('actions.find(a=>a.action==="control-respond").payload')
        assert 'input' not in answered or answered['input'] is None, 'ordinary Allow must preserve native tool arguments'
        assert answered['sessionId'] == a and answered['runId'] == arun
        # Clarifying questions never open an approval modal, even under the
        # middle automation tier. Answers survive navigation, serialize
        # correctly and are scoped. (The top tier auto-skips questions.)
        page.evaluate('currentPermission="auto"')
        question_event = {'type':'gui:permission','session_id':a,'runId':arun,'engine':engine,'requestId':'question-1','toolName':'AskUserQuestion','permissionMode':'bypassPermissions','questions':[
            {'id':'scope','question':'Which files should be included?','options':[{'label':'Main workflow','description':'Only maintained experiment code'},{'label':'All files','description':'Include older exploration'}],'multiSelect':False},
            {'id':'outputs','question':'Which outputs should be generated?','options':[{'label':'CSV'},{'label':'JSON'}],'multiSelect':True}]}
        page.evaluate('(event)=>pushEvent(event)',question_event)
        card=page.locator('.question-card').last
        expect(card).to_be_visible()
        expect(page.locator('#permMask')).not_to_have_class('perm-mask visible')
        expect(page.locator(f'[data-sid="{a}"]')).to_contain_text('Needs input')
        expect(card.locator('input:checked')).to_have_count(0)
        before=page.evaluate('actions.filter(a=>a.action==="control-respond").length')
        card.get_by_role('button',name='Submit answers').click()
        expect(card.locator('[role="alert"]')).to_contain_text('Answer each question')
        assert page.evaluate('actions.filter(a=>a.action==="control-respond").length')==before
        card.get_by_role('radio',name='Main workflow').check()
        card.get_by_role('checkbox',name='CSV',exact=True).check()
        card.get_by_role('checkbox',name='JSON',exact=True).check()
        card.locator('.question-custom input').nth(1).fill('Markdown report')
        page.locator(f'[data-sid="{b}"]').click(); page.wait_for_function('!loadingSession')
        expect(page.locator('.question-card')).to_have_count(0)
        page.locator(f'[data-sid="{a}"]').click(); page.wait_for_function('!loadingSession')
        card=page.locator('.question-card').last
        expect(card.get_by_role('radio',name='Main workflow')).to_be_checked()
        expect(card.get_by_role('checkbox',name='CSV',exact=True)).to_be_checked()
        expect(card.locator('.question-custom input').nth(1)).to_have_value('Markdown report')
        page.evaluate('(a)=>pushEvent({type:"assistant",session_id:a.id,runId:a.runId,engine:document.body.dataset.harness,message:{content:[{type:"text",text:"Please choose the scope."}]}})',{'id':a,'runId':arun})
        expect(card.get_by_role('radio',name='Main workflow')).to_be_checked()
        page.evaluate('window.failAnswer=true')
        card.get_by_role('button',name='Submit answers').click()
        expect(card.locator('[role="alert"]')).to_contain_text('Fixture answer rejected')
        expect(card.locator('.question-custom input').nth(1)).to_have_value('Markdown report')
        page.evaluate('window.failAnswer=false; window.holdAnswer=true')
        card.get_by_role('button',name='Submit answers').click()
        expect(card.get_by_role('button',name='Submit answers')).to_be_disabled()
        page.evaluate('window.releaseAnswer()')
        expect(card.locator('.question-status')).to_have_text('Answers sent')
        # Submitted cards collapse to an answer summary; options fold away.
        expect(card.locator('.question-answers')).to_contain_text('Main workflow')
        expect(card.locator('.question-answers')).to_contain_text('Markdown report')
        expect(card.locator('.question-review fieldset').first).not_to_be_visible()
        sent=page.evaluate('actions.filter(a=>a.action==="control-respond").at(-1).payload')
        assert sent['sessionId']==a and sent['runId']==arun and sent['allow']
        assert sent['input']=={'scope':'Main workflow','outputs':'CSV, JSON, Markdown report'}
        assert page.evaluate('actions.filter(a=>a.action==="control-respond").length')==before+2
        page.evaluate('window.holdAnswer=false')
        page.evaluate('(event)=>pushEvent(event)',{**question_event,'requestId':'question-2'})
        card=page.locator('.question-card').last
        card.get_by_role('button',name='Skip questions').click()
        expect(card.locator('.question-status')).to_have_text('Questions skipped')
        skipped=page.evaluate('actions.filter(a=>a.action==="control-respond").at(-1).payload')
        assert skipped['allow'] is False and 'no option has been confirmed' in skipped['message']
        page.evaluate('(event)=>pushEvent(event)',{**question_event,'requestId':'question-3'})
        page.screenshot(path=str(preview/f'question-card-{engine}.png'),animations='disabled')
        page.screenshot(path=str(preview/f'concurrent-{engine}.png'),animations='disabled')
        page.evaluate('receiveGoal({sessionId:"background-goal",goal:{sessionId:"background-goal",phase:"active",armed:true,objective:"Background goal"}})')
        expect(page.locator('#goalChipRow')).to_be_hidden()
        page.locator(f'[data-sid="{b}"]').click()
        page.wait_for_function('!loadingSession')
        page.evaluate('(id)=>{window.finishOnLoad=id;window.finishEngine="claude";}',a)
        page.locator(f'[data-sid="{a}"]').click()
        page.wait_for_function('!loadingSession && !running')
        expect(page.locator('#engineSwitch')).to_be_enabled()
        expect(page.locator('#chat')).to_contain_text('Finished during navigation')
        # The restored turn is labeled by the harness that produced it, not this page's.
        expect(page.locator('.turn-meta').last).to_contain_text('Claude')
        page.evaluate('(id)=>{ const s=sessionFixtures.get(id);s.currentEngine=document.body.dataset.harness==="kimi"?"codex":"kimi";s.activity="running"; }',b)
        page.locator(f'[data-sid="{b}"]').click()
        page.wait_for_function('actions.some(a=>a.action==="switch" && a.payload.navigate)')
        assert page.evaluate('actions.filter(a=>a.action==="cancel").length') == 2
        page.close()
    # A subscription composer also offers shared API routes as a model group.
    subscription_bridge = r"""(() => {
      const settings = {model:'k3',permissionMode:'default',connection:'subscription'};
      window.actions = [];
      window.dshDesktop = {
        sharedConversations:true,
        onLanguageChanged:()=>()=>{}, onEngineSettingsChanged:()=>{}, onApiRouterState:()=>{},
        onConversationEvent:()=>{},onConversationGoal:()=>{}, onConversationStatus:()=>{}, onHarnessNavigate:()=>{},
        apiRouterGetState:async()=>({enabled:true,models:['fixture-model','kimi-k2.5']}),
        kimiAccountState:async()=>({ok:true,account:{id:'acct'},models:[{id:'k3',name:'K3'},{id:'k2.8',name:'K2.8 Preview'}]}),
        workbenchSettings:async()=>({ok:true,conversations:{mode:'direct'}}),
        conversationSwitch:async()=>({ok:true}), openSettingsWindow:()=>{},
        previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
        conversationCommand:async ({action,payload})=>{
          window.actions.push({action,payload});
          if(action==='get-settings') return {...settings};
          if(action==='save-settings') { Object.assign(settings,payload); return {ok:true,settings:{...settings}}; }
          if(action==='list-sessions') return {ok:true,sessions:[],workspaces:[],pagination:{}};
          if(action==='get-live') return {ok:true,live:null};
          if(action==='goal-get') return {ok:true,goal:null};
          return {ok:true};
        },
      };
    })();"""
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(subscription_bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=kimi',wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('#modelPill').click()
    page.locator('.pop-row').first.click()
    menu = page.locator('.dsh-pop').last
    expect(menu.locator('.pop-group')).to_have_count(2)
    expect(menu).to_contain_text('Model · Kimi account')
    expect(menu).to_contain_text('Model · Shared API routes')
    expect(menu).to_contain_text('K2.8 Preview')
    menu.get_by_text('kimi-k2.5',exact=True).click()
    page.wait_for_function("actions.some(a=>a.action==='save-settings' && a.payload.connection==='api' && a.payload.model==='kimi-k2.5')")
    page.wait_for_function("document.querySelector('#modelPillName').textContent==='kimi-k2.5'")
    page.close()
    # Every reply keeps its own harness label, independent of the currently open harness.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=kimi&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#chat .turn-meta').first).to_contain_text('Claude')
    expect(page.locator('#chat .turn-meta img[src*="claude.svg"]')).to_have_count(1)
    hint = page.locator('#chat .switch-hint')
    expect(hint).to_contain_text('Claude')
    expect(hint).to_contain_text('Kimi Code')
    expect(hint).to_contain_text('Continue directly')
    page.close()
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#chat .turn-meta').first).to_contain_text('Claude')
    expect(page.locator('#chat .turn-meta img[src*="claude.svg"]')).to_have_count(1)
    expect(page.locator('#chat .switch-hint')).to_have_count(0)
    page.close()
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    mixed_fixture = {**fixture, 'messages': [
        {'role': 'assistant', 'engine': 'claude', 'text': 'Claude reply'},
        {'role': 'assistant', 'engine': 'codex', 'text': 'Codex reply'},
        {'role': 'assistant', 'engine': 'kimi', 'text': 'Kimi reply'},
        {'role': 'assistant', 'text': 'Legacy reply'},
    ]}
    mixed_bridge = bridge.replace(json.dumps(fixture), json.dumps(mixed_fixture))
    page.add_init_script(mixed_bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    labels = page.locator('#chat .turn-meta span')
    expect(labels).to_have_count(4)
    assert labels.all_text_contents() == ['Claude', 'Codex', 'Kimi', 'Assistant']
    page.close()
    # Archived conversations stay archived across reloads.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge.replace("if(action==='load-session') return","if(action==='archive-session'){localStorage.setItem('fixture-archived',payload.id);return {ok:true};} if(action==='load-session' && localStorage.getItem('fixture-archived')===payload) return {ok:false,error:'This conversation is archived'}; if(action==='load-session') return"))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#chat')).to_contain_text('Experiment review')
    page.evaluate("dshDesktop.conversationCommand({engine:'claude',action:'archive-session',payload:{id:'shared-fixture',archived:true}})")
    page.reload(wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#chat')).not_to_contain_text('Experiment review')
    assert page.evaluate('context.sessionId') is None
    page.close()
    # Slash commands: palette lists all, prefix filters, /goal reveals the goal input, /usage shows a card.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude',wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('#input').fill('/')
    expect(page.locator('.slash-pop .slash-row')).to_have_count(3)
    page.locator('#input').fill('/g')
    expect(page.locator('.slash-pop .slash-row')).to_have_count(1)
    expect(page.locator('.slash-pop')).to_contain_text('/goal')
    page.locator('#input').press('Enter')
    expect(page.locator('#goalChipRow')).to_be_visible()
    expect(page.locator('#input')).to_be_focused()
    page.locator('#goalToggle').click()
    expect(page.locator('#goalChipRow')).to_be_hidden()
    page.locator('#input').fill('/us')
    expect(page.locator('.slash-pop')).to_contain_text('/usage')
    page.locator('.slash-pop .slash-row').first.click()
    expect(page.locator('.usage-card')).to_contain_text('Local API usage')
    page.locator('#input').fill('/c')
    page.locator('#input').press('Enter')
    expect(page.locator('#statusLine')).to_contain_text('Start a conversation first')
    expect(page.locator('#input')).to_have_value('')
    page.close()
    # The context ring appears after a turn reports usage, with exact numbers on hover.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge.replace("onConversationEvent:()=>{},onConversationGoal:","onConversationEvent:fn=>window.receiveEvent=fn,onConversationGoal:"))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#ctxRing')).to_be_hidden()
    page.locator('#usageDot').click()
    expect(page.locator('.usage-empty')).to_be_visible()
    assert page.locator('.usage-pop').bounding_box()['height'] <= 40
    page.locator('#usageDot').click()
    page.evaluate("receiveEvent({type:'result',subtype:'success',session_id:'shared-fixture',engine:'claude',result:'done',usage:{input_tokens:100000,cache_read_input_tokens:5000,output_tokens:500}})")
    expect(page.locator('#ctxRing')).to_be_visible()
    tip = page.evaluate("document.querySelector('#ctxRing').dataset.tip")
    assert 'tokens (53%)' in tip and '105.0K / 200.0K' in tip, tip
    page.locator('#ctxRing').hover()
    expect(page.locator('.ctx-tip')).to_contain_text('tokens')
    # The last API call's own usage wins over the turn's summed result usage.
    page.evaluate("receiveEvent({type:'assistant',session_id:'shared-fixture',engine:'claude',message:{role:'assistant',content:[{type:'text',text:'partial'}],usage:{input_tokens:40000,cache_read_input_tokens:5000,output_tokens:100}}})")
    page.evaluate("receiveEvent({type:'result',subtype:'success',session_id:'shared-fixture',engine:'claude',result:'done',usage:{input_tokens:1300000,cache_read_input_tokens:0,output_tokens:500}})")
    tip = page.evaluate("document.querySelector('#ctxRing').dataset.tip")
    assert '45.0K / 200.0K' in tip, tip
    page.close()
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    usage_bridge = bridge.replace("onConversationEvent:()=>{},onConversationGoal:", "onConversationEvent:fn=>window.receiveEvent=fn,onConversationGoal:")
    usage_bridge = usage_bridge.replace(
        'window.fixturePreferences =',
        "fixture.messages.at(-1).usage={input_tokens:1300000,output_tokens:500};fixture.messages.at(-1).lastCallUsage={input_tokens:40000,cache_read_input_tokens:5000,output_tokens:100,context_window:128000};window.fixturePreferences =")
    page.add_init_script(usage_bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=codex&conversation=shared-fixture',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#ctxRing')).to_be_visible()
    assert '45.0K / 128.0K' in page.locator('#ctxRing').get_attribute('data-tip')
    page.locator('#usageDot').click()
    expect(page.locator('.usage-pop')).to_contain_text('1.3M')
    page.locator('#usageDot').click()
    page.evaluate("receiveEvent({type:'gui:usage',session_id:'shared-fixture',engine:'codex',usage:{input_tokens:60000,cache_read_input_tokens:4000,context_window:128000}})")
    assert '64.0K / 128.0K' in page.locator('#ctxRing').get_attribute('data-tip')
    page.locator('#newSessionBtn').click()
    expect(page.locator('#ctxRing')).to_be_hidden()
    page.locator('#usageDot').click()
    expect(page.locator('.usage-empty')).to_be_visible()
    page.locator('.usage-pop').screenshot(path=str(preview/'usage-empty-compact.png'), animations='disabled')
    page.close()
    # Goal draft mode: the criterion chip feeds into goal-start.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge)
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude',wait_until='networkidle')
    page.wait_for_function('uiReady')
    expect(page.locator('#goalToggle')).to_be_hidden()
    page.locator('#input').fill('/goal')
    page.locator('#input').press('Enter')
    expect(page.locator('#goalChipRow')).to_be_visible()
    expect(page.locator('#goalToggle')).to_be_visible()
    page.locator('#goalChipRow .goal-chip',has_text='+ Criterion').click()
    page.locator('#goalCriterionInput').fill('npm test passes')
    page.locator('#goalCriterionInput').press('Enter')
    expect(page.locator('#goalChipRow')).to_contain_text('Criterion: npm test passes')
    page.locator('#input').fill('Fix the flaky test')
    page.locator('#input').press('Enter')
    assert page.evaluate('goalPayload.criterion') == 'npm test passes'
    assert page.evaluate('goalPayload.objective') == 'Fix the flaky test'
    expect(page.locator('#goalChipRow .goal-chip').first).to_contain_text('Goal ·')
    page.close()
    # Import dialog: sessions group by project, project boxes toggle their group, select-all tracks partial state.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge.replace("apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),",
        "apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),codexDesktopSessions:async()=>({ok:true,sessions:[{id:'a',title:'Alpha chat',importable:true,project:{id:'p1',name:'ARDS',path:'D:/ards'}},{id:'b',title:'Beta chat',importable:true,project:{id:'p1',name:'ARDS',path:'D:/ards'}},{id:'c',title:'Loose chat',importable:true}]}),codexDesktopImport:async()=>({ok:true,imported:[],skipped:[]}),"))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude',wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('#importBtn').click()
    expect(page.locator('#importMask')).to_be_visible()
    heads = page.locator('#importList .import-project')
    expect(heads).to_have_count(1)
    expect(heads.nth(0)).to_contain_text('ARDS')
    expect(heads.nth(0)).to_contain_text('2 sessions')
    group = page.locator('#importList .import-project-group').first
    toggle = heads.nth(0).locator('.import-project-toggle')
    expect(toggle).to_have_attribute('aria-expanded', 'true')
    toggle.click()
    expect(group).to_have_class(re.compile(r'\bcollapsed\b'))
    expect(toggle).to_have_attribute('aria-expanded', 'false')
    expect(group.locator('.import-project-sessions')).to_be_hidden()
    toggle.click()
    expect(group.locator('.import-project-sessions')).to_be_visible()
    rows = page.locator('#importList .import-row input[type=checkbox]')
    expect(rows).to_have_count(3)
    expect(page.locator('#importAll')).to_be_checked()
    head_box = heads.nth(0).locator('input')
    head_box.uncheck()
    expect(rows.nth(0)).not_to_be_checked(); expect(rows.nth(1)).not_to_be_checked(); expect(rows.nth(2)).to_be_checked()
    assert page.evaluate("document.querySelector('#importAll').indeterminate") is True
    head_box.check()
    expect(rows.nth(0)).to_be_checked(); expect(rows.nth(1)).to_be_checked(); expect(rows.nth(2)).to_be_checked()
    rows.nth(1).uncheck()
    assert page.evaluate("document.querySelector('.import-project input').indeterminate") is True
    assert page.evaluate("document.querySelector('#importAll').indeterminate") is True
    page.locator('#importAll').click()
    expect(rows.nth(0)).to_be_checked(); expect(rows.nth(1)).to_be_checked(); expect(rows.nth(2)).to_be_checked()
    page.locator('#importAll').click()
    expect(rows.nth(0)).not_to_be_checked(); expect(rows.nth(1)).not_to_be_checked(); expect(rows.nth(2)).not_to_be_checked()
    page.locator('#importCancel').click()
    expect(page.locator('#importMask')).to_be_hidden()
    page.close()
    # Imported sessions offer a guarded manual sync from their action menu.
    page = browser.new_page(viewport={'width':1200,'height':820})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(bridge.replace("id:'another-session',title:'Another task'","id:'another-session',title:'Another task',imported:true")
        .replace("apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),",
        "apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),codexDesktopSessions:async()=>({ok:true,sessions:[]}),codexDesktopSync:async id=>{window.synced=id;return {ok:true,id,messages:7};},"))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude',wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="another-session"] .session-more').click()
    page.locator('.dsh-pop .pop-row',has_text='Sync from Codex desktop').click()
    expect(page.locator('#syncMask')).to_be_visible()
    expect(page.locator('#syncTitle')).to_contain_text('Another task')
    page.locator('#syncCancel').click()
    expect(page.locator('#syncMask')).to_be_hidden()
    assert page.evaluate('window.synced||null') is None
    page.locator('[data-sid="another-session"] .session-more').click()
    page.locator('.dsh-pop .pop-row',has_text='Sync from Codex desktop').click()
    page.locator('#syncConfirm').click()
    expect(page.locator('#syncMask')).to_be_hidden()
    page.wait_for_function("window.synced==='another-session'")
    page.close()
    page = browser.new_page(viewport={'width': 1200, 'height': 820})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}'))
    page.goto((repo/'src/renderer/chat/claude.html').as_uri()+'?harness=claude&conversation=shared-fixture', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate("""() => {
      const emit = event => deliverEvent({session_id:'shared-fixture',engine:'claude',runId:700,...event});
      window.compactEmit = emit;
      emit({type:'conversation:started',prompt:'Continue the experiment',userSeq:3});
      emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Progress before compaction.'}}});
      emit({type:'conversation:continued'});
      emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
      emit({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Verified after compaction.'}}});
    }""")
    expect(page.locator('#chat')).to_contain_text('Progress before compaction.')
    expect(page.locator('#chat')).to_contain_text('Verified after compaction.')
    assert page.locator('#chat').inner_text().count('Continue the experiment') == 1
    assert page.evaluate('running') is True
    page.evaluate("compactEmit({type:'result',subtype:'success',is_error:false,result:'Verified after compaction.'})")
    assert page.evaluate('running') is False
    expect(page.locator('.run-result')).to_have_count(1)
    page.close()
    browser.close()
    assert not errors, errors
    print('PASS: inline questions, answer mapping, selection drafts, failed-submit retry and skips; concurrent conversations, independent stop and approval, restored streams and drafts, harness locks, plus five-engine goal lifecycle and elapsed-time bars, logos, aligned composers, shared history, switch preferences, persistent drafts and attachments, reload, light/dark layouts')
