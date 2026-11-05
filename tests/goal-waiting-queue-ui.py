"""Click a queued instruction while a Goal waits, using the real renderer. No model calls."""
import ast
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
preview = repo / 'dist/ui-preview'
preview.mkdir(parents=True, exist_ok=True)
source = ast.parse((repo / 'tests/shared-chat-ui.py').read_text(encoding='utf-8'))
assignment = next(node for node in ast.walk(source) if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'concurrent_bridge' for target in node.targets))
bridge = ast.literal_eval(assignment.value)
bridge += r"""
(() => {
  const command = dshDesktop.conversationCommand;
  const onEvent = dshDesktop.onConversationEvent;
  window.currentGoal = null;
  // The real manager keeps armed Goals busy between replies, including while
  // waiting. A null activity here hides bugs in the renderer's send guards.
  dshDesktop.onConversationEvent = callback => onEvent(event => {
    if (event.type === 'conversation:activity' && !event.activity
        && currentGoal?.sessionId === event.session_id && currentGoal.armed && currentGoal.phase === 'active') {
      event = {...event, activity:'running'};
      sessionFixtures.get(event.session_id).activity = event.activity;
    }
    callback(event);
  });
  dshDesktop.conversationCommand = async request => {
    if (request.action === 'goal-get') return {ok:true, goal:currentGoal?.sessionId === request.payload.sessionId ? currentGoal : null};
    if (request.action === 'send' && request.payload.goalId) {
      if (window.rejectGoalInstruction) {
        actions.push(request);
        return {ok:false, error:'Fixture Goal instruction rejected'};
      }
      const result = await command(request);
      if (result.ok) {
        Object.assign(currentGoal, {waiting:null, waitStreak:0, lastWait:null});
        receiveGoal({sessionId:request.payload.sessionId, goal:currentGoal});
      }
      return result;
    }
    return command(request);
  };
})();
"""


def finish_waiting(page):
    page.evaluate('''() => {
      const s = sessionFixtures.get(context.sessionId);
      pushEvent({type:'result',subtype:'success',session_id:s.id,engine:s.currentEngine,runId:s.live.runId,result:'Experiment still running'});
      Object.assign(currentGoal, {waiting:{reason:'Training still running',until:Date.now()+600000},waitStreak:4});
      receiveGoal({sessionId:s.id,goal:currentGoal});
    }''')
    page.wait_for_function('!running && !sending && conversationActivity === "running"')
    expect(page.locator('#goalChipRow')).to_contain_text('Goal waiting')


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for engine in ['claude', 'codex', 'dsh', 'kimi', 'antigravity', 'grok']:
            for theme in ['light', 'dark']:
                page = browser.new_page(viewport={'width': 1100, 'height': 820}, color_scheme=theme)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.add_init_script(bridge)
                page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + f'?harness={engine}', wait_until='networkidle')
                page.wait_for_function('uiReady')
                page.locator('#input').fill('Run the experiment')
                page.locator('#send').click()
                page.wait_for_function('running && !sending')
                page.evaluate('''() => {
                  currentGoal = {id:'goal-waiting',sessionId:context.sessionId,objective:'Finish the experiment',
                    phase:'active',armed:true,elapsedMs:1000,activeSince:Date.now(),roundsStarted:2};
                  receiveGoal({sessionId:context.sessionId,goal:currentGoal});
                }''')
                page.locator('#input').fill('Keep this entry queued')
                page.locator('#input').press('Enter')
                page.evaluate('attachments=[{name:"output.csv",path:"D:/Fixture/output.csv",isImage:false}];renderAttachments()')
                page.locator('#input').fill('Inspect this output now')
                page.locator('#input').press('Enter')
                expect(page.locator('.queue-text')).to_have_text(['Keep this entry queued', 'Inspect this output now'])
                page.locator('#input').fill('Keep the unsent draft')
                finish_waiting(page)
                arrow = page.locator('.queue-steer').last
                expect(arrow).to_be_enabled()
                if engine == 'codex':
                    page.locator('#inputCard').screenshot(path=str(preview / f'goal-waiting-queue-{theme}.png'))
                    # Rejection must leave the selected entry and its attachments retryable.
                    page.evaluate('window.rejectGoalInstruction=true')
                    arrow.click()
                    page.wait_for_function('!sending && !drainingQueue')
                    expect(page.locator('.queue-text')).to_have_text(['Keep this entry queued', 'Inspect this output now'])
                    expect(page.locator('#input')).to_have_value('Keep the unsent draft')
                    expect(page.locator('#goalChipRow')).to_contain_text('Goal waiting')
                    assert page.evaluate('messageQueue[1].attachments[0].path') == 'D:/Fixture/output.csv'
                    page.evaluate('window.rejectGoalInstruction=false')
                    expect(arrow).to_be_enabled()
                arrow.click()
                page.wait_for_function('running && !sending && !drainingQueue')
                expect(page.locator('.queue-text')).to_have_text('Keep this entry queued')
                expect(page.locator('.msg-user').last).to_contain_text('Inspect this output now')
                expect(page.locator('#input')).to_have_value('Keep the unsent draft')
                expect(page.locator('#goalChipRow')).not_to_contain_text('Goal waiting')
                assert page.evaluate('actions.filter(a=>a.action==="send" && a.payload.goalId).at(-1).payload.goalId') == 'goal-waiting'
                assert page.evaluate('actions.filter(a=>a.action==="send" && a.payload.goalId).at(-1).payload.attachments[0].path') == 'D:/Fixture/output.csv'
                assert page.evaluate('actions.filter(a=>["cancel","steer","goal-start","goal-resume"].includes(a.action)).length') == 0
                assert page.evaluate('currentGoal.id') == 'goal-waiting'
                assert page.evaluate('messageQueue[0].text') == 'Keep this entry queued'
                # Both composer paths must wake the Goal instead of silently
                # queueing, even though the shared activity remains running.
                for mode in ['click', 'enter']:
                    finish_waiting(page)
                    page.evaluate('attachments=[{name:"instruction.txt",path:"D:/Fixture/instruction.txt"}];renderAttachments()')
                    instruction = f'Check the output immediately via {mode}'
                    page.locator('#input').fill(instruction)
                    expect(page.locator('#send')).to_be_enabled()
                    expect(page.locator('#send')).to_have_attribute('title', 'Send')
                    if mode == 'click':
                        page.locator('#send').click()
                    else:
                        page.locator('#input').press('Enter')
                    page.wait_for_function('running && !sending')
                    expect(page.locator('.msg-user').last).to_contain_text(instruction)
                    expect(page.locator('#input')).to_have_value('')
                    expect(page.locator('.queue-text')).to_have_text('Keep this entry queued')
                    expect(page.locator('#goalChipRow')).not_to_contain_text('Goal waiting')
                    request = page.evaluate('actions.filter(a=>a.action==="send").at(-1).payload')
                    assert request['goalId'] == 'goal-waiting'
                    assert request['displayText'] == instruction
                    assert request['attachments'][0]['path'] == 'D:/Fixture/instruction.txt'
                    assert page.evaluate('currentGoal.id') == 'goal-waiting'
                assert page.evaluate('actions.filter(a=>["cancel","steer","goal-start","goal-resume"].includes(a.action)).length') == 0
                assert not errors, (engine, theme, errors)
                page.close()
    finally:
        browser.close()
print('PASS: waiting Goal stays busy; queue arrow, composer click and Enter wake the same Goal; attachments, rejection retry, draft/order preserved; six engines, light/dark; no model calls')
