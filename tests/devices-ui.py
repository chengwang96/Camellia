from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
asset_png = (root / 'assets/icon-256.png').as_posix()
asset_url = (root / 'assets/icon-256.png').as_uri()
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1160, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.calls = [];
      window.camelliaDevices = {
        async openSettings() { window.openedSettings = true; return {ok:true}; },
        onEvent(callback) { window.deviceEvent = callback; },
        onTransfer(callback) { window.transferEvent = callback; },
        async call(action, payload) {
          window.calls.push({action, payload});
          if (action === 'conversations' && window.holdConnection) {
            await new Promise(resolve => { window.releaseConnection = resolve; });
            return {ok:false,error:'Device response timed out; verify state before retrying writes'};
          }
          const conversation = {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'Server conversation',seq:2,workspaceId:'project',activity:null};
          const info = {instanceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',workspaces:[{id:'project',name:'Paper agent'}],capabilities:['create-workspace','delete-workspace','api-import','attachments','artifacts','restore','native-settings','server-management','move'],engines:['dsh','codex','pi'],nextOffset:null};
          if(action === 'server-manage') {
            const operation = payload.request.action;
            const results = {
              'runtime-state': [{id:'codex',name:'Codex CLI',status:'ready',version:'1.0'},{id:'dsh',name:'DeepSeek Harness',status:'ready',version:'1.0'},{id:'pi',name:'Pi',status:'ready',version:'0.73.1'}],
              'runtime-check': [{id:'codex',name:'Codex CLI',installed:'1.0',latest:'1.1'}],
              'settings': {engines:[{id:'codex',model:'model-a'}],api:{models:['model-a']}},
              'usage': {providers:[{name:'Example',requests:3,failures:0,inputTokens:100,outputTokens:50}]},
              'storage-scan': {token:'scan-1',candidates:[{path:'conversations/orphan.jsonl',bytes:10}]},
              'storage-clean': {files:1,bytes:10,skipped:0}
            };
            return {ok:true,result:{id:payload.request.requestId,state:'complete',result:results[operation] || {}}};
          }
          if(action === 'native-settings-get') return {ok:true,result:{engine:payload.engine,editable:true,files:[{id:'settings',label:'Native config',format:'yaml',revision:'a'.repeat(64),text:'custom: true'}]}};
          if(action === 'native-settings-save') return {ok:true,result:{ok:true,revision:'b'.repeat(64)}};
          if(action === 'archived') return {ok:true,result:{...info,conversations:[{...conversation,title:'Archived conversation'}]}};
          if(action === 'attachments-select') return {ok:true,result:{files:[{id:'attachment-1',name:'notes.txt',size:12,isImage:false}]}};
          if(action === 'attachments-add') return {ok:true,result:{files:payload.files.map((file,index) => ({id:'paste-'+index,name:file.name,size:3,isImage:false}))}};
          if(action === 'artifacts') return {ok:true,result:{artifacts:[{id:'a'.repeat(64),name:'result.txt',size:20}],nextOffset:null}};
          if(action === 'download') return {ok:true,result:{id:'download-1',name:'result.txt',size:20}};
          if(action === 'import-preview') return {ok:true,result:{id:'preview-1',target:'GPU server',providers:2,keys:3,skipped:1}};
          if(action === 'import-apply') return {ok:true,result:{ok:true,state:'accepted',added:2,keys:3,skipped:0,enabled:true}};
          if(action === 'state') return {ok:true,result:{language:'en',theme:'light',devices:[{id:'server-a',name:'GPU server',address:'http://100.80.1.2:43127'},{id:'server-b',name:'Build server',address:'http://100.80.1.3:43127'}],network:{state: window.networkMockState || 'Running'}}};
          if(action === 'conversations') return {ok:true,result:{...info,conversations:[{...conversation,title:payload.deviceId === 'server-a' ? 'Server conversation' : 'Other server conversation'}]}};
          if(action === 'snapshot' && payload.before !== undefined) return {ok:true,result:{...info,conversation,messages:[{seq:0,role:'user',text:'Earlier server message'}],live:null,nextBefore:null}};
          if(action === 'snapshot') {
            const account = {id:'model-a',name:'Model A',connection:'subscription',thinking:['low','high']};
            const route = {id:'route-a',name:'route-a',connection:'api',thinking:['low']};
            const connection = window.snapshotConnection || 'subscription';
            const models = connection === 'subscription' ? [account, route] : [route, account];
            return {ok:true,result:{...info,conversation,messages:[{seq:1,role:'user',text:'<script>unsafe</script>'},{seq:2,role:'assistant',text:'Ready on the server.'}],live:null,nextBefore:1,settings:{editable:true,version:'settings-1',connection,model:models[0].id,permissionMode:'ask',models,permissionLevels:['ask','auto','full']}}};
          }
          if(action === 'command') return {ok:true,result:{ok:true,state:'accepted',conversation}};
          if(action === 'pair') return {ok:true,result:{id:'pending',state:'pending'}};
          if(action === 'claim') return {ok:true,result:{state:'approved'}};
          return {ok:true,result:{}};
        }
      };
    """)
    page.goto((root / "src/renderer/devices/devices.html").as_uri() + '?device=server-a')
    page.wait_for_load_state("networkidle")
    expect(page.locator("#device")).not_to_be_visible()
    expect(page.locator("#targetName")).to_have_text("GPU server")
    expect(page.locator("#newWorkspace")).to_be_enabled()
    assert page.locator("#networkStop").count() == 0
    expect(page.locator('[data-copy="networkHint"]')).to_contain_text("sign in once")
    expect(page.locator('[data-copy="networkHint"]')).to_contain_text("Mobile access")
    page.locator('.workspace-toggle').first.click()
    expect(page.get_by_role('button', name='Server conversation', exact=True)).not_to_be_visible()
    page.locator('.workspace-toggle').first.click()
    expect(page.get_by_role('button', name='Server conversation', exact=True)).to_be_visible()
    page.evaluate('''() => {
      const transfer = new DataTransfer();
      document.querySelector('.conversation').dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer:transfer}));
      document.querySelectorAll('.group-head')[1].dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:transfer}));
    }''')
    page.wait_for_function("calls.some(call => call.action === 'command' && call.payload.command.action === 'move')")
    assert page.evaluate("calls.find(call => call.action === 'command' && call.payload.command.action === 'move').payload.command.workspaceId") is None
    page.locator('#prompt').fill('Draft in new conversation')
    page.get_by_role('button', name='Server conversation', exact=True).click()
    page.locator('#prompt').fill('Draft in server conversation')
    page.locator('#newChat').click()
    expect(page.locator('#prompt')).to_have_value('')
    page.locator('#draftWorkspace').select_option('')
    expect(page.locator('#prompt')).to_have_value('Draft in new conversation')
    page.get_by_role('button', name='Server conversation', exact=True).click()
    expect(page.locator('#prompt')).to_have_value('Draft in server conversation')
    page.evaluate('''() => {
      const clipboard = new DataTransfer(); clipboard.items.add(new File(['abc'], 'pasted.txt', {type:'text/plain'}));
      document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste', {clipboardData:clipboard,bubbles:true,cancelable:true}));
    }''')
    expect(page.locator('#attachmentTray')).to_contain_text('pasted.txt')
    assert page.evaluate("calls.find(call => call.action === 'attachments-add').payload.files[0].data") == 'YWJj'
    page.locator('#attachmentTray button').click()
    page.evaluate('''() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['def'], 'dropped.txt', {type:'text/plain'}));
      document.getElementById('composer').dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true}));
    }''')
    expect(page.locator('#attachmentTray')).to_contain_text('dropped.txt')
    page.locator('#attachmentTray button').click()
    page.locator('#newChat').click()
    page.locator('#prompt').fill('Choose model before sending')
    expect(page.locator('#configure')).to_be_enabled()
    page.locator('#configure').click()
    expect(page.locator('#dialog')).to_be_visible()
    expect(page.locator('#prompt')).to_have_value('Choose model before sending')
    page.locator('#cancel').click()
    assert not page.evaluate("calls.some(call => call.action === 'command' && call.payload.command.action === 'send')")
    page.locator('#newChat').click()
    expect(page.locator('#brandIcon')).to_have_attribute('src', '../../../assets/brands/deepseek.svg')
    page.locator('#openServerSettings').click()
    expect(page.locator('#serverSettings')).to_be_visible()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Codex CLI')
    assert page.locator('#serverSettingsNav button').count() == 4
    page.locator('#serverSettingsBody').get_by_role('button', name='Uninstall', exact=True).first.click()
    expect(page.locator('#serverConfirm')).to_contain_text('GPU server')
    page.locator('#serverConfirmAccept').click()
    page.wait_for_function("calls.some(call => call.action === 'server-manage' && call.payload.request.action === 'runtime-uninstall')")
    assert page.evaluate("calls.find(call => call.action === 'server-manage' && call.payload.request.action === 'runtime-uninstall').payload.request.payload.confirmed")
    page.locator('[data-page=engines]').click()
    expect(page.locator('#serverSettingsBody select').first).to_have_value('model-a')
    expect(page.locator('#serverSettingsBody')).to_contain_text('Sync providers')
    page.locator('[data-page=usage]').click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Requests 3')
    page.locator('[data-page=archived]').click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Archived conversation')
    page.locator('[data-page=usage]').click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Requests 3')
    page.locator('[data-page=archived]').click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Archived conversation')
    page.get_by_role('button', name='Scan unused files', exact=True).click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('orphan.jsonl')
    page.get_by_role('button', name='Clean listed files', exact=True).click()
    page.locator('#serverConfirmAccept').click()
    expect(page.locator('#serverSettingsBody')).to_contain_text('Files removed: 1')
    page.screenshot(path=str(root / '.tmp-server-settings.png'), full_page=True)
    page.locator('#serverSettingsClose').click()
    page.locator('#harness').select_option('pi')
    expect(page.locator('#brandTitle')).to_have_text('Pi')
    expect(page.locator('#brandIcon')).to_have_attribute('src', '../../../assets/brands/pi.svg')
    page.locator('#prompt').fill('Start with Pi')
    page.locator('#send').click()
    expect(page.locator('#prompt')).to_have_value('')
    assert page.evaluate("calls.filter(call => call.action === 'command' && call.payload.command.action === 'create').at(-1).payload.command.engine") == 'pi'
    page.screenshot(path=str(root / '.tmp-server-workbench-empty.png'), full_page=True)
    page.locator('#harness').select_option('codex')
    page.locator('#draftWorkspace').select_option('project')
    page.locator('#prompt').fill('Start on the server')
    page.locator('#send').click()
    expect(page.locator('#prompt')).to_have_value('')
    created = page.evaluate("calls.filter(call => call.action === 'command' && call.payload.command.action === 'create').at(-1).payload.command")
    assert created['engine'] == 'codex'
    assert created['workspaceId'] == 'project'
    page.locator('.server-tools summary').click()
    page.locator("#nativeSettings").click()
    page.locator("#submit").click()
    expect(page.locator("#nativeDialog")).to_be_visible()
    expect(page.locator("#nativeTitle")).to_contain_text("GPU server")
    page.locator("#nativeText").fill("custom: false")
    page.locator("#nativeSave").click()
    assert not page.evaluate("calls.some(call => call.action === 'native-settings-save')")
    page.locator("#nativeConfirm").check()
    page.locator("#nativeSave").click()
    expect(page.locator("#nativeDialog")).not_to_be_visible()
    saved = page.evaluate("calls.find(call => call.action === 'native-settings-save').payload")
    assert saved['deviceId'] == 'server-a'
    assert saved['settings']['confirmed'] is True
    assert saved['settings']['text'] == 'custom: false'
    page.locator("#importApi").click()
    expect(page.locator("#dialogHint")).to_contain_text("2 providers and 3 API keys")
    expect(page.locator("#dialogTitle")).to_contain_text("GPU server")
    page.locator("#submit").click()
    expect(page.locator("#notice")).to_contain_text("Added providers: 2")
    expect(page.locator("#dialog")).not_to_be_visible()
    page.get_by_role("button", name="Server conversation", exact=True).click()
    expect(page.locator("#chat")).to_be_visible()
    expect(page.locator("#messages")).to_contain_text("<script>unsafe</script>")
    assert page.locator("#messages script").count() == 0
    page.evaluate("""([assetPng, assetUrl]) => {
      const area = document.createElement('article'); area.id = 'markdown-fixture'; area.className = 'message message-body';
      const markdown = '# Result\\n\\n**bold** and `inline`\\n\\n| Item | Count |\\n| --- | ---: |\\n| one | 2 |\\n\\n- first\\n- second\\n  - nested one\\n  - nested two\\n- [x] done task\\n- [ ] todo task\\n\\n质能 $E = mc^2$ 与 Bessel $J_\\\\nu(z)=\\\\frac{1}{2}$\\n\\n$$\\n\\\\hat{H}\\\\,\\\\psi_n = E_n\\\\,\\\\psi_n, \\\\qquad E_n = -\\\\frac{m_e e^4}{2\\\\hbar^2}\\\\cdot\\\\frac{1}{n^2}\\n$$\\n\\n价格 $5 and $10 today\\n\\n```js\\nconst html = "<script>not executable</script>";\\n```\\n\\n    const indented = true;\\n\\n[unsafe](javascript:evil) [safe](https://example.com) 自动链接 https://example.com/path 与 me@example.com\\n\\n![remote](https://evil.example/pixel.png) ![abs](' + assetPng + ') ![file](' + assetUrl + ')\\n\\n![unsafe](javascript:alert(1)) ![inline](data:image/png;base64,AAAA)\\n\\n文件 README.md 和 setup.sh 保持原样\\n<img src=https://evil.example/pixel onerror=alert(1)>';
      area.append(CamelliaMarkdown.render(document, markdown, {copy: async text => {window.copiedCode=text}}));
      document.querySelector('main').append(area);
    }""", [asset_png, asset_url])
    expect(page.locator('#markdown-fixture h1')).to_have_text('Result')
    expect(page.locator('#markdown-fixture strong')).to_have_text('bold')
    assert page.locator('#markdown-fixture table tbody tr').count() == 1
    assert page.locator('#markdown-fixture > ul > li').count() == 4
    assert page.locator('#markdown-fixture ul ul li').count() == 2
    assert page.locator('#markdown-fixture li.md-task').count() == 2
    assert page.locator('#markdown-fixture li.md-task input:checked').count() == 1
    assert page.locator('#markdown-fixture .md-math .katex').count() == 2
    assert page.locator('#markdown-fixture .md-math-display .katex-display').count() == 1
    assert page.locator('#markdown-fixture .md-math math').count() >= 1
    expect(page.locator('#markdown-fixture')).to_contain_text('价格 $5 and $10 today')
    assert page.locator('#markdown-fixture .md-code-block').count() == 2
    assert page.locator('#markdown-fixture script').count() == 0
    assert page.locator('#markdown-fixture img.chat-inline-image').count() == 3
    assert page.locator('#markdown-fixture img.chat-inline-image[src^="file:"]').count() == 2
    assert page.locator('#markdown-fixture a').count() == 3
    assert page.locator('#markdown-fixture a[href="mailto:me@example.com"]').count() == 1
    expect(page.locator('#markdown-fixture')).to_contain_text('README.md 和 setup.sh 保持原样')
    page.locator('#markdown-fixture .md-code-copy').first.click()
    assert '<script>not executable</script>' in page.evaluate('copiedCode')
    page.locator('#markdown-fixture .md-code-wrap').first.click()
    expect(page.locator('#markdown-fixture .md-code').first).to_have_class('md-code is-wrapped')
    page.locator('#markdown-fixture').evaluate('(node) => node.remove()')
    page.evaluate("""() => {
      const area = document.createElement('article'); area.id = 'bilingual-fixture'; area.className = 'message message-body';
      area.append(CamelliaMarkdown.render(document, '- `Title one`\\n中文译文一\\n- `Title two`\\n中文译文二\\n\\n- item\\n\\n普通段落'));
      document.querySelector('main').append(area);
    }""")
    assert page.locator('#bilingual-fixture > ul').first.locator('> li').count() == 2
    expect(page.locator('#bilingual-fixture li').first).to_contain_text('中文译文一')
    expect(page.locator('#bilingual-fixture')).to_contain_text('普通段落')
    assert page.locator('#bilingual-fixture > p').count() == 1
    page.locator('#bilingual-fixture').evaluate('(node) => node.remove()')
    page.locator("#attach").click()
    expect(page.locator("#attachmentTray")).to_contain_text("notes.txt")
    page.locator("#older").click()
    expect(page.locator("#messages")).to_contain_text("Earlier server message")
    expect(page.locator("#older")).not_to_be_visible()
    page.locator("#configure").click()
    expect(page.locator("#field-model optgroup[label='Account models']")).to_have_count(1)
    expect(page.locator("#field-model optgroup[label='Shared API routes']")).to_have_count(1)
    assert page.evaluate("[...document.querySelectorAll('#field-model option')].map(option => option.value)") == ['model-a', 'route-a']
    page.locator("#field-thinking").select_option("high")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    assert page.evaluate("calls.filter(call => call.action === 'command').at(-1).payload.command.settings.thinking") == 'high'
    page.locator("#configure").click()
    page.locator("#field-model").select_option("route-a")
    assert page.evaluate("document.querySelectorAll('#field-thinking option').length") == 2
    page.locator("#cancel").click()
    # The same grouping must hold when the conversation runs on shared API routes.
    page.evaluate("window.snapshotConnection = 'api'")
    page.locator("#refresh").click()
    page.wait_for_function("document.querySelector('#configure').textContent === 'route-a'")
    page.locator("#configure").click()
    expect(page.locator("#field-model optgroup[label='Account models']")).to_have_count(1)
    expect(page.locator("#field-model optgroup[label='Shared API routes']")).to_have_count(1)
    assert page.evaluate("[...document.querySelectorAll('#field-model option')].map(option => option.value)") == ['route-a', 'model-a']
    page.locator("#field-model").select_option("model-a")
    assert page.evaluate("document.querySelectorAll('#field-thinking option').length") == 3
    page.locator("#cancel").click()
    page.locator("#prompt").fill("Run the check")
    page.locator("#send").click()
    expect(page.locator("#prompt")).to_have_value("")
    sent = page.evaluate("calls.filter(call => call.action === 'command').at(-1)")
    assert sent["payload"]["deviceId"] == "server-a"
    assert sent["payload"]["command"]["expectedSeq"] == 2
    assert sent["payload"]["command"]["requestId"]
    assert sent["payload"]["attachmentIds"] == ['attachment-1']
    assert 'attachments' not in sent["payload"]["command"]
    expect(page.locator("#attachmentTray")).to_be_empty()
    page.locator("#artifactPanel summary").click()
    page.locator("#loadArtifacts").click()
    expect(page.locator("#artifacts")).to_contain_text("result.txt")
    page.locator("#artifacts button").click()
    expect(page.locator("#transfers")).to_contain_text("Downloading")
    page.locator("#transfers button").click()
    page.wait_for_function("calls.some(call => call.action === 'download-cancel')")
    page.evaluate("transferEvent({id:'download-1',deviceId:'server-a',name:'result.txt',state:'cancelled'})")
    expect(page.locator("#transfers")).to_contain_text("Cancelled")
    page.locator("#newWorkspace").click()
    expect(page.locator("#dialogTitle")).to_contain_text("GPU server")
    page.locator("#field-name").fill("New project")
    page.locator("#field-path").fill("/srv/project")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    page.evaluate("deviceEvent({type:'offline'})")
    expect(page.locator("#send")).to_be_disabled()
    expect(page.locator("#newWorkspace")).to_be_disabled()
    page.goto((root / "src/renderer/devices/devices.html").as_uri() + '?device=server-b')
    page.wait_for_load_state('networkidle')
    expect(page.locator("#targetName")).to_have_text("Build server")
    expect(page.locator("#chat")).not_to_be_visible()
    expect(page.locator("#tree")).to_contain_text("Other server conversation")
    page.locator('.server-tools summary').click()
    page.locator("#selectChats").click()
    page.locator(".conversation-row input").check()
    page.locator("#deleteSelected").click()
    expect(page.locator("#dialogTitle")).to_contain_text("Build server")
    expect(page.locator("#dialogHint")).to_contain_text("Other server conversation")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    deleted = page.evaluate("calls.filter(call => call.action === 'command').at(-1)")
    assert deleted['payload']['command']['action'] == 'delete'
    assert deleted['payload']['command']['targets'][0]['seq'] == 2
    page.locator('#archivePanel').evaluate('node => node.open = true')
    page.locator("#loadArchived").click()
    expect(page.locator("#archived")).to_contain_text("Archived conversation")
    page.locator("#archived button").click()
    expect(page.locator("#dialogTitle")).to_contain_text("Build server")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    assert page.evaluate("calls.filter(call => call.action === 'command').at(-1).payload.command.action") == 'restore'
    expect(page.locator("#targetName")).to_have_text("Build server")
    expect(page.locator("#connection")).to_contain_text("Connected")
    page.screenshot(path=str(root / ".tmp-cli-devices.png"), full_page=True)
    page.set_viewport_size({"width": 480, "height": 820})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.evaluate("window.holdConnection = true")
    page.locator('#refresh').click()
    expect(page.locator('#connection')).to_contain_text('Connecting to server')
    expect(page.locator('#refresh')).to_be_disabled()
    expect(page.locator('#connectionSettings')).to_be_enabled()
    page.locator('#connectionSettings').click()
    assert page.evaluate('openedSettings')
    page.evaluate('window.releaseConnection()')
    expect(page.locator('#error')).to_contain_text('20 seconds')
    expect(page.locator('#refresh')).to_be_enabled()
    expect(page.locator('#send')).to_be_disabled()
    page.evaluate('window.holdConnection = false')
    page.locator('#refresh').click()
    expect(page.locator('#connection')).to_contain_text('Connected')
    page.evaluate("window.networkMockState = 'NeedsLogin'")
    page.locator('#refresh').click()
    expect(page.locator('#error')).to_contain_text('needs sign-in')
    expect(page.locator('#refresh')).to_be_enabled()
    assert not errors, errors
    browser.close()
print("CLI server workbench: direct launch, harness selection, writes, offline guard and narrow layout passed")
