from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1160, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""
      window.calls = [];
      window.camelliaDevices = {
        onEvent(callback) { window.deviceEvent = callback; },
        onTransfer(callback) { window.transferEvent = callback; },
        async call(action, payload) {
          window.calls.push({action, payload});
          const conversation = {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'Server conversation',seq:2,workspaceId:'project',activity:null};
          const info = {instanceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',workspaces:[{id:'project',name:'Paper agent'}],capabilities:['create-workspace','delete-workspace','api-import','attachments','artifacts','restore','native-settings'],engines:['dsh'],nextOffset:null};
          if(action === 'native-settings-get') return {ok:true,result:{engine:payload.engine,editable:true,files:[{id:'settings',label:'Native config',format:'yaml',revision:'a'.repeat(64),text:'custom: true'}]}};
          if(action === 'native-settings-save') return {ok:true,result:{ok:true,revision:'b'.repeat(64)}};
          if(action === 'archived') return {ok:true,result:{...info,conversations:[{...conversation,title:'Archived conversation'}]}};
          if(action === 'attachments-select') return {ok:true,result:{files:[{id:'attachment-1',name:'notes.txt',size:12,isImage:false}]}};
          if(action === 'artifacts') return {ok:true,result:{artifacts:[{id:'a'.repeat(64),name:'result.txt',size:20}],nextOffset:null}};
          if(action === 'download') return {ok:true,result:{id:'download-1',name:'result.txt',size:20}};
          if(action === 'import-preview') return {ok:true,result:{id:'preview-1',target:'GPU server',providers:2,keys:3,skipped:1}};
          if(action === 'import-apply') return {ok:true,result:{ok:true,state:'accepted',added:2,keys:3,skipped:0,enabled:true}};
          if(action === 'state') return {ok:true,result:{language:'en',theme:'light',devices:[{id:'server-a',name:'GPU server',address:'http://100.80.1.2:43127'},{id:'server-b',name:'Build server',address:'http://100.80.1.3:43127'}],network:{state: window.networkMockState || 'Running'}}};
          if(action === 'conversations') return {ok:true,result:{...info,conversations:[{...conversation,title:payload.deviceId === 'server-a' ? 'Server conversation' : 'Other server conversation'}]}};
          if(action === 'snapshot' && payload.before !== undefined) return {ok:true,result:{...info,conversation,messages:[{seq:0,role:'user',text:'Earlier server message'}],live:null,nextBefore:null}};
          if(action === 'snapshot') return {ok:true,result:{...info,conversation,messages:[{seq:1,role:'user',text:'<script>unsafe</script>'},{seq:2,role:'assistant',text:'Ready on the server.'}],live:null,nextBefore:1,settings:{editable:true,version:'settings-1',model:'model-a',permissionMode:'ask',models:[{id:'model-a',name:'Model A',thinking:['low','high']}],permissionLevels:['ask','auto','full']}}};
          if(action === 'command') return {ok:true,result:{ok:true,state:'accepted'}};
          if(action === 'pair') return {ok:true,result:{id:'pending',state:'pending'}};
          if(action === 'claim') return {ok:true,result:{state:'approved'}};
          return {ok:true,result:{}};
        }
      };
    """)
    page.goto((root / "src/renderer/devices/devices.html").as_uri())
    page.wait_for_load_state("networkidle")
    expect(page.locator("#newWorkspace")).to_be_disabled()
    page.evaluate("window.networkMockState = 'NeedsLogin'")
    page.locator("#refresh").click()
    expect(page.locator("#networkState")).to_contain_text("Sign-in required")
    page.locator("#add").click()
    expect(page.locator("#error")).to_contain_text("takes two steps")
    expect(page.locator("#dialog")).not_to_be_visible()
    assert page.locator("#networkPanel").evaluate("node => node.open") is True
    page.evaluate("window.networkMockState = 'Running'")
    page.locator("#refresh").click()
    expect(page.locator("#networkState")).to_contain_text("Connected")
    page.locator("#device").select_option("server-a")
    expect(page.locator("#targetName")).to_have_text("GPU server")
    expect(page.locator("#newWorkspace")).to_be_enabled()
    assert page.locator("#networkStop").count() == 0
    expect(page.locator('[data-copy="networkHint"]')).to_contain_text("sign in once")
    expect(page.locator('[data-copy="networkHint"]')).to_contain_text("Mobile access")
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
    page.evaluate("""() => {
      const area = document.createElement('article'); area.id = 'markdown-fixture'; area.className = 'message message-body';
      area.append(CamelliaMarkdown.render(document, '# Result\\n\\n**bold** and `inline`\\n\\n| Item | Count |\\n| --- | ---: |\\n| one | 2 |\\n\\n- first\\n- second\\n\\n```js\\nconst html = "<script>not executable</script>";\\n```\\n\\n[unsafe](javascript:evil) [safe](https://example.com)\\n<img src=https://evil.example/pixel onerror=alert(1)>', {copy: async text => {window.copiedCode=text}}));
      document.querySelector('main').append(area);
    }""")
    expect(page.locator('#markdown-fixture h1')).to_have_text('Result')
    expect(page.locator('#markdown-fixture strong')).to_have_text('bold')
    assert page.locator('#markdown-fixture table tbody tr').count() == 1
    assert page.locator('#markdown-fixture li').count() == 2
    assert page.locator('#markdown-fixture script, #markdown-fixture img').count() == 0
    assert page.locator('#markdown-fixture a').count() == 1
    page.locator('#markdown-fixture .md-code-copy').click()
    assert '<script>not executable</script>' in page.evaluate('copiedCode')
    page.locator('#markdown-fixture .md-code-wrap').click()
    expect(page.locator('#markdown-fixture .md-code')).to_have_class('md-code is-wrapped')
    page.locator('#markdown-fixture').evaluate('(node) => node.remove()')
    page.locator("#attach").click()
    expect(page.locator("#attachmentTray")).to_contain_text("notes.txt")
    page.locator("#older").click()
    expect(page.locator("#messages")).to_contain_text("Earlier server message")
    expect(page.locator("#older")).not_to_be_visible()
    page.locator("#configure").click()
    page.locator("#field-thinking").select_option("high")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    assert page.evaluate("calls.filter(call => call.action === 'command').at(-1).payload.command.settings.thinking") == 'high'
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
    page.locator("#device").select_option("server-b")
    expect(page.locator("#targetName")).to_have_text("Build server")
    expect(page.locator("#chat")).not_to_be_visible()
    expect(page.locator("#tree")).to_contain_text("Other server conversation")
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
    page.locator("#archivePanel summary").click()
    page.locator("#loadArchived").click()
    expect(page.locator("#archived")).to_contain_text("Archived conversation")
    page.locator("#archived button").click()
    expect(page.locator("#dialogTitle")).to_contain_text("Build server")
    page.locator("#submit").click()
    expect(page.locator("#dialog")).not_to_be_visible()
    assert page.evaluate("calls.filter(call => call.action === 'command').at(-1).payload.command.action") == 'restore'
    page.locator("#add").click()
    page.locator("#field-deviceName").fill("New server")
    page.locator("#field-address").fill("http://100.80.1.4:43127")
    page.locator("#field-code").fill("a" * 24)
    page.locator("#submit").click()
    expect(page.locator("#add")).to_have_text("Check approval")
    page.locator("#cancelPair").click()
    expect(page.locator("#cancelPair")).not_to_be_visible()
    expect(page.locator("#targetName")).to_have_text("Build server")
    expect(page.locator("#connection")).to_contain_text("Connected")
    page.screenshot(path=str(root / ".tmp-cli-devices.png"), full_page=True)
    page.set_viewport_size({"width": 480, "height": 820})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert not errors, errors
    browser.close()
print("CLI devices UI: pairing, isolation, writes, offline guard and narrow layout passed")
