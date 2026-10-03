"""Compaction timeline states and history visibility, without model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]

# The marker must sit between the user message and the turn it interrupted, so
# later messages continue below it instead of the marker staying pinned last.
MARKER_BEFORE_LAST_TURN = """(selector) => {
  const chat = document.querySelector('#chat');
  const marker = chat.querySelector(selector);
  const turns = chat.querySelectorAll('.turn');
  const turn = turns[turns.length - 1];
  const children = [...chat.children];
  return Boolean(marker && turn) && children.indexOf(marker) === children.indexOf(turn) - 1
    && chat.lastElementChild !== marker;
}"""


def marker_before_last_turn(page, selector):
    return page.evaluate(MARKER_BEFORE_LAST_TURN, selector)

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
        page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'completed',seq:3,durationMs:42000}});deliverStatus({sessionId:'shared-fixture',text:''})")
        expect(row).to_have_count(1)
        expect(row.locator('span[data-i18n]')).to_have_text('Context compacted')
        expect(row.locator('.context-compaction-duration')).to_have_text('42 seconds')
        page.screenshot(path=str(scope['preview'] / f'compaction-completed-{theme}.png'))
        for state in ['failed', 'cancelled']:
            page.evaluate("deliverStatus({sessionId:'shared-fixture',text:'Compacting context…',compaction:{state:'running'}})")
            page.evaluate("state=>deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state}})", state)
            expect(page.locator(f'.context-compaction[data-state="{state}"]')).to_contain_text('original conversation is retained')
        page.evaluate("fixtureCompaction={state:'running'}")
        page.locator('[data-sid="another-session"]').click()
        expect(page.locator('.context-compaction')).to_have_count(1)
        expect(page.locator('.context-compaction')).to_have_attribute('data-state', 'running')
        page.evaluate("fixtureCompaction=null;chatFixture.messages.push({role:'notice',text:'Context compacted: summary saved',seq:3,compaction:{durationMs:95000}})")
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('.context-compaction')).to_have_count(1)
        expect(page.locator('.context-compaction span[data-i18n]')).to_have_text('Context compacted')
        expect(page.locator('.context-compaction .context-compaction-duration')).to_have_text('1 minute 35 seconds')
        expect(page.locator('.handoff-notice')).to_have_count(0)
        page.evaluate("changeLanguage('zh-CN')")
        expect(page.locator('.context-compaction span[data-i18n]')).to_have_text('上下文已压缩')
        expect(page.locator('.context-compaction .context-compaction-duration')).to_have_text('1 分钟 35 秒')
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
        # The live marker interrupts the streaming turn in place instead of
        # riding at the bottom of the transcript while the turn keeps growing.
        assert marker_before_last_turn(page, '.context-compaction[data-state="running"]'), \
            'running marker is not anchored above the streaming turn'
        # The transcript marker owns the compaction progress; the in-turn run
        # row must not repeat the same sentence beside it.
        expect(page.locator('.turn').last.locator('.run-status')).not_to_contain_text('正在原生压缩上下文')
        page.evaluate("deliverEvent({type:'gui:compaction',session_id:'shared-fixture',engine:'codex',runId:91,state:'completed',compactionSeq:9})")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(0)
        expect(page.locator('.context-compaction[data-seq="9"]')).to_have_text('Codex：上下文已原生压缩')
        page.evaluate("deliverEvent({type:'result',session_id:'shared-fixture',engine:'codex',runId:91,subtype:'success',result:'Continued'})")
        assert marker_before_last_turn(page, '.context-compaction[data-seq="9"]'), \
            'completed marker drifted below the finished turn'
        # The source belongs to the event/history, not the page's selected harness
        # or the connection type. Portable and old unknown notices stay generic.
        for seq, (engine, name) in enumerate([('codex', 'Codex'), ('claude', 'Claude'),
                ('kimi', 'Kimi'), ('dsh', 'DSH'), ('antigravity', 'Antigravity'), ('pi', 'Pi')], start=20):
            page.evaluate("""engine => deliverStatus({sessionId:'shared-fixture',text:'Compacting context…',
              compaction:{state:'running',native:true,engine}})""", engine)
            expect(page.locator('.context-compaction[data-state="running"]')).to_have_text(f'{name}：正在原生压缩上下文…')
            page.evaluate("""({engine,seq}) => {
              deliverStatus({sessionId:'shared-fixture',text:'',compaction:{state:'completed',native:true,engine,seq,durationMs:42000}});
              chatFixture.messages.push({role:'notice',engine,seq,text:'Context compacted automatically',compaction:{native:true,durationMs:42000}});
            }""", {'engine': engine, 'seq': seq})
            expect(page.locator(f'.context-compaction[data-seq="{seq}"]')).to_have_text(f'{name}：上下文已原生压缩42 秒')
        page.locator('[data-sid="another-session"]').click()
        page.locator('[data-sid="shared-fixture"]').click()
        expect(page.locator('.context-compaction[data-seq="21"]')).to_have_text('Claude：上下文已原生压缩42 秒')
        expect(page.locator('.context-compaction[data-seq="3"]')).to_have_text('上下文已压缩1 分钟 35 秒')
        page.evaluate("changeLanguage('en')")
        expect(page.locator('.context-compaction[data-seq="22"]')).to_have_text('Kimi: context compacted natively42 seconds')
        page.evaluate("""() => {
          deliverStatus({sessionId:'shared-fixture',text:'Compacting context…',compaction:{state:'running',native:true,engine:'codex'}});
          deliverStatus({sessionId:'shared-fixture',text:'Asking the engine to summarize the conversation…',compaction:{state:'running'}});
        }""")
        expect(page.locator('.context-compaction[data-state="running"]')).to_have_text('Compacting context…')
        page.screenshot(path=str(scope['preview'] / f'compaction-native-{theme}.png'), animations='disabled')
        assert not errors, errors
        page.close()
    browser.close()
print('PASS compaction timeline: running, completed, failure, cancellation, isolation and restoration')
