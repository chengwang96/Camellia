"""Paused long Goal -> ordinary or steered question -> edit/resend. No model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
assignment = next(node for node in ast.walk(source) if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'concurrent_bridge' for target in node.targets))
bridge = ast.literal_eval(assignment.value).replace('seq:s.live.userSeq+1', 'seq:(s.messages.at(-1)?.seq||0)+1')
bridge += r"""
(() => {
  const command = dshDesktop.conversationCommand;
  window.currentGoal = null;
  dshDesktop.conversationCommand = async request => {
    if (request.action === 'goal-get') return {ok:true, goal:currentGoal};
    if (request.action === 'goal-pause') {
      actions.push(request);
      Object.assign(currentGoal, {phase:'paused', armed:false, activeSince:null});
      window.finishPausedGoal = () => {
        const s = sessionFixtures.get(request.payload.sessionId);
        pushEvent({type:'result',subtype:'stopped',session_id:s.id,engine:'codex',runId:s.live.runId,result:'Stopped Goal work'});
      };
      return {ok:true, goal:currentGoal};
    }
    return command(request);
  };
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for theme in ['light', 'dark']:
        for mode in ['follow-up', 'edit-steered']:
            page = browser.new_page(viewport={'width': 1200, 'height': 850}, color_scheme=theme)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(bridge)
            page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
            page.wait_for_function('uiReady')
            page.locator('#input').fill('Continue working toward the goal: finish the complete plan')
            page.locator('#send').click()
            page.wait_for_function('running && !sending')
            page.evaluate('''() => {
              currentGoal = {id:'goal-long',sessionId:context.sessionId,objective:'Finish the complete plan',
                phase:'active',armed:true,elapsedMs:5*60*60*1000,activeSince:Date.now(),roundsStarted:12};
              receiveGoal({sessionId:context.sessionId,goal:currentGoal});
              pushEvent({type:'gui:compaction',session_id:context.sessionId,engine:'codex',runId:currentRunId,state:'completed',compactionSeq:900});
            }''')
            expect(page.locator('#goalChipRow')).to_contain_text('5h')
            if mode == 'edit-steered':
                page.locator('#input').fill('Why is progress so slow?')
                page.locator('#input').press('Enter')
                expect(page.locator('.queue-text')).to_have_text('Why is progress so slow?')
                page.locator('.queue-steer').click()
                page.wait_for_function('!sending')
                expect(page.locator('.msg-user').last).to_contain_text('Why is progress so slow?')
            page.locator('#goalChipRow .goal-chip').first.click()
            page.locator('.dsh-pop .pop-row', has_text='Pause goal').click()
            expect(page.locator('#goalChipRow')).to_contain_text('Goal paused')
            # Pause is asynchronous: editing stays unavailable until the native
            # turn confirms that it has stopped.
            expect(page.locator('.msg-user').last.locator('.message-edit')).to_be_hidden()
            page.evaluate('finishPausedGoal()')
            page.wait_for_function('!running && !sending')
            if mode == 'follow-up':
                page.locator('#input').fill('Why is progress so slow?')
                page.locator('#input').press('Enter')
                page.wait_for_function('running && !sending')
                assert page.evaluate('actions.filter(a=>a.action==="steer").length') == 0
                page.locator('#send').click()
                page.wait_for_function('!running')
            user = page.locator('.msg-user').last
            user.hover()
            user.locator('.message-edit').click()
            page.locator('.message-editor textarea').fill('Explain what remains and why progress is slow')
            page.locator('.message-editor button.primary').click()
            page.wait_for_function('running && !sending')
            expect(page.locator('.message-editor')).to_have_count(0)
            expect(page.locator('.msg-user').last).to_contain_text('Explain what remains')
            expect(page.locator('#goalChipRow')).to_contain_text('Goal paused')
            expect(page.locator('.context-compaction[data-state="running"]')).to_have_count(0)
            assert page.evaluate('actions.filter(a=>a.action==="send" && a.payload.editSeq).length') == 1
            assert page.evaluate('actions.filter(a=>a.action==="goal-resume" || a.action==="goal-start").length') == 0
            assert not errors, errors
            page.screenshot(path=str(preview / f'goal-compaction-{mode}-{theme}.png'), animations='disabled')
            page.evaluate('''() => {
              Object.assign(currentGoal, {phase:'blocked', armed:false, storageError:'Could not save goal state: disk full'});
              receiveGoal({sessionId:context.sessionId, goal:currentGoal, error:currentGoal.storageError});
            }''')
            expect(page.locator('#statusLine')).to_have_text('Could not save goal state: disk full')
            expect(page.locator('#goalChipRow')).to_contain_text('Goal blocked')
            page.locator('#goalChipRow .goal-chip').first.click()
            expect(page.locator('.dsh-pop')).to_contain_text('Could not save goal state: disk full')
            assert not errors, errors
            page.close()
    browser.close()
print('PASS: five-hour Goal pause acknowledgement, follow-up, steering, edit/resend, and storage error visibility; light/dark; no model calls')
