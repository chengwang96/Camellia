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
    conversationSwitch:async()=>({ok:true}),
    conversationCommand:async ({action,payload})=>{
      window.calls.push({action,payload});
      if(action==='list-sessions') return {ok:true,sessions:[conversation,otherConversation].map(item=>({...item,mtimeMs:Date.now()})),workspaces:[],pagination:{}};
      if(action==='load-session') return {ok:true,...(payload.sessionId==='other-conversation'?otherConversation:conversation),preferences:{mode:'direct'}};
      if(action==='get-settings') return settings;
      if(action==='get-live') return {ok:true,live:null};
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,waitingFor:window.waitingFor||null,tasks:structuredClone(window.tasks.filter(task=>task.sessionId===payload.sessionId))};
      if(action==='task-cancel-all') {
        if(window.cancelError) return {ok:false,error:window.cancelError};
        if(window.holdCancel) await new Promise(resolve=>{window.releaseCancel=resolve;});
        for(const task of window.tasks) if(task.sessionId===payload.sessionId && ['scheduled','running','paused'].includes(task.status)) task.status='cancelled';
        return {ok:true};
      }
      if(action==='task-create') {
        window.tasks.push({...payload,id:'task-'+window.nextTaskId++,status:'scheduled',runs:0,repairs:0,createdAt:Date.now(),nextRunAt:Date.now()+600000,expiresAt:Date.now()+payload.maxHours*3600000,history:[]});
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
        page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme, has_touch=width < 520)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
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
        expect(page.locator('#input')).to_be_enabled()
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
    # Long, real-world instructions must not bury the controls. Test narrow
    # workbench windows independently of the native Android/iOS clients.
    for width, height, theme, language in [(1440, 960, 'light', 'zh-CN'), (960, 720, 'dark', 'en'),
                                           (360, 800, 'light', 'zh-CN'), (393, 873, 'dark', 'en'),
                                           (412, 915, 'dark', 'zh-CN'), (740, 360, 'light', 'en')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, color_scheme=theme, has_touch=width < 520)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge.replace("language:'zh-CN'", f"language:'{language}'"))
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.evaluate(r"""tasks = [{id:'long-task',sessionId:'task-conversation',status:'scheduled',runs:1,maxRuns:48,repairs:0,maxRepairs:0,
          intervalMinutes:60,maxHours:48,nextRunAt:1794910000000,expiresAt:1795080000000,
          instruction:('Inspect process memory, system pressure, disk space and log growth; preserve evidence without claiming an unproven leak.\n').repeat(45),
          lastResult:('2026-11-17 16:58 HKT · 62 samples over 61 minutes; no new sustained growth. ').repeat(12),
          history:[{at:1794906000000,message:'Task scheduled'}, {at:1794909600000,message:'Complete evidence '.repeat(120)}]}];""")
        page.locator('[data-sid="task-conversation"]').evaluate('(node)=>node.click()')
        expect(page.locator('#tasksToggle')).to_be_visible()
        page.locator('#tasksToggle').evaluate('(node)=>node.click()')
        expect(page.locator('#tasksDialog')).to_be_visible()
        expect(page.locator('#tasksEditor')).not_to_have_attribute('open', '')
        assert page.locator('.task-preview').bounding_box()['height'] <= 48
        assert page.locator('#tasksDialog').evaluate('(node)=>node.scrollWidth <= node.clientWidth')
        assert page.locator('#tasksDialog').bounding_box()['height'] <= height - 20
        page.screenshot(path=str(preview / f'tasks-compact-{width}-{theme}-{language}.png'), animations='disabled')
        page.locator('.task-instruction > summary').click()
        expect(page.locator('.task-instruction-full')).to_have_text(page.evaluate('tasks[0].instruction'))
        # A live task update keeps the full instruction expanded.
        page.evaluate("tasks[0].runs=2; events.forEach(handler=>handler({type:'conversation:task',session_id:'task-conversation',task:tasks[0]}))")
        expect(page.locator('.task-counts')).to_contain_text('2/48')
        expect(page.locator('.task-instruction')).to_have_attribute('open', '')
        expect(page.locator('.task-instruction > summary')).to_be_focused()
        page.locator('.task-instruction > summary').click()
        page.locator('.task-history > summary').click()
        expect(page.locator('.task-history li').first).to_contain_text('Complete evidence')
        page.locator('.task-history > summary').click()
        page.locator('#taskEditorTitle').click()
        page.locator('#taskInstruction').fill('Draft remains while inspecting existing tasks.')
        page.locator('#taskSave').scroll_into_view_if_needed()
        expect(page.locator('#taskSave')).to_be_in_viewport()
        page.screenshot(path=str(preview / f'tasks-form-{width}-{theme}-{language}.png'), animations='disabled')
        # Clicking panel padding does not dismiss; clicking the backdrop does.
        page.locator('.tasks-header h2').click()
        expect(page.locator('#tasksDialog')).to_be_visible()
        if width < 520:
            page.touchscreen.tap(2, height / 2)
        else:
            page.mouse.click(2, height / 2)
        expect(page.locator('#tasksDialog')).not_to_be_visible()
        page.locator('#tasksToggle').evaluate('(node)=>node.click()')
        expect(page.locator('#tasksDialog')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('#tasksDialog')).not_to_be_visible()
        # Dragging a selection out of the panel must not close it.
        page.locator('#tasksToggle').evaluate('(node)=>node.click()')
        bounds = page.locator('.task-preview').bounding_box()
        page.mouse.move(bounds['x'] + 5, bounds['y'] + 5)
        page.mouse.down(); page.mouse.move(2, height / 2); page.mouse.up()
        expect(page.locator('#tasksDialog')).to_be_visible()
        page.locator('#tasksClose').click()
        assert not errors, errors
        page.close()
    # Exercise the new schedule editor in both languages and in short/narrow windows.
    for language in ['zh-CN', 'en']:
        for width, height in [(1440, 960), (390, 844), (844, 390)]:
            page = browser.new_page(viewport={'width': width, 'height': height})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.evaluate('(language)=>changeLanguage(language)', language)
            if not page.locator('[data-sid="task-conversation"]').is_visible():
                page.locator('#workbenchSidebarToggle').click()
            page.locator('[data-sid="task-conversation"]').click()
            page.locator('#input').fill('/tasks')
            page.locator('.slash-pop .slash-row').filter(has_text='/tasks').click()
            page.locator('#taskInstruction').fill('Inspect the existing log')
            expect(page.locator('#taskPreview')).to_contain_text('预计检查至' if language == 'zh-CN' else 'Without delays')
            page.locator('#taskSchedule').select_option('daily')
            expect(page.locator('#taskRunAt')).not_to_be_visible()
            expect(page.locator('#taskInterval')).not_to_be_visible()
            page.locator('#taskDailyTime').fill('09:30')
            page.locator('#taskZone').fill('Asia/Hong_Kong')
            expect(page.locator('#taskPreview')).to_contain_text('09:30')
            expect(page.locator('#taskHours')).to_have_value('168')
            page.screenshot(path=str(preview / f'task-daily-{language}-{width}x{height}.png'), animations='disabled')
            assert page.locator('#tasksDialog').evaluate('(node)=>node.scrollWidth <= node.clientWidth')
            page.locator('#taskSave').click()
            page.wait_for_function("tasks.length===1 && tasks[0].scheduleType==='daily'")
            assert page.evaluate('tasks[0].timeZone') == 'Asia/Hong_Kong'
            expect(page.locator('.task-schedule')).to_contain_text('09:30')
            # A lifecycle pause reason is visible without replacing the check evidence.
            page.evaluate("""tasks[0].status='paused'; tasks[0].pauseReason='run-limit';
              tasks[0].lastResult='Healthy'; waitingFor='goal';
              events.forEach(fn=>fn({type:'conversation:task',session_id:'task-conversation',task:tasks[0]}));""")
            expect(page.locator('.task-notice')).to_contain_text('次数已用完' if language == 'zh-CN' else 'Check limit reached')
            expect(page.locator('.task-result')).to_contain_text('Healthy')
            expect(page.locator('#tasksConflict')).to_be_visible()
            page.locator('.task-actions button').filter(has_text='编辑任务' if language == 'zh-CN' else 'Edit task').click()
            expect(page.locator('#taskSchedule')).to_have_value('daily')
            expect(page.locator('#taskZone')).to_have_value('Asia/Hong_Kong')
            page.locator('#taskSchedule').select_option('once')
            expect(page.locator('#taskZone')).not_to_be_visible()
            expect(page.locator('#taskDailyTime')).not_to_be_visible()
            expect(page.locator('#taskRunAt')).to_be_visible()
            expect(page.locator('#taskRuns')).to_have_value('1')
            page.locator('#taskSave').click()
            page.wait_for_function("tasks[0].scheduleType==='once'")
            assert page.evaluate("tasks[0].runAt.endsWith('Z')")
            page.evaluate("""tasks[0].status='cancelled'; tasks[0].stopping=true;
              events.forEach(fn=>fn({type:'conversation:task',session_id:'task-conversation',task:tasks[0]}));""")
            expect(page.locator('#tasksToggle')).to_be_visible()
            expect(page.locator('.task-status')).to_contain_text('正在停止' if language == 'zh-CN' else 'Stopping')
            expect(page.locator('.task-actions button')).to_have_count(0)
            page.evaluate("tasks[0].stopping=false; events.forEach(fn=>fn({type:'conversation:task',session_id:'task-conversation',task:tasks[0]}))")
            expect(page.locator('#tasksToggle')).not_to_be_visible()
            assert not errors, errors
            page.close()
    browser.close()
print('Scheduled task lifecycle, long content, outside dismissal and responsive UI checks passed.')
