"""Completed history restores saved tools, reasoning and progress without replaying them."""
import ast
import copy
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
tree = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
bridge_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'bridge' for target in node.targets))
progress = '我查一下剩下的待买清单。'
answer = '还剩 **10 项待买**。'
command = 'Get-Content -LiteralPath "shopping.md"\nGet-Date'
output = 'Saved tool output <script>neverRun()</script> & details'
saved = {
    'role': 'assistant', 'engine': 'codex', 'seq': 8, 'at': 1793457247954,
    'text': answer, 'mobileText': answer,
    'outputBlocks': [{'type': 'text', 'phase': 'commentary', 'text': progress},
                     {'type': 'text', 'phase': 'final_answer', 'text': answer}],
    'process': [
        {'type': 'text', 'text': progress},
        {'type': 'tool', 'title': 'commandExecution', 'input': command, 'text': output, 'status': 'completed'},
        {'type': 'thinking', 'text': 'Check the saved shopping list.'},
        {'type': 'tool', 'title': 'verify', 'input': 'shopping.md', 'text': 'Verification failed', 'status': 'failed'},
        {'type': 'tool', 'title': 'read_file', 'input': 'notes.md', 'text': 'Read succeeded', 'status': 'completed'},
    ],
    'turnMetrics': {'duration_ms': 12000, 'model': 'recorded-model'},
}
fixture = {'id': 'shared-fixture', 'title': 'Saved tool history', 'origin': 'codex',
           'currentEngine': 'codex', 'workspaceId': None,
           'messages': [{'role': 'user', 'seq': 1, 'text': '还剩哪些'}, saved]}
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
bridge = bridge.replace('const fixture = ', 'const fixture = window.chatFixture = ')
preview = repo / 'dist/ui-preview/history-process'
preview.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for theme, width, language in [('light', 1440, 'zh-CN'), ('dark', 960, 'en'), ('light', 390, 'zh-CN')]:
        page = browser.new_page(viewport={'width': width, 'height': 1000}, color_scheme=theme)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script(bridge)
        page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex&conversation=shared-fixture', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        page.evaluate('language => CamelliaI18n.setLanguage(language)', language)

        def check_history():
            turn = page.locator('#chat .turn').last
            process = turn.locator('.execution-process')
            toggle = turn.locator('button.completion-label')
            expect(toggle).to_have_attribute('aria-expanded', 'false')
            expect(process.locator('.tool-card')).to_have_count(3)
            expect(process.locator('.md')).to_have_text(progress)
            expect(turn.locator('.turn-body > .md')).to_have_text('还剩 10 项待买。')
            toggle.click()
            expect(toggle).to_have_attribute('aria-expanded', 'true')
            expect(process.locator('.tool-name')).to_have_text(['commandExecution', 'verify', 'read_file'])
            for card in process.locator('.tool-card').all():
                card.locator('.tool-head').click()
                expect(card.locator('.tool-output')).to_be_visible()
            expect(process.locator('.tool-input').first).to_have_text(command)
            expect(process.locator('.tool-summary').first).to_have_text(command.split('\n')[0])
            expect(process.locator('.tool-output').first).to_have_text(output)
            expect(process.locator('.tool-output script')).to_have_count(0)
            expect(process.locator('.tool-state.err')).to_have_count(1)
            process.locator('.think-head').click()
            expect(process.locator('.think-body')).to_be_visible()
            expect(process.locator('.think-body')).to_have_text('Check the saved shopping list.')
            assert turn.evaluate('turn => turnCopyText(turn)') == answer
            toggle.click()
            expect(process.locator('.tool-name').first).to_be_hidden()
            toggle.click()
            expect(process.locator('.tool-output').first).to_be_visible()
            return turn

        turn = check_history()
        turn.screenshot(path=str(preview / f'expanded-{theme}-{width}.png'))
        # Each load builds its own detached tool cards; it must not mutate the
        # current run's pendingTools or borrow cards from another history turn.
        page.evaluate("openHistorySession('another-session')")
        page.wait_for_function("context.sessionId === 'another-session' && !loadingSession")
        page.evaluate("openHistorySession('shared-fixture')")
        page.wait_for_function("context.sessionId === 'shared-fixture' && !loadingSession")
        check_history()
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        check_history()

        # Non-Codex histories may store all prose in text, with mobileText
        # selecting the answer. Do not duplicate progress above the answer.
        legacy = copy.deepcopy(saved)
        del legacy['outputBlocks']
        legacy['text'] = progress + '\n\n' + answer
        page.evaluate('row => renderHistoryMessages([row])', legacy)
        check_history()

        # An interrupted process-only reply has no answer, and unfinished or
        # cancelled tools must not look successful or wait forever for output.
        stopped = {'role': 'assistant', 'engine': 'claude', 'text': 'Still inspecting', 'mobileText': 'Still inspecting\n\nStopped',
                   'process': [{'type': 'text', 'text': 'Still inspecting'},
                               {'type': 'tool', 'title': 'Read', 'input': 'notes.md', 'status': 'in_progress'},
                               {'type': 'tool', 'title': 'Search', 'text': 'Cancelled', 'status': 'cancelled'},
                               {'type': 'plan', 'text': 'pending · Review the evidence'}],
                   'runResult': {'subtype': 'stopped', 'result': 'Stopped'}}
        page.evaluate('row => renderHistoryMessages([row])', stopped)
        turn = page.locator('#chat .turn').last
        expect(turn.locator('.turn-body > .md')).to_have_count(0)
        expect(turn.locator('.tool-state.err')).to_have_count(2)
        expect(turn.locator('.tool-output').first).to_have_text('Stopped before a tool result was received.')
        turn.locator('.execution-process > summary').click()
        expect(turn.locator('.execution-process .md')).to_have_text(['Still inspecting', 'pending · Review the evidence'])

        # Terminal mobileText also contains the result-chip text. Preserve an
        # actual partial answer, but render the error only in its result chip.
        failed = copy.deepcopy(stopped)
        failed['text'] = 'Still inspecting\n\nPartial answer'
        failed['mobileText'] = 'Partial answer\n\nConnection failed'
        failed['runResult'] = {'subtype': 'error', 'is_error': True, 'result': 'Connection failed'}
        page.evaluate('row => renderHistoryMessages([row])', failed)
        turn = page.locator('#chat .turn').last
        expect(turn.locator('.turn-body > .md')).to_have_text('Partial answer')
        expect(turn.locator('.run-result.err')).to_contain_text('Connection failed')

        # Loading an older local page restores its process in the correct turn
        # and leaves plain replies without an empty disclosure control.
        messages = [copy.deepcopy(row) for row in fixture['messages']]
        messages += [{'role': 'assistant', 'engine': 'codex', 'seq': i + 10, 'text': f'Plain reply {i}'} for i in range(100)]
        page.evaluate('messages => { chatFixture.messages = messages; return openHistorySession("shared-fixture"); }', messages)
        expect(page.locator('#chat .execution-process')).to_have_count(0)
        expect(page.locator('#chat .turn')).to_have_count(100)
        page.locator('.history-earlier').click()
        expect(page.locator('#chat .turn')).to_have_count(101)
        older = page.locator('#chat .turn').first
        expect(older.locator('.tool-card')).to_have_count(3)
        older.locator('button.completion-label').click()
        expect(older.locator('.tool-name').first).to_be_visible()
        expect(page.locator('#chat .turn').last.locator('.execution-process')).to_have_count(0)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        page.close()
    browser.close()
print('PASS: saved history tools, inputs/results, chronology, reasoning, no duplicate prose, stopped tools, switch/reload and older paging in responsive light/dark layouts')
