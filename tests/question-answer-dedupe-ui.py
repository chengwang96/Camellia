"""An answered question must produce one card whichever IPC message wins.

The approval-resolved broadcast and the control-respond reply can arrive in
either order. The reply carries the durable response sequence so the answered
card can be keyed once, before the event replays. No model calls.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  const live = {sessionId:'network',workspaceId:null,engine:'claude',runId:41,userSeq:1,
    prompt:'Check the network',messages:[],events:[],eventSeq:0,startedAt:Date.now()};
  const session = {id:'network',title:'Network diagnosis',currentEngine:'claude',activity:'running',mtimeMs:Date.now(),
    messages:[{role:'user',seq:1,text:live.prompt}],live};
  const sessions = new Map([[session.id,session]]);
  window.sessionFixtures = sessions;
  window.submissions = [];
  window.replyFirst = false;
  window.deliver = event => {
    if (session.live) {
      event.eventSeq = ++session.live.eventSeq;
      if (event.type === 'conversation:approval-resolved') {
        session.live.events = session.live.events.filter(e => e.type !== 'gui:permission' || e.requestId !== event.requestId);
        event.responseSeq = event.responseSeq ?? session.messages.length+1;
        session.messages.push({role:'notice',seq:event.responseSeq,engine:'claude',text:'Answers sent',questionResponse:event});
      }
      session.live.events.push(event);
      session.activity = session.live.events.some(e => e.type === 'gui:permission') ? 'question' : 'running';
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
    conversationSwitch:async()=>({ok:true}),
    conversationCommand:async({action,payload})=>{
      if(action === 'list-sessions') return {ok:true,sessions:[...sessions.values()],workspaces:[],pagination:{}};
      if(action === 'get-settings') return settings;
      if(action === 'goal-get') return {ok:true,goal:null};
      if(action === 'task-list') return {ok:true,tasks:[]};
      if(action === 'get-live') return {ok:true,live:sessions.get(payload?.sessionId)?.live || null};
      if(action === 'load-session') return {ok:true,...structuredClone(sessions.get(payload)),settings};
      if(action === 'control-respond') {
        submissions.push(payload);
        const request = session.live?.events.find(e=>e.type === 'gui:permission' && e.requestId === payload.requestId);
        if (!request) return {ok:false};
        const answers = Object.fromEntries(request.questions.map(q=>[q.id,q.isSecret?'••••••':payload.input?.[q.id]]));
        const response = {type:'conversation:approval-resolved',session_id:session.id,engine:'claude',runId:41,
          requestId:payload.requestId,questions:request.questions,allow:payload.allow,...(payload.allow?{answers}:{})};
        // The main process assigns the transcript sequence before returning.
        const responseSeq = session.messages.length + 1;
        if (window.replyFirst) setTimeout(()=>deliver({...response,responseSeq}),0);
        else deliver({...response,responseSeq});
        return {ok:true,responseSeq};
      }
      return {ok:true};
    },
  };
})();"""

def answer(page, request_id, question, *, reply_first):
    page.evaluate('(flag)=>{window.replyFirst=flag}', reply_first)
    page.evaluate('(event)=>deliver(event)', {'type': 'gui:permission', 'session_id': 'network', 'engine': 'claude',
        'runId': 41, 'requestId': request_id, 'questions': [question]})
    dialog = page.locator('#questionDialog')
    expect(dialog).to_be_visible()
    dialog.get_by_role('radio', name='Yes', exact=True).check()
    dialog.get_by_role('button', name='Submit answers', exact=True).click()
    expect(dialog).not_to_be_visible()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 850})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="network"]').click()
    page.wait_for_function('context.sessionId === "network" && !loadingSession')

    question = {'id': 'router', 'question': 'Same router?', 'options': [{'label': 'Yes'}, {'label': 'No'}]}

    # Reply first, approval event one macrotask later. This used to append a
    # second "Answers sent" card under the saved-response key.
    answer(page, 'reply-first', question, reply_first=True)
    cards = page.locator('#chat .question-card')
    expect(cards).to_have_count(1)
    expect(cards.locator('.question-status')).to_have_text('Answers sent')
    assert page.evaluate('document.querySelector("#chat .question-card").dataset.questionKey').endswith(
        ',"response",2]')

    # The original ordering still leaves exactly one card.
    answer(page, 'event-first', {**question, 'id': 'carrier', 'question': 'Same carrier?'}, reply_first=False)
    expect(cards).to_have_count(2)
    expect(cards.last.locator('.question-status')).to_have_text('Answers sent')
    assert page.evaluate('document.querySelectorAll("#chat .question-card")[1].dataset.questionKey').endswith(
        ',"response",3]')

    # Replaying the conversation from history keeps one card per response.
    for _ in range(2):
        page.evaluate('(id)=>openHistorySession(id)', 'network')
        page.wait_for_function('context.sessionId === "network" && !loadingSession')
        expect(cards).to_have_count(2)
    browser.close()
    assert not errors, errors
print('Question answer dedupe: reply-first, event-first and history restore passed.')
