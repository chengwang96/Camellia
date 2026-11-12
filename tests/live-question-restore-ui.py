"""A pending AskUserQuestion must surface before a long live backlog replays.

Opening a running conversation restores its live snapshot. Questions used to
wait behind every earlier event, so the sidebar said "Needs input" while the
dialog stayed hidden for the whole replay. No model calls.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  const id='long-question', runId=77, events=[];
  for (let index=0; index<400; index++) {
    const tool={type:'gui:tool',session_id:id,engine:'claude',runId,id:'tool-'+index,name:'Read',input:{file_path:'D:/fixture/'+index+'.txt'}};
    events.push({...tool,status:'in_progress',eventSeq:events.length+1});
    events.push({...tool,status:'completed',output:'Result '+index,eventSeq:events.length+1});
  }
  const questions=[{id:'route',question:'Which route next?',header:'Next route',
    options:[{label:'Light hand'},{label:'Rod'}]}];
  events.push({type:'gui:permission',session_id:id,engine:'claude',runId,eventSeq:events.length+1,
    requestId:'ask-late',toolName:'AskUserQuestion',input:{questions},questions});
  const history=[{role:'user',seq:1,text:'Start'},{role:'assistant',seq:2,engine:'claude',text:'Saved history anchor'}];
  const live={sessionId:id,workspaceId:null,engine:'claude',runId,userSeq:3,prompt:'Continue',displayText:'Continue',
    messages:history,events,eventSeq:events.length,startedAt:Date.now()};
  const session={id,title:'Long question',currentEngine:'claude',activity:'question',mtimeMs:Date.now(),
    messages:[...history,{role:'user',seq:3,text:'Continue'}],live};
  window.submissions=[];
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},
    onConversationEvent:fn=>window.receiveEvent=fn,onConversationGoal:()=>{},onConversationStatus:()=>{},onHarnessNavigate:()=>{},
    apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',showOrigin:false}}),
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
    conversationSwitch:async()=>({ok:true}),
    conversationCommand:async({action,payload})=>{
      if(action === 'list-sessions') return {ok:true,sessions:[session],workspaces:[],pagination:{}};
      if(action === 'get-settings') return settings;
      if(action === 'goal-get') return {ok:true,goal:null};
      if(action === 'task-list') return {ok:true,tasks:[]};
      if(action === 'get-live') return {ok:true,live:session.live};
      if(action === 'load-session') return {ok:true,...structuredClone(session),settings};
      if(action === 'control-respond') { window.submissions.push(payload); return {ok:true}; }
      return {ok:true};
    },
  };
})();"""

hold_yields = r"""(() => {
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.restoreYieldCallbacks = [];
  window.holdRestoreYield = false;
  window.setTimeout = (callback, delay = 0, ...args) => {
    if(window.holdRestoreYield && delay === 0) {
      window.restoreYieldCallbacks.push(() => callback(...args));
      return -1;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };
  window.releaseRestoreYield = () => {
    for(const callback of window.restoreYieldCallbacks.splice(0)) callback();
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 850})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.add_init_script(hold_yields)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=claude', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.evaluate('window.holdRestoreYield=true; void openHistorySession("long-question")')
    page.wait_for_function('replayingLiveSnapshot && restoreYieldCallbacks.length > 0')

    # The question must be answered now, not after the 800-event backlog.
    dialog = page.locator('#questionDialog')
    expect(dialog).to_be_visible()
    assert page.evaluate('pendingQuestion?.requestId') == 'ask-late'
    assert page.evaluate('restoreYieldCallbacks.length > 0') is True

    for _ in range(400):
        if page.evaluate('!replayingLiveSnapshot && !loadingSession'):
            break
        page.evaluate('releaseRestoreYield()')
        page.wait_for_timeout(5)
    page.wait_for_function('context.sessionId === "long-question" && !loadingSession && !replayingLiveSnapshot')
    expect(dialog).to_be_visible()
    expect(page.locator('#chat .question-pending')).to_have_count(1)
    expect(page.locator('.run-status')).to_contain_text('Waiting for your answer')
    assert page.locator('.tool-card').count() == 400

    dialog.get_by_role('radio', name='Light hand', exact=True).check()
    dialog.get_by_role('button', name='Submit answers', exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.locator('#chat .question-card .question-status')).to_have_text('Answers sent')
    submission = page.evaluate('submissions.at(-1)')
    assert submission['requestId'] == 'ask-late' and submission['runId'] == 77
    assert submission['input'] == {'route': 'Light hand'}
    assert page.evaluate('pendingQuestion === null && permissionQueue.length === 0')
    assert errors == []
    browser.close()
    print('live question restore: ok')
