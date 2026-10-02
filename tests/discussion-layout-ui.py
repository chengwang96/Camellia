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
  const fixture = CHAT, group = GROUP;
  const preferences = {mode:'direct',warnOnSwitch:false,showOrigin:false};
  const settings = {model:'gpt-test',connection:'subscription',permissionMode:'ask'};
  window.fixtureSends = [];
  window.modeNavigations = []; window.handoffs = []; window.failNavigation = false;
  window.dshDesktop = {
    sharedConversations:true, onLanguageChanged:fn=>{window.changeLanguage=fn;return()=>{};},
    onChatContentWidthChanged:fn=>{window.changeWidth=fn;return()=>{};},
    workbenchSettings:async()=>({ok:true,language:'zh-CN',chatContentWidth:'standard',conversations:preferences}),
    conversationCommand:async ({action}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,preferences,settings};
      if(action==='get-settings') return settings;
      if(action==='goal-get') return {ok:true,goal:null};
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    discussion:async (action,payload) => {
      if(action==='list') return {ok:true,groups:[{id:group.id,title:group.title,members:4,preview:prompt}]};
      if(action==='load') return {ok:true,group};
      if(action==='send') {window.fixtureSends.push(payload);return {ok:true,group};}
      return {ok:false,error:'Layout fixture has no model connection.'};
    },
    onDiscussionEvent:fn=>{window.emitDiscussion=fn;return()=>{};},
    conversationSwitch:async payload=>{window.handoffs.push(payload);return {ok:true};}, apiRouterGetState:async()=>({enabled:true,models:['gpt-test']}),
    codexAccountState:async()=>({ok:true,models:[{id:'gpt-test',name:'gpt-test'}]}),
    onConversationEvent:()=>{},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},onHarnessNavigate:()=>{},
    openSettingsWindow:()=>{},switchMode:async mode=>{window.modeNavigations.push(mode);return window.failNavigation ? {ok:false,error:'Mode navigation failed.'} : {ok:true};},
    previewFile:async()=>({ok:false}),openFileExternally:async()=>({ok:true}),
  };
})();""".replace('CHAT', json.dumps(chat)).replace('GROUP', json.dumps(group)).replace('preview:prompt', 'preview:' + json.dumps(prompt))


def styles(page, selector, properties):
    return page.locator(selector).first.evaluate('(node,props)=>Object.fromEntries(props.map(p=>[p,getComputedStyle(node)[p]]))', properties)


def bounds(page, selector):
    return page.locator(selector).bounding_box()


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
        modes = ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'pi', 'discussions']
        for page, current, surface in [(normal, 'codex', 'chat'), (discussion, 'discussions', 'discussion')]:
            select = page.locator('#engineSwitch')
            assert select.locator('option').evaluate_all('(items)=>items.map(item=>item.value)') == modes
            expect(select).to_have_value(current)
            expect(select.locator('[value=discussions]')).to_have_text('Agent 讨论 (beta)')
            select.click()
            page.wait_for_function("document.querySelector('#engineSwitch').matches(':open')")
            page.screenshot(path=str(preview / f'chat-mode-menu-{surface}-{theme}.png'), animations='disabled')
            select.press('Escape')
            expect(select).to_have_value(current)
            expect(select).to_be_focused()
            page.evaluate("changeLanguage('en')")
            expect(select.locator('[value=discussions]')).to_have_text('Agent discussions (beta)')
            page.evaluate("changeLanguage('zh-CN')")
        for left, right, properties in [
            ('.sidebar', '.sidebar', ['width', 'backgroundColor', 'borderRightWidth']),
            ('.main-header', '.main-header', ['padding', 'borderBottomWidth', 'height']),
            ('#engineSwitch', '#engineSwitch', ['font', 'padding', 'height', 'borderRadius', 'backgroundColor', 'color']),
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
        normal.select_option('#engineSwitch', 'discussions')
        expect(normal.locator('#statusLine')).to_have_text('Mode navigation failed.')
        expect(normal.locator('#engineSwitch')).to_have_value('codex')
        expect(normal.locator('#engineSwitch')).to_be_enabled()
        expect(normal.locator('#input')).to_have_value('保留普通聊天草稿')
        assert normal.evaluate('handoffs.length') == 0
        assert normal.evaluate('modeNavigations') == ['discussions']
        normal.evaluate('failNavigation = false')
        normal.select_option('#engineSwitch', 'discussions')
        normal.wait_for_function('modeNavigations.length === 2')
        expect(normal.locator('#switchDialog')).not_to_be_visible()
        normal.locator('#input').fill('')
        discussion.locator('#message').fill('保留讨论草稿')
        discussion.evaluate('failNavigation = true')
        discussion.select_option('#engineSwitch', 'pi')
        expect(discussion.locator('#notice')).to_have_text('Mode navigation failed.')
        expect(discussion.locator('#engineSwitch')).to_have_value('discussions')
        expect(discussion.locator('#engineSwitch')).to_be_enabled()
        expect(discussion.locator('#message')).to_have_value('保留讨论草稿')
        assert discussion.evaluate('handoffs.length') == 0
        assert discussion.evaluate('modeNavigations') == ['pi']
        discussion.evaluate('failNavigation = false')
        discussion.locator('#message').fill('')
        discussion.evaluate('clearNotice()')

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
        normal.close()
        discussion.close()
    browser.close()
    assert not errors, errors
    print('PASS: shared seven-mode menu in light/dark and Chinese/English; failed navigation preserves selection/drafts; normal-chat element metrics; standard/wide/full preferences; 4-member dialog; avatars; Enter/Shift+Enter; bounded input; code wrap; keyboard sidebar resize; narrow drawer; text-only image rendering.')
