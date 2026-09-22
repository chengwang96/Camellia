"""Compaction timeline states and history visibility, without model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
fixture_source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
scope = {'__file__': str(repo / 'tests/shared-chat-ui.py')}
for statement in fixture_source.body:
    if isinstance(statement, ast.With):
        break
    exec(compile(ast.Module(body=[statement], type_ignores=[]), '<fixture>', 'exec'), scope)
bridge = scope['bridge'].replace('onConversationStatus:()=>{}', 'onConversationStatus:fn=>{window.deliverStatus=fn;}')
bridge = bridge.replace('preferences:window.fixturePreferences,settings};', 'preferences:window.fixturePreferences,settings,compaction:window.fixtureCompaction||null};')
bridge = bridge.replace('const fixture = ', 'const fixture = window.chatFixture = ')
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for theme in ['light', 'dark']:
        page = browser.new_page(viewport={'width': 1100, 'height': 800}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
        page.wait_for_function('uiReady')
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('#chat')).to_contain_text('Experiment review')
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Asking the engine to summarize the conversation…',compaction:{state:'running'}})")
        row = page.locator('.context-compaction')
        expect(row).to_be_visible()
        expect(row).to_have_text('Compacting context…')
        expect(row).to_have_attribute('role', 'status')
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Asking the engine to summarize the conversation…',compaction:{state:'running',stage:'summarizing',chunk:2,finalChunk:true}})")
        expect(row).to_have_text('Summarizing context: chunk 2 (last)…')
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Saving compacted context…',compaction:{state:'running',stage:'saving'}})")
        expect(row).to_have_text('Saving compacted context…')
        page.evaluate("deliverStatus({sessionId:'another-session',text:'',compaction:{state:'failed'}})")
        expect(row).to_have_attribute('data-state', 'running')
        page.screenshot(path=str(scope['preview'] / f'compaction-running-{theme}.png'))
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'completed',seq:3}});deliverStatus({sessionId:'shared-fixture',text:''})")
        expect(row).to_have_count(1)
        expect(row).to_have_text('Context compacted')
        page.screenshot(path=str(scope['preview'] / f'compaction-completed-{theme}.png'))
        for state in ['failed', 'cancelled']:
            page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Compacting context…',compaction:{state:'running'}})")
            page.evaluate("state=>deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state}})", state)
            expect(page.locator(f'.context-compaction[data-state="{state}"]')).to_contain_text('original conversation is retained')
        page.evaluate("fixtureCompaction={state:'running'}")
        page.locator('[data-sid="another-session"]').click()
        expect(page.locator('.context-compaction')).to_have_count(1)
        expect(page.locator('.context-compaction')).to_have_attribute('data-state', 'running')
        page.evaluate("fixtureCompaction=null;chatFixture.messages.push({role:'notice',text:'Context compacted: summary saved',seq:3})")
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('.context-compaction')).to_have_count(1)
        expect(page.locator('.context-compaction')).to_have_text('Context compacted')
        expect(page.locator('.handoff-notice')).to_have_count(0)
        page.evaluate("changeLanguage('zh-CN')")
        expect(page.locator('.context-compaction')).to_have_text('上下文已压缩')
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Compacting context…',compaction:{state:'running'}})")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_text('正在压缩上下文…')
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Asking the engine to summarize the conversation…',compaction:{state:'running',stage:'summarizing',chunk:3}})")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_text('正在总结上下文：第 3 块…')
        page.screenshot(path=str(scope['preview'] / f'compaction-chinese-{theme}.png'), animations='disabled')
        page.evaluate("""() => {
          deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'completed'}});
          deliverEvent({type:'conversation:started',session_id:'shared-fixture',engine:'codex',runId:91,prompt:'Continue'});
          deliverEvent({type:'gui:compaction',session_id:'shared-fixture',engine:'codex',runId:91,state:'running'});
        }""")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(1)
        page.evaluate("deliverEvent({type:'gui:compaction',session_id:'shared-fixture',engine:'codex',runId:91,state:'completed',compactionSeq:9})")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(0)
        expect(page.locator('.context-compaction[data-seq="9"]')).to_have_text('上下文已压缩')
        page.evaluate("deliverEvent({type:'result',session_id:'shared-fixture',engine:'codex',runId:91,subtype:'success',result:'Continued'})")
        assert not errors, errors
        page.close()
    browser.close()
print('PASS compaction timeline: running, completed, failure, cancellation, isolation and restoration')
