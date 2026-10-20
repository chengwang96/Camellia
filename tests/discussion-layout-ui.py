"""Compare discussion elements with the actual normal-chat page. No model calls."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
prompt = '请帮我核对研究方案，并列出需要补充的验证。'
reply = '[布局测试] 先确定研究问题，再检查方法是否能回答它。\n\n## 需要补充的验证\n\n- 明确主要结果和对照条件\n- 保留不同成员提出的分歧\n\n```python\nresult = compare_methods(primary="baseline", alternative="new_method", validation="independent data")\n```'
chat = {'id': 'chat-fixture', 'title': '研究方案评审', 'origin': 'codex', 'currentEngine': 'codex', 'workspaceId': None,
        'messages': [{'role': 'user', 'text': prompt}, {'role': 'assistant', 'engine': 'codex', 'text': reply}]}
members = [{'id': f'member-{i}', 'name': name, 'engine': engine, 'model': model, 'connection': 'subscription',
            'accountLabel': '布局测试账号', 'removed': False, 'capability': {'available': False, 'reason': 'unverified-connection'}}
           for i, (name, engine, model) in enumerate([('方案设计', 'codex', 'gpt-test'), ('方法评审', 'antigravity', 'gemini-test'),
                                                       ('独立复核', 'codex', 'gpt-test'), ('结论复核', 'antigravity', 'gemini-test')])]
group = {'id': 'group-fixture', 'title': chat['title'], 'revision': 1, 'participants': members,
         'messages': [{'id': 'user-one', 'seq': 1, 'role': 'user', 'text': prompt, 'requestId': 'request-one'},
                      {'id': 'reply-one', 'seq': 2, 'role': 'assistant', 'speakerId': 'member-0', 'speakerName': members[0]['name'],
                       'text': reply, 'requestId': 'request-one', 'deliveryId': 'delivery-one'}],
         'requests': [{'id': 'request-one', 'messageId': 'user-one', 'mode': 'parallel', 'deliveryIds': ['delivery-one']}],
         'deliveries': [{'id': 'delivery-one', 'requestId': 'request-one', 'participantId': 'member-0', 'status': 'completed'}]}
bridge = r"""(() => {
  window.requestIdleCallback = undefined;
  const fixture = CHAT, group = GROUP, template = TEMPLATE;
  const preferences = {mode:'direct',warnOnSwitch:false,showOrigin:false};
  const settings = {model:'gpt-test',connection:'subscription',permissionMode:'ask'};
  window.fixtureSends = [];
  window.fixtureCommands = []; window.extraSessions = []; window.fixtureChat = fixture; window.fixtureGroup = group;
  window.fixtureGroups = [group]; window.pendingDiscussionSends = [];
  const discussionRows = () => fixtureGroups.map(row=>({id:row.id,title:row.title,members:row.participants.length}));
  window.finishDiscussionSend = (index, failure='') => {
    const {payload,resolve} = pendingDiscussionSends[index], source = fixtureGroups.find(row=>row.id===payload.id);
    source.verifying=false; source.revision++;
    if (!failure) source.messages.push({id:payload.requestId,seq:source.messages.length+1,role:'user',requestId:payload.requestId,text:payload.text});
    resolve(failure ? {ok:false,error:failure} : {ok:true,group:structuredClone(source),groups:discussionRows()});
    emitDiscussion({discussionId:source.id});
  };
  const chatListeners = new Set(), discussionListeners = new Set();
  window.emitDiscussion = event => { for (const fn of discussionListeners) fn(event); };
  window.fixtureActivity = activity => { fixture.activity = activity; for (const fn of chatListeners) fn({type:'conversation:activity',session_id:fixture.id,engine:'codex',activity}); };
  window.modeNavigations = []; window.handoffs = []; window.failNavigation = false;
  window.dshDesktop = {
    sharedConversations:true, onLanguageChanged:fn=>{window.changeLanguage=fn;return()=>{};},
    onChatContentWidthChanged:fn=>{window.changeWidth=fn;return()=>{};},
    workbenchSettings:async()=>({ok:true,language:'zh-CN',chatContentWidth:'standard',conversations:preferences}),
    conversationCommand:async ({action}) => {
      window.fixtureCommands.push(action);
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()},...window.extraSessions],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,preferences,settings};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    discussion:async (action,payload) => {
      if(action==='list') return {ok:true,groups:discussionRows()};
      if(action==='template') return {ok:true,html:template};
      if(action==='load') {window.modeNavigations.push('discussions');if(window.delayDiscussionLoad) await new Promise(resolve=>window.releaseDiscussionLoad=resolve);return window.failNavigation ? {ok:false,error:'Mode navigation failed.'} : {ok:true,group:fixtureGroups.find(row=>row.id===payload.id)};}
      if(action==='open') {window.modeNavigations.push('discussions');return window.failNavigation ? {ok:false,error:'Mode navigation failed.'} : {ok:true};}
      if(action==='send') {
        window.fixtureSends.push(payload);
        const source=fixtureGroups.find(row=>row.id===payload.id);
        if(window.holdDiscussionSends) {source.verifying=true;emitDiscussion({discussionId:source.id});return new Promise(resolve=>pendingDiscussionSends.push({payload,resolve}));}
        return {ok:true,group:source};
      }
      return {ok:false,error:'Layout fixture has no model connection.'};
    },
    onDiscussionEvent:fn=>{discussionListeners.add(fn);return()=>discussionListeners.delete(fn);},
    conversationSwitch:async payload=>{window.handoffs.push(payload);return window.failNavigation ? {ok:false,error:'Mode navigation failed.'} : {ok:true};}, apiRouterGetState:async()=>({enabled:true,models:['gpt-test']}),
    codexAccountState:async()=>({ok:true,models:[{id:'gpt-test',name:'gpt-test'}]}),
    onConversationEvent:fn=>{chatListeners.add(fn);return()=>chatListeners.delete(fn);},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},onHarnessNavigate:()=>{},
    openSettingsWindow:()=>{},switchMode:async mode=>{window.modeNavigations.push(mode);return window.failNavigation ? {ok:false,error:'Mode navigation failed.'} : {ok:true};},
    previewFile:async()=>({ok:false}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('CHAT', json.dumps(chat)).replace('GROUP', json.dumps(group)).replace('TEMPLATE', json.dumps((repo / 'src/renderer/discussions/discussions.html').read_text(encoding='utf8'))).replace('preview:prompt', 'preview:' + json.dumps(prompt))


def styles(page, selector, properties):
    return page.locator(selector).first.evaluate('(node,props)=>Object.fromEntries(props.map(p=>[p,getComputedStyle(node)[p]]))', properties)


def bounds(page, selector):
    return page.locator(selector).bounding_box()


def check_execution_process(page, theme, embedded=False):
    page.set_viewport_size({'width': 1440, 'height': 960})
    messages = page.locator('#discussionSurface #messages' if embedded else '#messages')
    expect(messages.locator('.execution-process')).to_have_count(0)
    page.evaluate("""() => {
      fixtureGroup.deliveries[0].tools = [
        {id:'read',name:'read_file',input:{path:'notes.txt'},status:'completed',output:'Evidence found'},
        {id:'verify',name:'shell',input:{command:'verify notes.txt'},status:'completed',output:'Verified'}
      ];
      fixtureGroup.revision++; emitDiscussion({discussionId:fixtureGroup.id});
    }""")
    history = messages.locator('[data-message-id="reply-one"]')
    process = history.locator('.execution-process')
    expect(process.locator('summary')).to_contain_text('执行过程')
    expect(process.locator('.execution-process-count')).to_have_text('2 次工具调用')
    expect(process).not_to_have_attribute('open', '')
    expect(process.locator('.tool-card')).to_have_count(2)
    expect(process.locator('.tool-card').first).not_to_be_visible()
    expect(history.locator('.message-body')).to_contain_text('需要补充的验证')
    process.locator('summary').focus()
    page.keyboard.press('Enter')
    process.locator('.tool-head').first.click()
    expect(process.locator('.tool-output').first).to_be_visible()
    page.evaluate("""() => {
      fixtureGroup.deliveries.push({id:'live-tools',requestId:'request-one',participantId:'member-1',status:'running',partialText:'Latest progress',
        tools:[{id:'inspect',name:'read_file',input:{path:'evidence.txt'},status:'running',output:'Inspecting'}]});
      fixtureGroup.revision++; emitDiscussion({discussionId:fixtureGroup.id});
    }""")
    live = messages.locator('[data-delivery-id="live-tools"]')
    live_process = live.locator('.execution-process')
    expect(live_process).not_to_have_attribute('open', '')
    expect(live.locator('.message-body')).to_have_text('Latest progress')
    live_process.locator('summary').click()
    live_process.locator('.tool-head').click()
    page.evaluate("""() => {
      const delivery = fixtureGroup.deliveries.find(d=>d.id==='live-tools');
      delivery.tools[0].status='completed'; delivery.tools[0].output='New evidence';
      delivery.tools.push({id:'check',name:'shell',input:{command:'verify evidence.txt'},status:'completed',output:'Checked'});
      delivery.partialText='Updated progress'; fixtureGroup.revision++; emitDiscussion({discussionId:fixtureGroup.id});
    }""")
    expect(live.locator('.message-body')).to_have_text('Updated progress')
    expect(live_process).to_have_attribute('open', '')
    expect(live_process.locator('.execution-process-count')).to_have_text('2 次工具调用')
    expect(live_process.locator('.tool-output').first).to_be_visible()
    expect(live_process.locator('.tool-output').first).to_have_text('New evidence')
    expect(process).to_have_attribute('open', '')
    page.evaluate("""() => {
      const delivery = fixtureGroup.deliveries.find(d=>d.id==='live-tools'); delivery.status='completed'; delete delivery.partialText;
      fixtureGroup.messages.push({id:'reply-two',seq:3,role:'assistant',speakerId:'member-1',speakerName:'方法评审',
        requestId:'request-one',deliveryId:delivery.id,text:'Verified final answer'});
      fixtureGroup.revision++; emitDiscussion({discussionId:fixtureGroup.id});
    }""")
    completed = messages.locator('[data-message-id="reply-two"]')
    expect(live).to_have_count(0)
    expect(completed.locator('.execution-process')).not_to_have_attribute('open', '')
    expect(completed.locator('.message-body')).to_have_text('Verified final answer')
    expect(completed.locator('.message-body')).to_be_visible()
    expect(process).to_have_attribute('open', '')
    page.evaluate("CamelliaI18n.setLanguage('en')")
    expect(history.locator('.execution-process > summary')).to_contain_text('Execution process')
    expect(history.locator('.execution-process-count')).to_have_text('2 tool calls')
    page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
    expect(process.locator('summary')).to_contain_text('执行过程')
    process.locator('summary').click()
    kind = 'embedded' if embedded else 'standalone'
    page.screenshot(path=str(preview / f'discussion-execution-process-{kind}-{theme}.png'), animations='disabled')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(preview / f'discussion-execution-process-{kind}-narrow-{theme}.png'), animations='disabled')


def check_verification_navigation(page, embedded=False):
    page.set_viewport_size({'width': 1440, 'height': 960})
    surface = page.locator('#discussionSurface') if embedded else page.locator('body')
    rows = '#discussionSessions' if embedded else '#groupList'
    page.evaluate("""() => {
      const other = structuredClone(fixtureGroup);
      Object.assign(other,{id:'other-group',title:'Another discussion',messages:[],requests:[],deliveries:[],verifying:false});
      fixtureGroups.push(other); window.holdDiscussionSends=true; emitDiscussion({discussionId:fixtureGroup.id});
    }""")
    page.locator(rows + ' [data-group-id="other-group"]').wait_for()
    surface.locator('#mentions .mention').first.click()
    surface.locator('#message').fill('Verify the source group before sending')
    surface.locator('#message').press('Enter')
    expect(surface.locator('#sendHint')).to_contain_text('正在检查连接')
    surface.locator('#message').fill('A newer source draft')
    # A pending verification cannot prevent ordinary conversation navigation.
    before = page.evaluate('handoffs.length')
    page.locator('#sessionList [data-sid="chat-fixture"]' if embedded else '#conversationNavigation [data-conversation-id="chat-fixture"]').click()
    if embedded:
        expect(page.locator('#discussionSurface')).not_to_be_visible()
        page.locator('#input').fill('Ordinary conversation draft')
    else:
        page.wait_for_function('(count)=>handoffs.length===count+1', arg=before)
    page.locator(rows + ' [data-group-id="group-fixture"]').click()
    expect(surface.locator('#message')).to_have_value('A newer source draft')
    expect(surface.locator('#send')).to_be_disabled()
    surface.locator('#message').press('Enter')
    assert page.evaluate('pendingDiscussionSends.length') == 1
    # Each group owns its pending send, draft and eventual result.
    page.locator(rows + ' [data-group-id="other-group"]').click()
    expect(surface.locator('#groupTitle')).to_have_text('Another discussion')
    surface.locator('#mentions .mention').first.click()
    surface.locator('#message').fill('Another group can send independently')
    expect(surface.locator('#send')).to_be_enabled()
    surface.locator('#message').press('Enter')
    surface.locator('#message').fill('Keep the other group draft')
    assert page.evaluate('pendingDiscussionSends.length') == 2
    page.evaluate('finishDiscussionSend(0)')
    expect(surface.locator('#groupTitle')).to_have_text('Another discussion')
    expect(surface.locator('#message')).to_have_value('Keep the other group draft')
    expect(surface.locator('#send')).to_be_disabled()
    assert page.evaluate("JSON.parse(localStorage.getItem('camellia:discussion:draft:group-fixture')).text") == 'A newer source draft'
    page.evaluate('finishDiscussionSend(1)')
    expect(surface.locator('#message')).to_have_value('Keep the other group draft')
    expect(surface.locator('#send')).to_be_enabled()
    page.locator(rows + ' [data-group-id="group-fixture"]').click()
    expect(surface.locator('#message')).to_have_value('A newer source draft')
    expect(surface.locator('#messages')).to_contain_text('Verify the source group before sending')
    expect(surface.locator('#messages')).not_to_contain_text('Another group can send independently')
    expect(surface.locator('#send')).to_be_enabled()
    # A late error belongs to the source group, even while another is open.
    surface.locator('#message').fill('A verification that will fail')
    surface.locator('#message').press('Enter')
    page.wait_for_function('pendingDiscussionSends.length===3')
    page.locator(rows + ' [data-group-id="other-group"]').click()
    expect(surface.locator('#message')).to_have_value('Keep the other group draft')
    page.evaluate("finishDiscussionSend(2, 'Source connection verification failed')")
    expect(surface.locator('#notice')).not_to_be_visible()
    expect(surface.locator('#groupTitle')).to_have_text('Another discussion')
    page.locator(rows + ' [data-group-id="group-fixture"]').click()
    expect(surface.locator('#message')).to_have_value('A verification that will fail')
    expect(surface.locator('#notice')).to_contain_text('Source connection verification failed')
    surface.locator('#dismissNotice').click()
    expect(surface.locator('#notice')).not_to_be_visible()
    # A successful send clears only its submitted text even when its UI is hidden.
    surface.locator('#message').fill('Clear submitted text in the source group')
    surface.locator('#message').press('Enter')
    page.wait_for_function('pendingDiscussionSends.length===4')
    if embedded:
        page.locator('#sessionList [data-sid="chat-fixture"]').click()
        expect(page.locator('#input')).to_have_value('Ordinary conversation draft')
    else:
        page.locator(rows + ' [data-group-id="other-group"]').click()
    page.evaluate('finishDiscussionSend(3)')
    if embedded:
        expect(page.locator('#discussionSurface')).not_to_be_visible()
        expect(page.locator('#input')).to_have_value('Ordinary conversation draft')
    else:
        expect(surface.locator('#groupTitle')).to_have_text('Another discussion')
        expect(surface.locator('#message')).to_have_value('Keep the other group draft')
    page.locator(rows + ' [data-group-id="group-fixture"]').click()
    expect(surface.locator('#message')).to_have_value('')
    expect(surface.locator('#messages')).to_contain_text('Clear submitted text in the source group')
    assert page.evaluate("JSON.parse(localStorage.getItem('camellia:discussion:draft:group-fixture')).text") == ''


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for theme in ['light', 'dark']:
        normal = browser.new_page(viewport={'width': 1440, 'height': 960}, color_scheme=theme)
        discussion = browser.new_page(viewport={'width': 1440, 'height': 960}, color_scheme=theme)
        for page in (normal, discussion):
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
        normal.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        normal.wait_for_function('uiReady')
        normal.locator('[data-sid="chat-fixture"]').click()
        expect(normal.locator('#chat')).to_contain_text('需要补充的验证')
        discussion.goto((repo / 'src/renderer/discussions/discussions.html').as_uri(), wait_until='networkidle')
        expect(discussion.locator('#groupTitle')).to_have_text(group['title'])
        for page, rows in [(normal, '#discussionSessions'), (discussion, '#groupList')]:
            section = page.locator('[data-nav-section="discussions"]')
            expect(section).to_be_visible()
            expect(section.locator('[data-group-id="group-fixture"]')).to_have_count(1)
            section.locator('.nav-section-toggle').click()
            expect(page.locator(rows)).not_to_be_visible()
            section.locator('.nav-section-toggle').press('Enter')
            expect(page.locator(rows)).to_be_visible()
        expect(discussion.locator('#conversationNavigation [data-conversation-id="chat-fixture"]')).to_be_visible()
        modes = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi']
        expect(discussion.locator('#engineSwitch')).to_have_count(0)
        select = normal.locator('#engineSwitch')
        assert select.locator('option').evaluate_all('(items)=>items.map(item=>item.value)') == modes
        expect(select).to_have_value('codex')
        expect(select.locator('[value=discussions]')).to_have_count(0)
        select.click()
        normal.wait_for_function("document.querySelector('#engineSwitch').matches(':open')")
        normal.screenshot(path=str(preview / f'chat-mode-menu-chat-{theme}.png'), animations='disabled')
        select.press('Escape')
        expect(select).to_have_value('codex')
        expect(select).to_be_focused()
        for page in (normal, discussion):
            page.evaluate("changeLanguage('en')")
            page.evaluate("changeLanguage('zh-CN')")
        for left, right, properties in [
            ('.sidebar', '.sidebar', ['width', 'backgroundColor', 'borderRightWidth']),
            ('.main-header', '.main-header', ['padding', 'borderBottomWidth', 'height']),
            ('.btn-new-session', '.btn-new-session', ['borderRadius', 'backgroundColor', 'font', 'padding']),
            ('.btn-footer', '.btn-footer', ['font', 'color', 'padding']),
            ('#inputCard', '#inputCard', ['borderRadius', 'boxShadow', 'backgroundColor', 'padding']),
            ('#input', '#message', ['fontSize', 'fontFamily', 'lineHeight', 'minHeight', 'maxHeight']),
            ('.msg-user .bubble', '.msg-user .bubble', ['backgroundColor', 'color', 'borderRadius', 'fontSize', 'padding']),
            ('.turn .md', '.turn .md', ['fontSize', 'lineHeight', 'color']),
            ('.turn .md > strong', '.turn .md > h2', ['fontSize', 'fontWeight', 'lineHeight', 'color']),
            ('.turn .md-list', '.turn .md-list', ['padding', 'marginTop', 'whiteSpace']),
            ('.md-code-block', '.md-code-block', ['borderRadius', 'backgroundColor', 'borderColor']),
            ('.md-code-actions', '.md-code-actions', ['display', 'gap', 'alignItems']),
            ('.message-copy svg', '.message-copy svg', ['width', 'height', 'strokeWidth']),
            ('#send', '#send', ['width', 'height', 'borderRadius']),
        ]:
            assert styles(normal, left, properties) == styles(discussion, right, properties), (theme, left, styles(normal, left, properties), styles(discussion, right, properties))
        for preference, width in [('standard', 768), ('wide', 1080), ('full', None)]:
            for page in (normal, discussion):
                page.evaluate('(width)=>changeWidth(width)', preference)
            expect(discussion.locator('#inputCard')).to_have_css('max-width', 'none')
            assert abs(bounds(normal, '#inputCard')['width'] - bounds(discussion, '#inputCard')['width']) < 1
            if width:
                assert bounds(discussion, '#inputCard')['width'] == width
            assert bounds(discussion, '#inputCard')['x'] == bounds(discussion, '#chatScroll .column')['x']
        for page in (normal, discussion):
            page.evaluate("changeWidth('standard')")
        normal.locator('[data-sid="chat-fixture"] .session-more').click()
        discussion.locator('.group-item .session-more').click()
        for selector, properties in [('.dsh-pop', ['backgroundColor', 'borderRadius', 'boxShadow', 'padding']),
                                     ('.pop-row', ['font', 'padding', 'borderRadius', 'color'])]:
            assert styles(normal, selector, properties) == styles(discussion, selector, properties), (theme, selector)
        expect(discussion.get_by_role('menuitem', name='置顶群', exact=True)).to_be_visible()
        discussion.screenshot(path=str(preview / f'discussion-group-menu-{theme}.png'), animations='disabled')
        for page in (normal, discussion):
            page.get_by_role('menuitem', name='重命名', exact=True).press('Escape')
        normal.screenshot(path=str(preview / f'discussion-normal-reference-{theme}.png'), animations='disabled')
        discussion.screenshot(path=str(preview / f'discussion-aligned-{theme}.png'), animations='disabled')

        # A page navigation failure keeps the original surface and draft. It
        # must never submit "discussions" to the single-chat handoff API.
        normal.locator('#input').fill('保留普通聊天草稿')
        normal.evaluate('failNavigation = true')
        normal.locator('#discussionSessions [data-group-id="group-fixture"]').click()
        expect(normal.locator('#statusLine')).to_have_text('Mode navigation failed.')
        expect(normal.locator(':light(#engineSwitch)')).to_have_value('codex')
        expect(normal.locator(':light(#engineSwitch)')).to_be_enabled()
        expect(normal.locator('#input')).to_have_value('保留普通聊天草稿')
        assert normal.evaluate('handoffs.length') == 0
        assert normal.evaluate('modeNavigations') == ['discussions']
        normal.evaluate('failNavigation = false')
        normal.locator('#discussionSessions [data-group-id="group-fixture"]').click()
        normal.wait_for_function('modeNavigations.length === 2')
        expect(normal.locator('#switchDialog')).not_to_be_visible()
        expect(normal.locator('#discussionSurface')).to_be_visible()
        normal.locator('#sessionList [data-sid="chat-fixture"]').click()
        expect(normal.locator('#discussionSurface')).not_to_be_visible()
        expect(normal.locator('#input')).to_have_value('保留普通聊天草稿')
        # A running ordinary conversation can be left without stopping its
        # backend, replacing the sidebar, or reloading the document.
        normal.evaluate("""() => {
          window.extraSessions = Array.from({length:24}, (_,i)=>({...fixtureChat,id:'extra-'+i,title:'History '+i,mtimeMs:Date.now()}));
          fixtureActivity('running');
        }""")
        expect(normal.locator(':light(#engineSwitch)')).to_be_disabled()
        normal.locator(':light(#sidebarResize)').press('End')
        width = normal.locator(':light(#sidebar)').bounding_box()['width']
        expect(normal.locator('#sessionList [data-sid="extra-23"]')).to_have_count(1)
        target = normal.locator('#discussionSessions [data-group-id="group-fixture"]')
        target.scroll_into_view_if_needed()
        normal.evaluate("window.sidebarIdentity = document.getElementById('sidebar'); window.documentOrigin = performance.timeOrigin")
        sidebar_scroll = normal.locator(':light(#sessionList)').evaluate('(node)=>node.scrollTop')
        target.click()
        expect(normal.locator('#discussionSurface')).to_be_visible()
        assert normal.locator(':light(#sidebar)').bounding_box()['width'] == width
        assert normal.locator(':light(#sessionList)').evaluate('(node)=>node.scrollTop') == sidebar_scroll
        assert normal.evaluate('sidebarIdentity === document.getElementById("sidebar") && documentOrigin === performance.timeOrigin')
        normal.locator(':light(#sidebarResize)').press('Shift+ArrowLeft')
        width -= 50
        assert normal.locator(':light(#sidebar)').bounding_box()['width'] == width
        expect(normal.locator('#sessionList [data-sid="chat-fixture"]')).to_have_attribute('data-activity', 'running')
        normal.locator('#message').fill('讨论中未发送的草稿')
        normal.evaluate("fixtureChat.messages.push({role:'assistant',engine:'codex',text:'Completed while reading the discussion'}); fixtureActivity(null)")
        normal.locator('#sessionList [data-sid="chat-fixture"]').click()
        expect(normal.locator('#chat')).to_contain_text('Completed while reading the discussion')
        expect(normal.locator('#input')).to_have_value('保留普通聊天草稿')
        assert normal.locator(':light(#sidebar)').bounding_box()['width'] == width
        assert normal.evaluate('documentOrigin === performance.timeOrigin && !fixtureCommands.includes("cancel")')
        # A slow discussion load cannot take focus back after a newer session click.
        normal.evaluate('delayDiscussionLoad = true')
        target.click()
        normal.wait_for_function('typeof releaseDiscussionLoad === "function"')
        normal.locator('#sessionList [data-sid="chat-fixture"]').click()
        normal.evaluate('releaseDiscussionLoad(); delayDiscussionLoad = false')
        normal.wait_for_function('!discussionOpening && !loadingSession')
        expect(normal.locator('#discussionSurface')).not_to_be_visible()
        target.click()
        expect(normal.locator('#message')).to_have_value('讨论中未发送的草稿')
        assert normal.evaluate('documentOrigin === performance.timeOrigin')
        normal.screenshot(path=str(preview / f'discussion-integrated-{theme}.png'), animations='disabled')
        normal.set_viewport_size({'width': 390, 'height': 844})
        expect(normal.locator(':light(#sidebar)')).not_to_be_visible()
        assert normal.locator('#discussionSurface').bounding_box()['width'] == 390
        normal.locator('#discussionSurface #sidebarToggle').click()
        expect(normal.locator(':light(#sidebar)')).to_be_visible()
        normal.locator('#sessionList [data-sid="chat-fixture"]').click()
        expect(normal.locator(':light(#sidebar)')).not_to_be_visible()
        expect(normal.locator('#input')).to_be_visible()
        normal.locator('#workbenchSidebarToggle').click()
        expect(normal.locator(':light(#sidebar)')).to_be_visible()
        target.click()
        expect(normal.locator(':light(#sidebar)')).not_to_be_visible()
        normal.screenshot(path=str(preview / f'discussion-integrated-narrow-{theme}.png'), animations='disabled')
        normal.set_viewport_size({'width': 1440, 'height': 960})
        normal.wait_for_function('(width)=>document.getElementById("sidebar").getBoundingClientRect().width===width', arg=width)
        assert normal.locator(':light(#sidebar)').bounding_box()['width'] == width
        normal.locator('#sessionList [data-sid="chat-fixture"]').click()
        normal.locator('#input').fill('')
        discussion.locator('#message').fill('保留讨论草稿')
        discussion.evaluate('failNavigation = true')
        discussion.locator('#conversationNavigation [data-conversation-id="chat-fixture"]').click()
        expect(discussion.locator('#notice')).to_have_text('Mode navigation failed.')
        expect(discussion.locator('#engineSwitch')).to_have_count(0)
        expect(discussion.locator('#message')).to_have_value('保留讨论草稿')
        assert discussion.evaluate('handoffs') == [{'engine': 'codex', 'navigate': True, 'sessionId': 'chat-fixture'}]
        assert discussion.evaluate('modeNavigations') == ['discussions']
        discussion.evaluate('failNavigation = false')
        discussion.locator('#message').fill('')
        discussion.locator('#dismissNotice').click()

        # Normal chat uses Enter to send, Shift+Enter for a newline, and a
        # bounded growing input. Verify discussion uses the same interaction.
        discussion.locator('#message').fill('第一行')
        discussion.locator('#message').press('Shift+Enter')
        discussion.locator('#message').type('第二行')
        assert discussion.evaluate('fixtureSends.length') == 0
        expect(discussion.locator('#message')).to_have_value('第一行\n第二行')
        discussion.locator('#message').press('Enter')
        expect(discussion.locator('#message')).to_have_value('')
        assert discussion.evaluate('fixtureSends[0].text') == '第一行\n第二行'
        expect(discussion.locator('#send')).to_be_disabled()

        discussion.locator('#message').fill('\n'.join(['长文本输入'] * 30))
        assert bounds(discussion, '#message')['height'] == 180
        assert bounds(discussion, '#inputCard')['y'] + bounds(discussion, '#inputCard')['height'] < 960
        discussion.locator('#message').fill('')
        wrap = discussion.locator('.md-code-wrap').first
        wrap.click()
        expect(wrap).to_have_attribute('aria-pressed', 'true')
        expect(discussion.locator('.md-code')).to_have_css('white-space', 'pre-wrap')
        discussion.evaluate("emitDiscussion({discussionId:'group-fixture'})")
        expect(wrap).to_have_attribute('aria-pressed', 'true')

        discussion.locator('#membersToggle').click()
        expect(discussion.locator('#membersPanel')).to_be_visible()
        expect(discussion.locator('#membersPanel .member-card')).to_have_count(4)
        assert discussion.locator('#membersPanel img').evaluate_all('(images)=>images.every(img=>img.complete && img.naturalWidth>0)')
        discussion.screenshot(path=str(preview / f'discussion-members-{theme}.png'), animations='disabled')
        discussion.locator('#membersPanel').press('Escape')
        expect(discussion.locator('#membersPanel')).not_to_be_visible()

        discussion.locator('#sidebarResize').focus()
        discussion.locator('#sidebarResize').press('ArrowRight')
        assert bounds(discussion, '#sidebar')['width'] == 270
        discussion.locator('#sidebarResize').press('ArrowLeft')
        assert bounds(discussion, '#sidebar')['width'] == 260

        # Literal image text must not become a resource fetch after branding
        # images are enabled by CSP. Exercise headings, quotes and nested lists.
        result = discussion.evaluate(r"""() => {
          const text='## ![header](file:///C:/layout-only.png)\n> ![quote](https://example.invalid/a.png)\n- ![outer](file:///C:/outer.png)\n  - ![inner](file:///C:/inner.png)\n\n| Image |\n| --- |\n| ![cell](file:///C:/cell.png) |';
          const fragment=CamelliaMarkdown.render(document,text,{allowImages:false});
          return {images:fragment.querySelectorAll('img').length,text:fragment.textContent};
        }""")
        assert result['images'] == 0 and '![inner]' in result['text'] and '![cell]' in result['text']
        for width, height in [(960, 720), (720, 600), (390, 844)]:
            discussion.set_viewport_size({'width': width, 'height': height})
            assert discussion.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert bounds(discussion, '#inputCard')['y'] + bounds(discussion, '#inputCard')['height'] < height
            if width == 390:
                expect(discussion.locator('#sidebar')).not_to_be_visible()
                discussion.locator('#sidebarToggle').click()
                expect(discussion.locator('#sidebar')).to_be_visible()
                discussion.locator('.group-item').click()
                expect(discussion.locator('#sidebar')).not_to_be_visible()
                discussion.screenshot(path=str(preview / f'discussion-aligned-narrow-{theme}.png'), animations='disabled')
        normal.locator('#discussionSessions [data-group-id="group-fixture"]').click()
        expect(normal.locator('#discussionSurface')).to_be_visible()
        check_execution_process(normal, theme, embedded=True)
        check_execution_process(discussion, theme)
        check_verification_navigation(normal, embedded=True)
        check_verification_navigation(discussion)
        normal.close()
        discussion.close()
    browser.close()
    assert not errors, errors
    print('PASS: running chat to discussion without document reload; background completion; shared sidebar width/scroll/drawer; latest navigation wins; drafts and failed navigation; six-harness menu; light/dark and Chinese/English; normal-chat metrics; content widths; members; composer; code wrap; text-only image rendering; grouped execution process; navigation during verification, independent group sends, duplicate prevention, source-scoped drafts/errors and hidden completion on both discussion surfaces.')
