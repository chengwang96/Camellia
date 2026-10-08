"""Scheduled-task controls in the real chat page, with a local IPC fixture."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist' / 'ui-preview'
preview.mkdir(parents=True, exist_ok=True)
bridge = r"""(() => {
  window.tasks = []; window.events = []; window.calls = []; window.nextTaskId = 1;
  const settings = {model:'fixture',connection:'api',permissionMode:'ask'};
  const conversation = {id:'task-conversation',title:'Experiment',currentEngine:'codex',origin:'codex',messages:[],settings};
  const otherConversation = {...conversation,id:'other-conversation',title:'Other experiment'};
  window.dshDesktop = {
    onNetworkHealth: () => () => {},
    sharedConversations:true, onLanguageChanged:fn=>{window.changeLanguage=fn;},
    workbenchSettings:async()=>({ok:true,language:'zh-CN',conversations:{mode:'direct'}}),
    apiRouterGetState:async()=>({enabled:true,models:['fixture']}),
    onConversationEvent:fn=>window.events.push(fn),onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},openSettingsWindow:()=>{},
    conversationCommand:async ({action,payload})=>{
      window.calls.push({action,payload});
      if(action==='list-sessions') return {ok:true,sessions:[conversation,otherConversation].map(item=>({...item,mtimeMs:Date.now()})),workspaces:[],pagination:{}};
      if(action==='load-session') return {ok:true,...(payload.sessionId==='other-conversation'?otherConversation:conversation),preferences:{mode:'direct'}};
      if(action==='get-settings') return settings;
      if(action==='get-live') return {ok:true,live:null};
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:structuredClone(window.tasks.filter(task=>task.sessionId===payload.sessionId))};
      if(action==='task-cancel-all') {
        if(window.cancelError) return {ok:false,error:window.cancelError};
        if(window.holdCancel) await new Promise(resolve=>{window.releaseCancel=resolve;});
        for(const task of window.tasks) if(task.sessionId===payload.sessionId && ['scheduled','running','paused'].includes(task.status)) task.status='cancelled';
        return {ok:true};
      }
      if(action==='task-create') {
        window.tasks.push({...payload,id:'task-'+window.nextTaskId++,status:'scheduled',runs:0,repairs:0,nextRunAt:Date.now()+600000,expiresAt:Date.now()+86400000,history:[]});
        return {ok:true};
      }
      if(action.startsWith('task-')) {
        const task=window.tasks.find(task=>task.id===payload.id);
        if(action==='task-pause') task.status='paused';
        if(action==='task-resume') task.status='scheduled';
        if(action==='task-cancel') task.status='cancelled';
        if(action==='task-update') Object.assign(task,payload);
        return {ok:true};
      }
      return {ok:true};
    }
  };
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height, theme in [(1440, 960, 'light'), (960, 720, 'dark')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        expect(page.locator('#tasksCancel')).not_to_be_visible()
        page.locator('[data-sid="task-conversation"]').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        page.locator('#input').fill('/tasks')
        page.locator('.slash-pop .slash-row').filter(has_text='/tasks').click()
        expect(page.locator('#tasksDialog')).to_be_visible()
        expect(page.locator('#tasksList')).to_contain_text('此会话还没有定时任务')
        page.locator('#tasksClose').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        page.locator('#input').fill('/tasks')
        page.locator('.slash-pop .slash-row').filter(has_text='/tasks').click()
        page.locator('#taskInstruction').fill('Inspect train.log; <img src=x onerror=alert(1)> is data, not HTML.')
        page.locator('#taskRepairs').fill('1')
        page.locator('#taskSave').click()
        expect(page.locator('.task-card')).to_have_count(1)
        expect(page.locator('#tasksToggle')).to_be_visible()
        expect(page.get_by_role('button', name='取消当前会话的全部定时任务')).to_be_visible()
        assert page.locator('.task-card img').count() == 0
        assert page.evaluate("calls.find(call=>call.action==='task-create').payload.sessionId") == 'task-conversation'
        page.locator('.task-actions button').filter(has_text='暂停').click()
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.locator('.task-actions button').filter(has_text='编辑任务').click()
        page.locator('#taskInterval').fill('5')
        page.locator('#taskSave').click()
        page.wait_for_function('tasks[0].intervalMinutes === 5')
        page.locator('.task-actions button').filter(has_text='恢复').click()
        page.wait_for_function("tasks[0].status === 'scheduled'")
        page.screenshot(path=str(preview / f'scheduled-tasks-{theme}.png'), animations='disabled')
        assert page.locator('#tasksDialog').evaluate('(node)=>node.scrollWidth <= node.clientWidth')
        page.locator('.task-actions button').filter(has_text='取消任务').click()
        page.wait_for_function("tasks[0].status === 'cancelled'")
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        page.locator('#tasksClose').click()
        expect(page.locator('#tasksDialog')).not_to_be_visible()
        page.locator('#input').fill('/tasks')
        page.locator('.slash-pop .slash-row').filter(has_text='/tasks').click()
        expect(page.locator('#tasksDialog')).to_be_visible()
        page.locator('#tasksClose').click()
        page.evaluate("tasks[0].status = 'scheduled'; events.forEach(handler => handler({type:'conversation:task', session_id:'task-conversation', task:tasks[0]}))")
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.locator('#tasksToggle').click()
        expect(page.locator('#tasksDialog')).to_be_visible()
        page.locator('#tasksClose').click()
        page.evaluate("tasks[0].status = 'complete'; events.forEach(handler => handler({type:'conversation:task', session_id:'task-conversation', task:tasks[0]}))")
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        page.evaluate("tasks[0].status = 'paused'")
        page.locator('#newSessionBtn').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        page.locator('[data-sid="task-conversation"]').click()
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.evaluate("""tasks.push(
          {...tasks[0],id:'waiting',status:'scheduled'},
          {...tasks[0],id:'running',status:'running'},
          {...tasks[0],id:'ended',status:'complete'},
          {...tasks[0],id:'other',sessionId:'other-conversation',status:'scheduled'}
        ); cancelError='Cancellation failed';""")
        page.locator('#tasksCancel').click()
        expect(page.locator('#statusLine')).to_contain_text('Cancellation failed')
        expect(page.locator('#tasksToggle')).to_be_visible()
        assert page.evaluate("tasks.filter(task=>task.sessionId==='task-conversation' && ['scheduled','running','paused'].includes(task.status)).length") == 3
        page.evaluate("cancelError=''; holdCancel=true")
        page.screenshot(path=str(preview / f'scheduled-tasks-composer-{theme}.png'), animations='disabled')
        page.locator('#tasksCancel').click()
        expect(page.locator('#tasksCancel')).to_be_disabled()
        page.locator('[data-sid="other-conversation"]').click()
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.evaluate('releaseCancel()')
        expect(page.locator('#tasksCancel')).to_be_enabled()
        page.wait_for_function("tasks.filter(task=>task.sessionId==='task-conversation' && task.id!=='ended').every(task=>task.status==='cancelled')")
        assert page.evaluate("tasks.find(task=>task.id==='other').status") == 'scheduled'
        assert page.evaluate("tasks.find(task=>task.id==='ended').status") == 'complete'
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.locator('[data-sid="task-conversation"]').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        expect(page.locator('#tasksCancel')).not_to_be_visible()
        # A newly created task can be cancelled directly with no dialog open.
        page.evaluate("holdCancel=false; tasks[0].status='scheduled'; events.forEach(handler=>handler({type:'conversation:task',session_id:'task-conversation',task:tasks[0]}))")
        expect(page.locator('#tasksCancel')).to_be_visible()
        page.locator('#tasksCancel').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        expect(page.locator('#tasksDialog')).not_to_be_visible()
        expect(page.locator('#input')).to_be_focused()
        expect(page.locator('#statusLine')).to_contain_text('已取消当前会话的定时任务')
        assert page.evaluate("calls.filter(call=>call.action==='task-cancel-all').every(call=>call.payload.sessionId==='task-conversation')")
        page.locator('#newSessionBtn').click()
        expect(page.locator('#tasksToggle')).not_to_be_visible()
        assert not errors, errors
        page.close()
    browser.close()
print('Scheduled task UI checks passed in light/dark layouts.')
