"""Reference-style completion rows and per-turn usage, without model calls."""
import ast
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
fixture = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
bridge_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
fixture['messages'] = [
    {'role': 'user', 'seq': 1, 'text': '你好', 'at': 1793388600000},
    {'role': 'assistant', 'engine': 'dsh', 'seq': 2, 'at': 1793388601000,
     'text': '你好！有什么可以帮你的吗？\n\n我可以帮你处理这个工作区（`D:\\Code\\Camellia`）里的代码，比如阅读和修改文件、调试运行、查找问题；也可以做文档、表格、PPT、图表之类的任务。直接说需求就行。',
     'usage': {'input_tokens': 11861, 'output_tokens': 140, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0},
     'turnMetrics': {'duration_ms': 1000, 'model': 'deepseek-official/deepseek-flash'}},
]
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('const fixture = ', 'const fixture = window.chatFixture = ')
bridge = bridge.replace('onConversationEvent:()=>{}', 'onConversationEvent:fn=>{window.deliverEvent=fn;}')
output = repo / 'dist/ui-preview/turn-details'
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for theme, width, language in [('light', 1440, 'zh-CN'), ('dark', 960, 'en'),
                                    ('light', 390, 'zh-CN'), ('dark', 320, 'en')]:
        page = browser.new_page(viewport={'width': width, 'height': 950}, color_scheme=theme, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('language => CamelliaI18n.setLanguage(language)', language)
        turn = page.locator('#chat .turn').last
        expect(turn.locator('.turn-completion')).to_contain_text('已完成' if language == 'zh-CN' else 'Completed')
        assert turn.locator('.turn-completion').bounding_box()['y'] < turn.locator('.turn-body').bounding_box()['y']
        footer = turn.locator('.turn-actions')
        expect(footer).to_have_css('opacity', '1')
        expect(footer.locator('time')).to_have_attribute('datetime', '2026-10-30T19:30:01.000Z')
        assert footer.locator('time').inner_text().count(':') == 1
        assert footer.locator('button').first.get_attribute('class') == 'message-copy'
        trigger = footer.locator('.turn-usage-trigger')
        expect(trigger).to_contain_text('12K tok')
        trigger.focus()
        trigger.press('Enter')
        panel = page.locator('.turn-usage-panel:popover-open')
        expect(panel).to_be_visible()
        expect(panel.locator('strong')).to_have_text('12,001 tok')
        expect(panel.locator('dd')).to_have_text(['deepseek-official/deepseek-flash', '0%', '11,861 tok', '0 tok', '0 tok', '140 tok'])
        expect(trigger).to_have_attribute('aria-expanded', 'true')
        box = panel.bounding_box()
        assert box['x'] >= 11 and box['x'] + box['width'] <= width - 11, box
        assert box['y'] >= 11 and box['y'] + box['height'] <= 939, box
        page.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        expect(trigger).to_have_attribute('aria-expanded', 'false')
        expect(trigger).to_be_focused()
        trigger.click()
        expect(panel).to_be_visible()
        page.screenshot(path=str(output / f'usage-{theme}-{width}.png'))
        page.locator('.main-header').click(position={'x': 10, 'y': 10})
        expect(panel).to_have_count(0)
        page.screenshot(path=str(output / f'transcript-{theme}-{width}.png'))

        # A live turn folds its process behind the completion row. Its usage
        # must belong to this turn rather than the preceding history record.
        page.evaluate("""() => {
          window.emit = event => deliverEvent({session_id:'shared-fixture', engine:'codex', runId:91, ...event});
          emit({type:'conversation:started',prompt:'Check the files',userSeq:3});
          emit({type:'stream_event',event:{type:'message_start'}});
          onBlockStart({type:'text',phase:'commentary',text:'Inspecting the files.'}, 0); onBlockStop(0);
          onBlockStart({type:'text',phase:'final_answer',text:'The files are ready.'}, 1); onBlockStop(1);
          emit({type:'result',subtype:'success',result:'The files are ready.',duration_ms:2345,
            turnMetrics:{duration_ms:2345,model:'recorded-model'},
            usage:{input_tokens:1000,cache_read_input_tokens:7500,cache_creation_input_tokens:1500,output_tokens:2000}});
        }""")
        turn = page.locator('#chat .turn').last
        completion = turn.locator('button.completion-label')
        expect(completion).to_have_attribute('aria-expanded', 'false')
        expect(turn.locator('.execution-process')).not_to_have_attribute('open', '')
        completion.focus()
        completion.press('Enter')
        expect(completion).to_have_attribute('aria-expanded', 'true')
        expect(turn.locator('.execution-process .md')).to_have_text('Inspecting the files.')
        expect(turn.locator('.execution-process .md')).to_be_visible()
        completion.press('Space')
        expect(completion).to_have_attribute('aria-expanded', 'false')
        trigger = turn.locator('.turn-usage-trigger')
        trigger.click()
        panel = page.locator('.turn-usage-panel:popover-open')
        expect(panel.locator('strong')).to_have_text('12,000 tok')
        expect(panel.locator('dd')).to_have_text(['recorded-model', '75%', '1,000 tok', '7,500 tok', '1,500 tok', '2,000 tok'])
        # Opening a sibling dismisses the old panel, and scrolling doesn't
        # leave a floating panel disconnected from its message.
        page.keyboard.press('Escape')
        page.locator('.turn-usage-trigger').first.click()
        expect(page.locator('.turn-usage-panel:popover-open')).to_have_count(1)
        page.locator('#chatScroll').evaluate('el => el.dispatchEvent(new Event("scroll"))')
        expect(page.locator('.turn-usage-panel:popover-open')).to_have_count(0)

        # Legacy usage without cache/model facts must omit those rows, not
        # display zeros or borrow a model from the current composer.
        page.evaluate("""() => {
          delete chatFixture.messages[1].turnMetrics;
          chatFixture.messages[1].usage = {input_tokens:100,output_tokens:20};
        }""")
        page.evaluate("openHistorySession('another-session')")
        page.wait_for_function("context.sessionId === 'another-session' && !loadingSession")
        page.evaluate("openHistorySession('shared-fixture')")
        page.wait_for_function("context.sessionId === 'shared-fixture' && !loadingSession")
        page.locator('.turn-usage-trigger').first.click()
        panel = page.locator('.turn-usage-panel:popover-open')
        expect(panel.locator('strong')).to_have_text('120 tok')
        expect(panel.locator('dd')).to_have_text(['100 tok', '20 tok'])
        page.keyboard.press('Escape')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.close()
    browser.close()
    assert not errors, errors
print('PASS: completion process toggle, live/history per-turn usage, exact accounting, unknown cache fields, keyboard/light dismiss, bilingual responsive light/dark layout')
