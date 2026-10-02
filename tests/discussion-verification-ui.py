"""Exercise automatic/member verification, cancellation, errors and readiness in the real renderer. No model calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
bridge = r"""(() => {
  const pending = {available:false,canVerify:true,detail:'Verify this connection with two short messages for this app session. This uses model quota.'};
  const member = {id:'member-one',name:'Reviewer',engine:'codex',connection:'subscription',model:'test-model',accountLabel:'UI fixture',capability:{...pending}};
  const group = {id:'group-one',title:'Verification UI',revision:1,participants:[member],messages:[],requests:[],deliveries:[]};
  const binding = {id:'binding-one',label:'Test model',accountLabel:'UI fixture',binding:{engine:'codex',connection:'subscription',model:'test-model'},capability:{...pending}};
  const names = ['Ollama Cloud', 'nVidia', 'DeepSeek', 'MiMo', 'QClaw'];
  const apiBindings = ['claude','codex','dsh','kimi','antigravity','pi'].flatMap(engine=>names.map((name,i)=>({
    id:engine+'-provider-'+i,providerId:'provider-'+i,providerLabel:name,label:'shared-model',accountLabel:name+' · Test account',
    binding:{engine,connection:'api',model:'shared-model'},capability:{available:true},
  })));
  const subscriptions = ['antigravity','kimi'].map(engine=>({id:engine+'-subscription',label:engine+' test',accountLabel:'Subscription account',
    binding:{engine,connection:'subscription',model:engine+'-test'},capability:{...pending,supported:true}}));
  window.calls=[]; window.verificationOutcome='pending'; let resolveCheck, resolveSend, emit=()=>{}, sent;
  let automaticMember;
  window.automaticAdds=false;
  window.finishAutomaticVerification=(error='')=>{
    automaticMember.verifying=false; automaticMember.verificationError=error || null;
    automaticMember.capability=error ? {...pending} : {available:true};
    group.verifying=false; emit({discussionId:group.id});
  };
  window.resetConnection=()=>{member.capability={...pending};};
  window.finishSend=()=>{
    group.verifying=false; member.capability={available:true}; group.revision++;
    group.messages=[{id:'user-one',role:'user',text:sent.text},{id:'reply-one',role:'assistant',speakerId:member.id,speakerName:member.name,text:'[UI fixture] Answer received.'}];
    resolveSend({ok:true,group});emit({discussionId:group.id});
  };
  window.finishVerification=()=>{member.capability={available:true};binding.capability={available:true};resolveCheck({ok:true,group,bindings:[binding]});};
  window.dshDesktop={
    workbenchSettings:async()=>({ok:true,language:'zh-CN',chatContentWidth:'standard'}),
    onLanguageChanged:()=>()=>{},onChatContentWidthChanged:()=>()=>{},onDiscussionEvent:fn=>{emit=fn;return()=>{};},switchMode:async()=>({ok:true}),
    discussion:async(action,payload)=>{
      window.calls.push(action);
      if(action==='list')return {ok:true,groups:[{id:group.id,title:group.title,members:1}]};
      if(action==='load')return {ok:true,group};
      if(action==='catalog')return {ok:true,bindings:[binding,...subscriptions,...apiBindings]};
      if(action==='add-member'){
        window.addedBinding=payload.bindingId;
        if(window.automaticAdds){
          automaticMember={...member,id:'automatic-member',name:payload.name,capability:{...pending},verifying:true};
          group.participants.push(automaticMember); group.revision++; group.verifying=true;
        }
        return {ok:true,group};
      }
      if(action==='send'){sent=payload;group.verifying=true;emit({discussionId:group.id});return new Promise(resolve=>{resolveSend=resolve;});}
      if(action==='stop'){group.verifying=false;resolveSend({ok:false,error:'Discussion cancelled'});emit({discussionId:group.id});return {ok:true,group};}
      if(action==='verify-binding'||action==='verify-member'){
        if(window.verificationOutcome==='fail')return {ok:false,error:'Selected account quota is exhausted.'};
        return new Promise(resolve=>{resolveCheck=resolve;});
      }
      if(action==='cancel-verification'||action==='cancel-member-verification'){
        if(automaticMember?.verifying && payload.participantId===automaticMember.id){window.finishAutomaticVerification('Discussion cancelled');return {ok:true};}
        resolveCheck({ok:false,error:'Discussion cancelled'});return {ok:true};
      }
      return {ok:false,error:'Unexpected fixture action: '+action};
    },
  };
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1200, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/discussions/discussions.html').as_uri(), wait_until='networkidle')
    expect(page.locator('#groupTitle')).to_have_text('Verification UI')
    page.locator('#membersToggle').click()
    members = page.locator('#membersPanel')
    expect(members).to_contain_text('会消耗少量模型用量')
    members.get_by_role('button', name='验证连接', exact=True).click()
    members.get_by_role('button', name='取消验证', exact=True).click()
    expect(members).to_contain_text('已取消讨论请求')
    assert page.evaluate("calls.filter(x=>x==='verify-member').length") == 1
    page.evaluate("verificationOutcome='fail'")
    members.get_by_role('button', name='验证连接', exact=True).click()
    expect(members).to_contain_text('Selected account quota is exhausted.')
    page.evaluate("verificationOutcome='pending'")
    members.locator('[data-close="membersPanel"]').click()
    page.locator('#addMember').click()
    dialog = page.locator('#memberDialog')
    expect(page.locator('#verifyBinding')).to_be_visible()
    page.locator('#verifyBinding').click()
    expect(page.locator('#binding')).to_be_disabled()
    expect(page.locator('#saveMember')).to_be_disabled()
    expect(page.locator('#verifyBinding')).to_have_text('取消验证')
    page.locator('#verifyBinding').click()
    expect(page.locator('#bindingStatus')).to_have_text('已取消讨论请求')
    expect(page.locator('#binding')).to_be_enabled()
    page.locator('#verifyBinding').click()
    page.evaluate('finishVerification()')
    expect(page.locator('#bindingStatus')).to_have_text('可用于讨论。')
    expect(page.locator('#verifyBinding')).to_be_hidden()
    dialog.locator('[data-close="memberDialog"]').click()
    page.locator('#membersToggle').click()
    expect(members).to_contain_text('就绪')
    members.locator('[data-close="membersPanel"]').click()
    page.evaluate('resetConnection()')
    page.locator('.mention').click()
    page.locator('#message').fill('保留我的问题')
    expect(page.locator('#sendHint')).to_contain_text('首次发送')
    page.locator('#message').press('Enter')
    expect(page.locator('#sendHint')).to_contain_text('正在检查连接')
    expect(page.locator('#message')).to_have_value('保留我的问题')
    expect(page.locator('#send')).to_be_disabled()
    page.locator('#stopAll').click()
    expect(page.locator('#notice')).to_contain_text('已取消讨论请求')
    expect(page.locator('#message')).to_have_value('保留我的问题')
    expect(page.locator('#messages')).to_be_empty()
    page.locator('#message').press('Enter')
    expect(page.locator('#stopAll')).to_be_enabled()
    page.evaluate('finishSend()')
    expect(page.locator('#message')).to_have_value('')
    expect(page.locator('#messages')).to_contain_text('[UI fixture] Answer received.')
    assert page.evaluate("calls.filter(x=>x==='send').length") == 2
    page.locator('#addMember').click()
    expect(page.locator('#providerField')).to_be_hidden()
    page.locator('#connection').select_option('api')
    expect(page.locator('#provider')).to_be_visible()
    expect(page.locator('#provider option')).to_have_text(['所有已启用供应商','Ollama Cloud','nVidia','DeepSeek','MiMo','QClaw'])
    expect(page.locator('#binding option')).to_have_count(5)
    expect(page.locator('#bindingLabel')).to_have_text('模型与供应商')
    expect(page.locator('#binding option')).to_have_text(['shared-model · '+name for name in ['Ollama Cloud','nVidia','DeepSeek','MiMo','QClaw']])
    for index in range(5):
        page.locator('#provider').select_option(f'provider-{index}')
        expect(page.locator('#binding option')).to_have_count(1)
        expect(page.locator('#binding')).to_have_value(f'codex-provider-{index}')
    page.locator('#provider').select_option('provider-2')
    expect(page.locator('#engine option')).to_have_text(['Claude Code','Codex CLI','DeepSeek Harness','Kimi Code','Antigravity','Pi'])
    for engine in ['claude','codex','dsh','kimi','antigravity','pi']:
        page.locator('#engine').select_option(engine)
        expect(page.locator('#binding')).to_have_value(f'{engine}-provider-2')
        expect(page.locator('#saveMember')).to_be_enabled()
    page.locator('#engine').select_option('antigravity')
    expect(page.locator('#binding')).to_have_value('antigravity-provider-2')
    page.locator('#refreshModels').click()
    expect(page.locator('#provider')).to_have_value('provider-2')
    expect(page.locator('#binding')).to_have_value('antigravity-provider-2')
    preview = repo / 'dist/ui-preview'
    preview.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(preview / 'discussion-api-provider.png'), animations='disabled')
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    expect(page.locator('#provider')).to_be_visible()
    page.screenshot(path=str(preview / 'discussion-api-provider-narrow.png'), animations='disabled')
    page.locator('#saveMember').click()
    assert page.evaluate('addedBinding') == 'antigravity-provider-2'
    page.locator('#addMember').click()
    page.locator('#connection').select_option('subscription')
    expect(page.locator('#providerField')).to_be_hidden()
    expect(page.locator('#bindingLabel')).to_have_text('模型与账号')
    expect(page.locator('#binding')).to_have_value('antigravity-subscription')
    expect(page.locator('#saveMember')).to_be_enabled()
    page.locator('#engine').select_option('kimi')
    expect(page.locator('#binding')).to_have_value('kimi-subscription')
    expect(page.locator('#saveMember')).to_be_enabled()
    page.locator('#engine').select_option('claude')
    expect(page.locator('#connection')).to_have_value('api')
    expect(page.locator('#binding')).to_have_value('claude-provider-2')
    page.close()
    for outcome in ['success', 'failed', 'cancelled']:
        page = browser.new_page(viewport={'width':1200,'height':900})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/discussions/discussions.html').as_uri(), wait_until='networkidle')
        page.evaluate('automaticAdds=true')
        page.locator('#message').fill('Keep this draft during verification')
        page.locator('#addMember').click()
        expect(page.locator('#bindingStatus')).to_contain_text('添加成员后会自动')
        page.locator('#memberName').fill('Automatic reviewer')
        page.locator('#saveMember').click()
        expect(page.locator('#memberDialog')).not_to_be_visible()
        expect(page.locator('#connectionNotice')).to_contain_text('正在验证成员连接')
        expect(page.locator('#sendHint')).to_contain_text('你可以继续输入')
        page.locator('#membersToggle').click()
        card = page.locator('.member-card[data-member-id="automatic-member"]')
        expect(card.locator('.member-state')).to_have_text('正在验证连接…')
        expect(card.get_by_role('button', name='取消验证', exact=True)).to_be_visible()
        assert page.evaluate("calls.filter(x=>x==='verify-member'||x==='verify-binding').length") == 0
        if outcome == 'cancelled':
            card.get_by_role('button', name='取消验证', exact=True).click()
            expect(card).to_contain_text('已取消讨论请求')
            expect(card.locator('.member-state')).to_have_text('连接待验证')
        elif outcome == 'failed':
            page.evaluate("finishAutomaticVerification('Selected account quota is exhausted.')")
            expect(card.locator('.member-state')).to_have_text('连接验证失败')
            expect(card).to_contain_text('Selected account quota is exhausted.')
            expect(card.get_by_role('button', name='验证连接', exact=True)).to_be_visible()
        else:
            page.evaluate('finishAutomaticVerification()')
            expect(card.locator('.member-state')).to_have_text('就绪')
            expect(card.get_by_role('button', name='验证连接', exact=True)).not_to_be_visible()
        expect(page.locator('#message')).to_have_value('Keep this draft during verification')
        expect(page.locator('#messages')).to_be_empty()
        assert page.evaluate("calls.filter(x=>x==='add-member').length") == 1
        page.close()
    assert not errors, errors
    browser.close()
print('PASS: automatic member verification status/success/failure/cancel without extra verify calls; drafts preserved; first-send checks, replies, manual verification; six harnesses, five API providers, three subscription paths and narrow layout. Synthetic backend only.')
