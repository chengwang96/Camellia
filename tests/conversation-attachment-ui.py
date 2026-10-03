"""File/conversation attachment picker and failed-turn retry in the chat renderer."""
import ast
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
module = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in module.body
               if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in module.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge += r"""(() => {
  const command = window.dshDesktop.conversationCommand;
  window.dshDesktop.conversationCommand = async request => {
    if (request.action === 'list-attachable-conversations') return {ok:true,sessions:[
      {id:'older',title:'Electron migration',engine:'codex',cwd:'D:/Code/Electron',updatedAt:2},
      {id:'other',title:'Python notes',engine:'claude',cwd:'D:/Code/Python',updatedAt:1},
    ].filter(item => !request.payload.query || item.title.toLowerCase().includes(request.payload.query.toLowerCase()))};
    if (request.action === 'attach-conversation') { window.attachCount = (window.attachCount || 0) + 1;
      return {ok:true,attachment:{path:'C:/Camellia/older.md',name:'Electron migration.md',isImage:false,kind:'conversation',sourceSessionId:'older'}}; }
    if (request.action === 'send') { window.sentPayload = request.payload; return {ok:true,sessionId:'new-conversation',userSeq:1,runId:10}; }
    return command(request);
  };
  window.dshDesktop.pickAttachments = async () => ({canceled:false,paths:['D:/Code/notes.txt']});
})();"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 820})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&new=1', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('#attachBtn').click()
    expect(page.locator('.attach-pop')).to_be_visible()
    expect(page.locator('.attach-pop')).to_contain_text('Files')
    expect(page.locator('.attach-pop')).to_contain_text('Conversation')
    page.locator('.attach-option', has_text='Files').click()
    expect(page.locator('#attachRow .attchip')).to_contain_text('notes.txt')
    page.locator('#attachRow .attchip-x').click()
    page.locator('#attachBtn').click()
    page.locator('.attach-option', has_text='Conversation').click()
    page.locator('.attach-picker-search').fill('Electron')
    expect(page.locator('.attach-conversation-option')).to_have_count(1)
    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'conversation-picker.png'), animations='disabled')
    page.locator('.attach-conversation-option').click()
    expect(page.locator('#attachRow .attchip')).to_contain_text('Electron migration.md')
    expect(page.locator('#attachRow .attchip-conversation-icon')).to_have_count(1)
    page.locator('#attachBtn').click()
    page.locator('.attach-option', has_text='Conversation').click()
    page.locator('.attach-conversation-option', has_text='Electron migration').click()
    expect(page.locator('#attachRow .attchip')).to_have_count(1)
    assert page.evaluate('window.attachCount') == 1
    page.locator('#send').click()
    page.wait_for_function('Boolean(window.sentPayload)')
    sent = page.evaluate('sentPayload')
    assert sent['attachments'][0]['sourceSessionId'] == 'older'
    assert 'Continue the attached Camellia conversation' in sent['prompt']
    assert 'C:/Camellia/older.md' in sent['prompt']
    page.screenshot(path=str(preview / 'conversation-attachment.png'), animations='disabled')
    page.close()

    retry_bridge = bridge + r"""(() => {
      const command = window.dshDesktop.conversationCommand;
      window.dshDesktop.conversationCommand = async request => {
        if (request.action === 'list-sessions') return {ok:true,sessions:[{id:'failed',title:'Failed turn',origin:'codex',currentEngine:'codex',workspaceId:null,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
        if (request.action === 'load-session') return {ok:true,id:'failed',title:'Failed turn',origin:'codex',currentEngine:'codex',workspaceId:null,
          preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings:{model:'fixture-model',permissionMode:'default',connection:'api'},live:null,messages:[
            {seq:1,role:'user',engine:'codex',text:'Finish the task'},
            {seq:2,role:'assistant',engine:'codex',text:'Connection failed',userSeq:1,runResult:{subtype:'error',is_error:true,result:'Connection failed'}}]};
        return command(request);
      };
    })();"""
    page = browser.new_page(viewport={'width': 1200, 'height': 820})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(retry_bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    page.locator('[data-sid="failed"]').click()
    expect(page.locator('.run-retry')).to_be_visible()
    page.locator('.run-retry').click()
    page.wait_for_function('Boolean(window.sentPayload)')
    assert page.evaluate('sentPayload.editSeq') == 1
    expect(page.locator('#chat .msg-user')).to_have_count(1)
    page.close()

    narrow = browser.new_page(viewport={'width': 390, 'height': 760}, color_scheme='dark')
    narrow.on('pageerror', lambda error: errors.append(str(error)))
    narrow.add_init_script(bridge)
    narrow.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&new=1', wait_until='networkidle')
    narrow.wait_for_function('uiReady')
    narrow.locator('#attachBtn').click()
    box = narrow.locator('.attach-pop').bounding_box()
    assert 0 <= box['x'] and box['x'] + box['width'] <= 390
    assert 0 <= box['y'] and box['y'] + box['height'] <= 760
    narrow.close()
    browser.close()
    assert not errors, errors

print('PASS: attachment menu, file picker, searchable conversation picker, send payload, and retry from saved turn')
