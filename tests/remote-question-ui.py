"""Remote question responses in the real chat renderer. No model calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
bridge = r"""(() => {
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  const live = {sessionId:'network',workspaceId:null,engine:'codex',runId:41,userSeq:1,
    prompt:'Check the network',messages:[],events:[],eventSeq:0,startedAt:Date.now()};
  const session = {id:'network',title:'Network diagnosis',currentEngine:'codex',activity:'running',mtimeMs:Date.now(),
    messages:[{role:'user',seq:1,text:live.prompt}],live};
  const other = {id:'other',title:'Other conversation',currentEngine:'codex',mtimeMs:Date.now(),messages:[],live:null};
  const sessions = new Map([[session.id,session],[other.id,other]]);
  window.sessionFixtures = sessions;
  window.submissions = [];
  window.deliver = event => {
    if (session.live) {
      event.eventSeq = ++session.live.eventSeq;
      if (event.type === 'conversation:approval-resolved') {
        session.live.events = session.live.events.filter(e => e.type !== 'gui:permission' || e.requestId !== event.requestId);
        event.responseSeq = session.messages.length+1;
        session.messages.push({role:'notice',seq:session.messages.length+1,engine:'codex',text:'Answers sent',questionResponse:event});
      }
      session.live.events.push(event);
      session.activity = session.live.events.some(e => e.type === 'gui:permission') ? 'question' : 'running';
      if (event.type === 'result') {
        session.messages.push({role:'assistant',seq:session.messages.length+1,engine:'codex',text:event.result});
        session.live = null; session.activity = null;
      }
    }
    receiveEvent(event);
    receiveEvent({type:'conversation:activity',session_id:session.id,activity:session.activity});
  };
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},
    onConversationEvent:fn=>window.receiveEvent=fn,onConversationGoal:()=>{},onConversationStatus:()=>{},onHarnessNavigate:()=>{},
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',showOrigin:false}}),
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
    conversationCommand:async({action,payload})=>{
      if(action === 'list-sessions') return {ok:true,sessions:[...sessions.values()],workspaces:[],pagination:{}};
      if(action === 'get-settings') return settings;
      if(action === 'goal-get') return {ok:true,goal:null};
      if(action === 'task-list') return {ok:true,tasks:[]};
      if(action === 'get-live') return {ok:true,live:sessions.get(payload?.sessionId)?.live || null};
      if(action === 'load-session') return {ok:true,...structuredClone(sessions.get(payload)),settings};
      if(action === 'control-respond') {
        submissions.push(payload);
        const request = session.live.events.find(e=>e.type === 'gui:permission' && e.requestId === payload.requestId);
        if (!request) return {ok:false};
        const answers = Object.fromEntries(request.questions.map(q=>[q.id,q.isSecret?'••••••':payload.input?.[q.id]]));
        deliver({type:'conversation:approval-resolved',session_id:session.id,engine:'codex',runId:41,
          requestId:payload.requestId,questions:request.questions,allow:payload.allow,...(payload.allow?{answers}:{})});
      }
      return {ok:true};
    },
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 850})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="network"]').click()
    page.wait_for_function('context.sessionId === "network" && !loadingSession')
    question = {'type': 'gui:permission', 'session_id': 'network', 'engine': 'codex', 'runId': 41,
                'requestId': 'network-question', 'questions': [
                    {'id': 'router', 'question': 'Same router?', 'options': [{'label': 'Yes'}, {'label': 'No'}]},
                    {'id': 'carrier', 'question': 'Carriers?', 'multiSelect': True, 'options': [{'label': 'Carrier A'}, {'label': 'Carrier B'}]},
                    {'id': 'secret', 'question': 'Private value?', 'isSecret': True},
                ]}
    page.evaluate('(event)=>deliver(event)', question)
    dialog = page.locator('#questionDialog')
    expect(dialog).to_be_visible()
    dialog.get_by_role('radio', name='No', exact=True).check()
    dialog.locator('.question-custom textarea').nth(1).fill('Unsubmitted desktop draft')
    dialog.locator('input[type="password"]').fill('private-desktop-draft')
    response = {**question, 'type': 'conversation:approval-resolved', 'allow': True, 'responseSeq': 2,
                'answers': {'router': 'Yes', 'carrier': ['Carrier A', 'Custom carrier'], 'secret': '••••••'}}
    page.evaluate('(event)=>deliver(event)', response)
    card = page.locator('#chat .question-card')
    expect(dialog).not_to_be_visible()
    expect(card).to_have_count(1)
    expect(card.locator('.question-status')).to_have_text('Answers sent')
    expect(card.locator('.question-answers')).to_contain_text('Yes')
    expect(card.locator('.question-answers')).to_contain_text('Carrier A · Custom carrier')
    expect(card.locator('.question-answers')).to_contain_text('••••••')
    expect(card).not_to_contain_text('Unsubmitted desktop draft')
    expect(card.locator('input[type="password"]')).to_have_value('')
    card.locator('.question-review summary').click()
    expect(card.get_by_role('radio', name='Yes', exact=True)).to_be_checked()
    expect(card.get_by_role('radio', name='No', exact=True)).not_to_be_checked()
    expect(card.get_by_role('checkbox', name='Carrier A', exact=True)).to_be_checked()
    expect(card.locator('.question-custom textarea').nth(1)).to_have_value('Custom carrier')
    page.evaluate('(event)=>receiveEvent(event)', response)
    expect(card).to_have_count(1)

    # A live snapshot has only the resolution, without the original request.
    for target in ['other', 'network']:
        page.evaluate('(id)=>openHistorySession(id)', target)
        page.wait_for_function('(id)=>context.sessionId === id && !loadingSession', arg=target)
    expect(dialog).not_to_be_visible()
    expect(card).to_have_count(1)
    expect(card.locator('.question-answers')).to_contain_text('Custom carrier')

    # Resolving a queued request must leave the current question open.
    first = {**question, 'requestId': 'first', 'questions': [{'id': 'scope', 'question': 'Scope?'}]}
    second = {**first, 'requestId': 'second'}
    page.evaluate('(event)=>deliver(event)', first)
    page.evaluate('(event)=>deliver(event)', second)
    page.evaluate('(event)=>deliver(event)', {**second, 'type': 'conversation:approval-resolved', 'allow': False})
    expect(dialog).to_be_visible()
    expect(dialog.locator('legend')).to_have_text('Scope?')
    expect(page.locator('#chat .question-card').last.locator('.question-status')).to_have_text('Questions skipped')
    dialog.locator('textarea').fill('Main workflow')
    dialog.get_by_role('button', name='Submit answers', exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.locator('#chat .question-card')).to_have_count(3)
    expect(page.locator('#chat .question-answers')).to_contain_text(['Yes', 'Main workflow', '—'])
    assert page.evaluate('submissions.length') == 1
    assert page.evaluate('pendingQuestion === null && permissionQueue.length === 0')

    # Completed history restores answer cards even when origin notices are hidden.
    page.evaluate('(event)=>deliver(event)', {'type': 'result', 'subtype': 'success', 'session_id': 'network',
                                           'engine': 'codex', 'runId': 41, 'result': 'Network check complete'})
    for target in ['other', 'network']:
        page.evaluate('(id)=>openHistorySession(id)', target)
        page.wait_for_function('(id)=>context.sessionId === id && !loadingSession', arg=target)
    expect(dialog).not_to_be_visible()
    expect(page.locator('#chat .question-card')).to_have_count(3)
    expect(page.locator('#chat')).to_contain_text('Custom carrier')
    expect(page.locator('#chat')).to_contain_text('Main workflow')
    expect(page.locator('#chat')).to_contain_text('Network check complete')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(preview / 'remote-question-answers.png'), animations='disabled')

    # Restarted native engines can reuse a prior request/run ID. Both saved
    # responses must survive because their transcript sequences are distinct.
    page.evaluate('''() => {
      const session = sessionFixtures.get('network');
      const previous = session.messages.find(row=>row.questionResponse);
      session.messages.push({...structuredClone(previous),seq:session.messages.length+1,
        questionResponse:{...previous.questionResponse,answers:{router:'No',carrier:['Carrier B'],secret:'••••••'}}});
    }''')
    page.evaluate('openHistorySession("network")')
    page.wait_for_function('!loadingSession')
    expect(page.locator('#chat .question-card')).to_have_count(4)
    expect(page.locator('#chat .question-answers').last).to_contain_text('Carrier B')
    expect(page.locator('#chat .question-answers').last).not_to_contain_text('Custom carrier')
    browser.close()
    assert not errors, errors
print('Remote question answers: live delivery, replay, history, skip and local response passed.')
