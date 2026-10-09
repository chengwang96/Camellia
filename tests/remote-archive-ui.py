"""Real remote commands + desktop IPC + Chromium. No engine or external API calls."""
import json
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


repo = Path(__file__).resolve().parents[1]
driver_source = r"""
const readline = require('node:readline');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHarness } = require('./tests/claude-harness.cjs');
const { RemoteCommands } = require('./src/main/remote/commands');
const { RemoteReadModel } = require('./src/main/remote/read-model');
const { RemoteAccess } = require('./src/main/remote/access');
const h = createHarness();
h.configureApi();
const manager = h.api.sharedConversations;
const workspace = manager.workspaces.metaOp({op:'create-workspace',name:'Archive sync',path:h.folder('workspace')}).workspace;
const sessions = ['First', 'Second', 'Third'].map((title, index) => {
  const c = manager.create('claude', workspace.id, title);
  manager.append(c, {role:'user',engine:'claude',text:title + ' conversation'});
  c.updatedAt = Date.now() - index * 1000;
  manager.save(c);
  return c;
});
const access = new RemoteAccess({file:path.join(h.root,'remote-devices.json')});
const invitation = access.invite([workspace.id]);
const pairing = access.request({code:invitation.code,name:'Android archive test'});
access.approve(pairing.id);
const credential = access.claim(pairing.id,pairing.claim);
const device = access.authenticate(credential.token);
const commands = new RemoteCommands({file:path.join(h.root,'remote-commands.json'),access,reader:new RemoteReadModel(manager)});
const methods = {
  conversationCommand:'conversation-command',conversationSwitch:'conversation-switch',
  workbenchSettings:'workbench-settings',apiRouterGetState:'api-router-get-state',
  storageReferencesChanged:'storage-references-changed',discussion:'discussion',
};
readline.createInterface({input:process.stdin}).on('line',async line => {
  try {
    const {method,payload} = JSON.parse(line);
    let result;
    if (method === 'fixtures') result = {ids:sessions.map(c=>c.id),workspaceId:workspace.id};
    else if (method === 'mobile') result = await commands.execute(device,null,{
      requestId:randomUUID(),instanceId:'archive-ui',action:payload.action,
      conversationId:payload.id,expectedSeq:manager.get(payload.id).seq,
    },'archive-ui');
    else if (method === 'cleanup') { h.cleanup(); result = true; }
    else result = methods[method] ? await h.call(methods[method],payload) : {ok:true};
    process.stdout.write(JSON.stringify({result,events:h.events.splice(0)})+'\n');
  } catch (error) { process.stdout.write(JSON.stringify({error:error.stack})+'\n'); }
});
"""
driver = subprocess.Popen(
    ['node', '-e', driver_source], cwd=repo, stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
)
rpc_lock = threading.Lock()


def rpc(method, payload=None):
    with rpc_lock:
        driver.stdin.write(json.dumps({'method': method, 'payload': payload}) + '\n')
        driver.stdin.flush()
        line = driver.stdout.readline()
        if not line:
            raise RuntimeError(driver.stderr.read())
        response = json.loads(line)
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response


bridge = r"""(() => {
  let onEvent = () => {}, onArchived = () => {};
  window.testCall = async (method, payload) => {
    const response = await window.testRpc(method, payload);
    for (const event of response.events || []) {
      if (event.channel === 'dsh:conversation-event') onEvent(event.data);
      if (event.channel === 'dsh:archived-changed') onArchived(event.data);
    }
    return response.result;
  };
  window.dshDesktop = new Proxy({
    sharedConversations:true,
    onConversationEvent:fn=>{onEvent=fn;return()=>{};},
    onArchivedChanged:fn=>{onArchived=fn;return()=>{};},
    discussion:(action,payload)=>testCall('discussion',{action,payload}),
  }, {get:(target,key)=>key in target ? target[key]
    : String(key).startsWith('on') ? ()=>()=>{} : payload=>testCall(key,payload)});
})();"""

try:
    fixtures = rpc('fixtures')['result']
    first, second, third = fixtures['ids']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('testRpc', rpc)
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri()
                  + f'?harness=claude&conversation={second}', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        expect(page.locator('#chat')).to_contain_text('Second conversation')
        page.locator('#input').fill('Keep my unsent draft')

        def mobile(action, conversation_id):
            result = page.evaluate('args=>testCall("mobile",args)', {'action': action, 'id': conversation_id})
            assert result['ok'], result

        # Archiving another conversation keeps the open chat and its draft.
        mobile('archive', first)
        expect(page.locator(f'[data-sid="{first}"]')).to_have_count(0)
        expect(page.locator('#input')).to_have_value('Keep my unsent draft')
        assert page.evaluate('context.sessionId') == second
        mobile('restore', first)
        expect(page.locator(f'[data-sid="{first}"]')).to_have_count(1)
        expect(page.locator('#input')).to_have_value('Keep my unsent draft')

        # Archiving the open conversation uses the same neighbor as desktop archiving.
        mobile('archive', second)
        expect(page.locator(f'[data-sid="{second}"]')).to_have_count(0)
        page.wait_for_function('id => !loadingSession && context.sessionId === id', arg=third)
        expect(page.locator('#chat')).to_contain_text('Third conversation')
        assert page.evaluate('id => readUi("draft:" + id).text', second) == 'Keep my unsent draft'
        mobile('archive', third)
        page.wait_for_function('id => !loadingSession && context.sessionId === id', arg=first)
        mobile('archive', first)
        page.wait_for_function('!loadingSession && context.sessionId === null')
        assert page.evaluate('context.workspaceId') == fixtures['workspaceId']
        expect(page.locator('#headerTitle')).to_have_text('New session')

        # Restoring a conversation refreshes the list without leaving the draft page.
        mobile('restore', second)
        expect(page.locator(f'[data-sid="{second}"]')).to_have_count(1)
        assert page.evaluate('context.sessionId') is None
        assert not errors, errors
        browser.close()
    print('PASS: phone archive/restore refresh desktop lists, preserve drafts, open neighbors and retain the workspace')
finally:
    try:
        if driver.poll() is None:
            rpc('cleanup')
    finally:
        driver.terminate()
        driver.wait(timeout=10)
