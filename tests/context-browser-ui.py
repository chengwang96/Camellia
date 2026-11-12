"""Context Browser panel: request composition, expansion, agents, blocks and memory."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture = {
    'id': 'context-fixture',
    'title': 'Inspect the context',
    'origin': 'codex',
    'currentEngine': 'codex',
    'workspaceId': None,
    'messages': [
        {'seq': 1, 'role': 'user', 'text': 'Inspect this request.'},
        {'seq': 2, 'role': 'assistant', 'engine': 'codex', 'text': 'Context is ready.'},
    ],
}
second = {
    'id': 'context-second',
    'title': 'Switch the context',
    'origin': 'codex',
    'currentEngine': 'codex',
    'workspaceId': None,
    'messages': [
        {'seq': 1, 'role': 'user', 'text': 'Switch sessions.'},
        {'seq': 2, 'role': 'assistant', 'engine': 'codex', 'text': 'Second context ready.'},
    ],
}
snapshot = {
    'version': 1, 'conversationId': fixture['id'], 'engine': 'codex', 'model': 'fixture-model',
    'turnSeq': 2, 'pressure': {'used': 15000, 'cap': 200000, 'pct': 7.5, 'source': 'usage'},
    'usage': {'inputTokens': 9000, 'outputTokens': 100, 'cacheReadTokens': 2000,
              'cacheWriteTokens': 0, 'contextWindow': 200000, 'cacheHitRate': 18.2},
    'categories': [
        {'id': 'conversation', 'label': 'Conversation', 'tokens': 5200, 'status': 'estimated'},
        {'id': 'tool-results', 'label': 'Tool results', 'tokens': 3800, 'status': 'estimated'},
        {'id': 'engine-managed', 'label': 'Engine-managed', 'tokens': 3000, 'status': 'opaque'},
    ],
    'nodes': [
        {'id': 'n:2', 'category': 'conversation', 'label': 'Conversation', 'seq': 2,
         'role': 'user', 'kind': 'conversation', 'tokens': 1200, 'chars': 24,
         'preview': 'Inspect this request.', 'observed': True, 'status': 'estimated',
         'expandable': True, 'redacted': False},
    ],
    'events': [{'id': 'e:3', 'kind': 'compact', 'seq': 3, 'state': 'completed',
                'native': False, 'source': 'compaction', 'deltaTokens': -12000,
                'text': 'Context compacted'}],
    'memory': {'pinned': True, 'chars': 24},
    'warnings': ['Part of this request is managed by the native engine and is not individually observable.'],
    'truncated': False,
}
second_snapshot = {
    'version': 1, 'conversationId': second['id'], 'engine': 'codex', 'model': 'second-model',
    'turnSeq': 1, 'pressure': {'used': 2200, 'cap': 200000, 'pct': 1.1, 'source': 'usage'},
    'usage': {'inputTokens': 2000, 'outputTokens': 20, 'cacheReadTokens': 0,
              'cacheWriteTokens': 0, 'contextWindow': 200000, 'cacheHitRate': 0},
    'categories': [
        {'id': 'tool-results', 'label': 'Tool results', 'tokens': 2200, 'status': 'estimated'},
    ],
    'nodes': [], 'events': [], 'memory': {'pinned': False, 'chars': 0},
    'warnings': [], 'truncated': False,
}
second_graph = {
    'rootId': second['id'],
    'nodes': [
        {'id': 'conversation:' + second['id'], 'kind': 'conversation', 'title': second['title'],
         'engine': 'codex', 'status': 'idle', 'parentId': None, 'root': True},
    ],
    'edges': [], 'truncated': False,
}
previous = {
    'version': 1, 'conversationId': fixture['id'], 'engine': 'codex', 'model': 'fixture-model',
    'turnSeq': 1, 'pressure': {'used': 10000, 'cap': 200000, 'pct': 5, 'source': 'usage'},
    'usage': {'inputTokens': 8000, 'outputTokens': 100, 'cacheReadTokens': 1000,
              'cacheWriteTokens': 0, 'contextWindow': 200000, 'cacheHitRate': 12.5},
    'categories': [
        {'id': 'conversation', 'label': 'Conversation', 'tokens': 4000, 'status': 'estimated'},
        {'id': 'engine-managed', 'label': 'Engine-managed', 'tokens': 6000, 'status': 'opaque'},
    ],
    'nodes': [
        {'id': 'n:1', 'category': 'conversation', 'label': 'Conversation', 'seq': 1,
         'role': 'user', 'kind': 'conversation', 'tokens': 1000, 'chars': 20,
         'preview': 'Earlier request.', 'observed': True, 'status': 'estimated',
         'expandable': True, 'redacted': False},
    ],
    'events': [], 'memory': {'pinned': False, 'chars': 0}, 'warnings': [], 'truncated': False,
}
graph = {
    'rootId': fixture['id'],
    'nodes': [
        {'id': 'conversation:' + fixture['id'], 'kind': 'conversation', 'title': fixture['title'],
         'engine': 'codex', 'status': 'idle', 'parentId': None, 'root': True},
        {'id': 'managed:child', 'kind': 'managed', 'title': 'Child task', 'engine': 'codex',
         'status': 'completed', 'parentId': 'conversation:' + fixture['id'], 'contextObserved': True,
         'contextPacket': {'goal': 'Review the context'}, 'settlement': {'status': 'completed',
         'summary': 'Child reviewed the context.'}, 'managedConversationId': 'child'},
    ],
    'edges': [{'from': 'conversation:' + fixture['id'], 'to': 'managed:child', 'kind': 'delegate'}],
    'truncated': False,
}
blocks = {
    'conversationId': fixture['id'], 'engine': 'codex',
    'blocks': [{'blockId': 'b1', 'fromSeq': 1, 'toSeq': 2, 'summaryTokens': 80,
                'originalTokens': 1200, 'summaryPreview': 'Compacted original context.',
                'firstUserPinned': True, 'active': True, 'retired': False}],
}
bridge = r"""(() => {
  const fixture = FIXTURE, second = SECOND, snapshot = SNAPSHOT, secondSnapshot = SECOND_SNAPSHOT,
        previous = PREVIOUS, graph = GRAPH, secondGraph = SECOND_GRAPH, blocks = BLOCKS;
  const loadById = id => id === second.id ? second : fixture;
  let reviewConsent = {id:'consent-1', reviewerEngine:'claude', mode:'adversarial', focus:'data loss'};
  window.dshDesktop = {
    sharedConversations: true,
    conversationCommand: async ({action, payload}) => {
      if (action === 'list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()},{...second,mtimeMs:Date.now()-60000}],workspaces:[],pagination:{}};
      if (action === 'get-live') return {ok:true,live:null};
      if (action === 'load-session') return {ok:true,...loadById(payload),preferences:{mode:'direct'},settings:{model:'fixture-model',connection:'api'}};
      if (action === 'get-settings') return {model:'fixture-model',connection:'api'};
      if (action === 'context-snapshot') {
        if (payload?.sessionId === second.id) return {ok:true,snapshot:secondSnapshot};
        return {ok:true,snapshot: payload?.turnSeq === 1 ? previous : snapshot};
      }
      if (action === 'agent-graph') return {ok:true,graph: payload?.sessionId === second.id ? secondGraph : graph};
      if (action === 'context-blocks') return {ok:true,...(payload?.sessionId === second.id
        ? {conversationId:second.id,engine:'codex',blocks:[]} : blocks)};
      if (action === 'context-memory-status') return {ok:true,enabled:true,scope:{user:1,workspace:1},snapshot:'Prefer concise answers.'};
      if (action === 'context-node') return {ok:true,node:{content:'Exact user content',truncated:false,redacted:false}};
      if (action === 'context-expand') return {ok:true,text:'Recovered original rows',truncated:false};
      if (action === 'review-options') return {ok:true,authorEngine:'codex',defaultEngine:'claude',
        settings:{allowAgentReviews:false,gate:false,allowSameEngine:false,reviewerEngine:'claude',model:'',mode:'standard',maxTokens:50000},
        engines:[{engine:'claude',available:true,models:[{id:'reviewer-model',name:'Reviewer Model'}]}]};
      if (action === 'review-context') return {ok:true,reviewable:true,changedFiles:3,files:[]};
      if (action === 'review-consent-pending') return {ok:true,consent:reviewConsent};
      if (action === 'review-consent-approve') {
        const consent = reviewConsent; reviewConsent = null;
        return {ok:true,consent,review:{id:'consent-review',status:'completed',reviewerEngine:'claude',mode:'adversarial',report:null}};
      }
      if (action === 'review-consent-dismiss') { reviewConsent = null; return {ok:true,dismissed:true}; }
      if (action === 'review-save-settings') return {ok:true,settings:{allowAgentReviews:false,gate:false,
        allowSameEngine:false,reviewerEngine:'claude',model:'',mode:'standard',maxTokens:50000,...payload}};
      if (action === 'review-start') return {ok:true,review:{id:'review-1',status:'running',
        reviewerEngine:'claude',mode:payload?.mode || 'standard',childConversationId:'review-child',
        target:{files:[{path:'src/app.js',status:' M'}]}}};
      if (action === 'review-status') return {ok:true,review:{id:'review-1',status:'completed',
        reviewerEngine:'claude',mode:'standard',report:{verdict:'changes_requested',summary:'A retry can duplicate work.',
          findings:[{id:'f1',severity:'high',file:'src/app.js',line:12,
            evidence:'The side effect happens before the retry boundary.',recommendation:'Persist the boundary first.'}]}}};
      if (action === 'review-cancel') return {ok:true,review:{id:'review-1',status:'cancelled'}};
      if (action === 'goal-get') return {ok:true,goal:null};
      return {ok:true};
    },
    workbenchSettings: async () => ({ok:true,conversations:{mode:'direct'}}),
    onLanguageChanged: fn => { window.changeLanguage = fn; return () => {}; },
    onConversationEvent: () => {},
    onConversationGoal: () => {},
    onConversationStatus: () => {},
    onEngineSettingsChanged: () => {},
    onApiRouterState: () => {},
    onNetworkHealth: () => {},
    onHarnessNavigate: () => {},
    apiRouterGetState: async () => ({enabled:true,models:['fixture-model']}),
    conversationSwitch: async () => ({ok:true}),
    conversationHandoff: async () => ({ok:true}),
    onConversationStatus: () => {},
    onEngineSettingsChanged: () => {},
    onApiRouterState: () => {},
    onNetworkHealth: () => {},
    onHarnessNavigate: () => {},
    openSettingsWindow: () => {},
    previewFile: async () => ({ok:false}),
    openFileExternally: async () => ({ok:true}),
  };
})();""".replace('SECOND_SNAPSHOT', json.dumps(second_snapshot)) \
    .replace('SECOND_GRAPH', json.dumps(second_graph)) \
    .replace('FIXTURE', json.dumps(fixture)).replace('SECOND', json.dumps(second)) \
    .replace('SNAPSHOT', json.dumps(snapshot)) \
    .replace('PREVIOUS', json.dumps(previous)) \
    .replace('GRAPH', json.dumps(graph)).replace('BLOCKS', json.dumps(blocks))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="context-fixture"]').click()
    expect(page.locator('#chat')).to_contain_text('Context is ready.')
    assert page.locator('#chatScroll').evaluate('(node)=>getComputedStyle(node).marginRight') == '0px'
    page.locator('#contextToggle').click()
    expect(page.locator('#contextPanel')).to_be_visible()
    page.wait_for_function("getComputedStyle(document.querySelector('#chatScroll')).marginRight === '496px'")
    panel_box = page.locator('#contextPanel').bounding_box()
    chat_box = page.locator('#chat').bounding_box()
    assert page.locator('#contextPanel').evaluate('(node)=>getComputedStyle(node).width') == '480px'
    assert chat_box['x'] + chat_box['width'] <= panel_box['x'] - 12, (chat_box, panel_box)
    assert '0.22s' in page.locator('#contextPanel').evaluate('(node)=>getComputedStyle(node).transitionDuration')
    expect(page.locator('#contextPanelBody')).to_contain_text('Composition')
    expect(page.locator('#contextPanelBody')).to_contain_text('vs previous turn')
    expect(page.locator('#contextPanelBody')).to_contain_text('+5K tok')
    expect(page.locator('#contextPanelBody')).to_contain_text('+1 / -1 nodes')
    expect(page.locator('#contextPanelBody')).to_contain_text('New')
    expect(page.locator('#contextPanelBody')).to_contain_text('Recoverable blocks')
    expect(page.locator('#contextPanelBody')).to_contain_text('First user pinned')
    expect(page.locator('.ctx-block-actions button')).to_have_count(2)
    page.get_by_role('button', name='Rewrite').click()
    expect(page.locator('.ctx-block-rewrite textarea')).to_be_visible()
    page.get_by_role('button', name='Cancel').click()
    expect(page.locator('#contextPanelBody')).to_contain_text('Agents')
    expect(page.locator('.ctx-graph-svg')).to_be_visible()
    expect(page.locator('#contextPanelBody')).to_contain_text('Working memory')
    expect(page.locator('#contextPanelBody')).to_contain_text('Memory pinned')
    expect(page.locator('#contextPanelBody')).to_contain_text('-12K tok')
    expect(page.locator('#contextPanelBody')).to_contain_text('Compaction')
    page.locator('.ctx-node .ctx-node-trigger').click()
    expect(page.locator('#contextPanelBody')).to_contain_text('Exact user content')
    page.locator('.ctx-block .ctx-node-trigger').click()
    expect(page.locator('#contextPanelBody')).to_contain_text('Recovered original rows')
    page.evaluate("changeLanguage('zh-CN')")
    expect(page.locator('#contextPanelBody')).to_contain_text('组成')
    expect(page.locator('#contextPanelBody')).to_contain_text('可恢复块')
    expect(page.locator('#contextPanelBody')).to_contain_text('上下文事件')
    expect(page.locator('#contextPanelBody')).to_contain_text('工作记忆')
    expect(page.locator('#contextPanelBody')).to_contain_text('上一轮')
    expect(page.locator('#contextPanelBody')).to_contain_text('首条用户消息已固定')
    expect(page.locator('#contextPanelBody')).to_contain_text('1 个子 Agent')
    expect(page.locator('#contextPanelBody')).to_contain_text('限制')
    expect(page.locator('#contextPanelBody')).to_contain_text('由原生引擎托管')
    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'context-panel-zh-CN.png'), animations='disabled')
    zh_body = page.locator('#contextPanelBody').inner_text()
    for untranslated in ['Composition', 'Recoverable blocks', 'Context events', 'Working memory',
                         'Previous turn', 'First user pinned', 'Observed usage', 'Engine-managed',
                         'Tool results', 'Estimated categories', 'Opaque context', 'Agents',
                         'children', 'Part of this request is managed']:
        assert untranslated not in zh_body, untranslated
    page.evaluate("changeLanguage('en')")
    expect(page.locator('#contextPanelBody')).to_contain_text('Composition')
    expect(page.locator('#contextPanelBody')).to_contain_text('Recoverable blocks')
    en_body = page.locator('#contextPanelBody').inner_text()
    assert not re.search(r'[\u4e00-\u9fff]', en_body), en_body
    # Switching conversations while the panel is open reloads the body for the
    # incoming session instead of leaving the previous request or an empty body.
    page.locator('[data-sid="context-second"]').click()
    expect(page.locator('#chat')).to_contain_text('Second context ready.')
    expect(page.locator('#contextPanelBody')).to_contain_text('2.2K tok')
    expect(page.locator('#contextPanelBody')).to_contain_text('Tool results')
    expect(page.locator('#contextPanelBody')).to_contain_text('Switch the context')
    assert 'Recoverable blocks' not in page.locator('#contextPanelBody').inner_text()
    page.locator('[data-sid="context-fixture"]').click()
    expect(page.locator('#chat')).to_contain_text('Context is ready.')
    expect(page.locator('#contextPanelBody')).to_contain_text('Composition')
    expect(page.locator('#contextPanelBody')).to_contain_text('Recoverable blocks')
    expect(page.locator('#contextPanelBody')).to_contain_text('vs previous turn')
    close_state = page.evaluate("""() => {
      const panel = document.querySelector('#contextPanel');
      document.querySelector('#contextPanelClose').click();
      return {hidden: panel.hidden, closing: panel.classList.contains('is-closing'),
              open: panel.classList.contains('is-open')};
    }""")
    assert close_state == {'hidden': False, 'closing': True, 'open': False}, close_state
    expect(page.locator('#contextPanel')).to_be_hidden()
    assert page.locator('#reviewChip').count() == 0
    expect(page.locator('.review-consent-card')).to_be_visible()
    expect(page.locator('.review-consent-card')).to_contain_text('cross-engine review')
    page.locator('.review-consent-card button.btn-primary').click()
    expect(page.locator('.review-consent-card')).to_have_count(0)
    page.locator('#reviewToggle').click()
    expect(page.locator('#reviewDialog')).to_be_visible()
    assert page.evaluate(
        "getComputedStyle(document.querySelector('#reviewDialog'), '::backdrop').backdropFilter") == 'none'
    page.wait_for_timeout(200)
    app_opacity = float(page.evaluate("getComputedStyle(document.querySelector('.app')).opacity"))
    assert 0.4 <= app_opacity <= 0.6, app_opacity
    box = page.locator('#reviewDialog').bounding_box()
    viewport = page.viewport_size
    assert box is not None and viewport is not None
    assert abs((box['x'] + box['width'] / 2) - viewport['width'] / 2) <= 1, box
    assert abs((box['y'] + box['height'] / 2) - viewport['height'] / 2) <= 1, box
    expect(page.locator('#reviewEngine option')).to_have_count(1)
    expect(page.locator('#reviewAdvanced')).not_to_have_attribute('open', '')
    page.locator('#reviewAdvanced > summary').click()
    expect(page.locator('#reviewAdvanced')).to_have_attribute('open', '')
    expect(page.locator('#reviewAgentConsent')).not_to_be_checked()
    page.locator('#reviewAgentConsent').check()
    expect(page.locator('#reviewAgentConsent')).to_be_checked()
    page.locator('#reviewGate').check()
    expect(page.locator('#reviewGate')).to_be_checked()
    page.locator('#reviewAdvanced').evaluate("node => { node.open = false; }")
    page.locator('#reviewStart').click()
    expect(page.locator('#reviewStatus')).to_contain_text('Review completed')
    expect(page.locator('.review-report')).to_contain_text('A retry can duplicate work.')
    expect(page.locator('.review-finding')).to_contain_text('src/app.js:12')
    page.screenshot(path=str(preview / 'review-dialog.png'), animations='disabled')
    page.locator('#reviewClose').click()
    page.keyboard.press('Control+Shift+R')
    expect(page.locator('#reviewDialog')).to_be_visible()
    page.locator('#reviewClose').click()
    assert errors == [], errors
    browser.close()
    print('PASS context browser: composition, node, block, agents, memory, switching')
