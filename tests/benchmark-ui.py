"""Benchmark controls, report rendering, navigation and visual checks; no API calls."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
screenshots = repo / 'dist/ui-preview'
screenshots.mkdir(parents=True, exist_ok=True)
suites = json.loads(subprocess.check_output(['node', '-e',
    "console.log(JSON.stringify(require('./src/benchmark/tasks').publicSuites()))"], cwd=repo, text=True, encoding='utf-8'))
external_tasks = [{'id': f'ds1000:{i}', 'name': f'DS-1000 #{i}', 'category': 'Numpy'} for i in range(1000)]
suites += [{'id': f'ds1000-{kind}', 'library': 'ds1000', 'name': name, 'count': count,
            'taskIds': [t['id'] for t in external_tasks[:count]], 'tasks': external_tasks[:count]}
           for kind, name, count in [('quick', 'Quick sample', 3), ('standard', 'Standard sample', 6), ('full', 'Full test split', 1000)]]
suites += [{'id':'scicode-quick','library':'scicode','name':'Quick sample','count':3,'taskIds':[],'tasks':[]}]
engine_names = [('claude', 'Claude Code'), ('codex', 'Codex CLI'), ('dsh', 'DeepSeek Harness'), ('kimi', 'Kimi Code'), ('antigravity', 'Antigravity SDK')]
legacy_tasks = [{'id': 'slug', 'name': 'Repair text normalization', 'category': 'Bug fix'}, *suites[0]['tasks'][1:]]
state = {'ok': True, 'busy': False, 'routerReady': False, 'models': [], 'history': [], 'active': None, 'latest': None,
         'libraries': [{'id':'builtin','name':'Camellia built-in','ready':True,'defaultTimeoutSeconds':300,'defaultTokensPerTask':250000},
                       {'id':'ds1000','name':'DS-1000','ready':False,'defaultTimeoutSeconds':600,'defaultTokensPerTask':500000,'description':'Python data-science questions','downloadSize':'Python and scientific packages'},
                       {'id':'scicode','name':'SciCode','ready':False,'defaultTimeoutSeconds':1800,'defaultTokensPerTask':1000000,'description':'Scientific research problems','downloadSize':'1.05 GB of numerical test data'}],
         'suites': suites, 'engines': [{'id': id, 'name': name, 'ready': False, 'version': 'test'} for id, name in engine_names]}
trials = [{'id': n * len(engine_names) + i + 1, 'engine': id, 'task': task, 'repeat': 1, 'status': 'failed' if id == 'kimi' and n == 0 else 'passed',
           'checkScore': 91.7 if id == 'kimi' and n == 0 else 100,
           'durationMs': 12000, 'detail': '<img src=x onerror=alert(1)> literal diagnostic',
           'usage': {'input': 1000, 'output': 100}, 'changes': [{'path': 'example.cjs', 'after': 'module.exports = 42;'}]}
          for n, task in enumerate(t['id'] for t in legacy_tasks) for i, (id, name) in enumerate(engine_names)]
trials[3]['verification'] = {'passed': False, 'graderVersion': '1.1.0', 'checks': {'passed': 11, 'total': 12, 'evaluated': 12,
    'failures': [{'kind': 'output', 'file': 'slug.cjs', 'case': 11, 'input': '["a\\u1ab0b"]', 'expected': '"ab"', 'actual': '"a-b"'}]}}
trials[3]['text'] = 'All my 11 checks passed.'
report = {'id': '12345678-1234-1234-1234-123456789abc', 'model': 'demo-model', 'provider': 'Simulated results', 'suite': 'quick',
          'version': 'camellia-bench-1', 'tasks': legacy_tasks, 'suiteName': 'Quick check',
          'repeats': 1, 'startedAt': '2026-09-15T08:00:00Z', 'status': 'completed', 'trials': trials, 'timeoutSeconds':300, 'tokenBudget':20000000,
          'engines': [{'id': id, 'name': name, 'version': 'test', 'score': 66.7 if id == 'kimi' else 100,
                       'checkScore': 97.2 if id == 'kimi' else 100,
                       'passed': 2 if id == 'kimi' else 3, 'completed': 3, 'expected': 3, 'durationMs': 36000, 'tokens': 3300}
                      for id, name in engine_names]}
bridge = """(() => {
  const listeners = {}; window.calls = [];
  window.emitState = state => { window.fixture = state; listeners.onBenchmarkState?.(structuredClone(state)); };
  window.dshDesktop = new Proxy({}, {get: (_, method) => method.startsWith('on')
    ? fn => { listeners[method] = fn; return () => {}; }
    : async payload => {
      window.calls.push({method, payload});
      if (method === 'benchmarkState') return structuredClone(window.fixture);
      if (method === 'benchmarkReport') return {ok:true, report:structuredClone(window.savedReport)};
      if (method === 'benchmarkInstall') {
        window.fixture.engines.find(e => e.id === payload).ready = true; return structuredClone(window.fixture);
      }
      if (method === 'benchmarkPrepareLibrary') {
        if (window.prepareError) return {ok:false,error:window.prepareError};
        window.fixture.libraries.find(l => l.id === payload).ready = true; return structuredClone(window.fixture);
      }
      if (method === 'benchmarkStart') {
        if (window.startError) return {ok:false,error:window.startError};
        const report = structuredClone(window.savedReport); report.status = 'running';
        report.mode = payload.mode; report.maxDurationSeconds = payload.mode === 'preview' ? 300 : null;
        report.timeAllocation = payload.mode === 'preview' ? {mode:'shared-preview',version:1,reserveSeconds:30} : undefined;
        report.startedAt = new Date().toISOString(); report.finishedAt = null;
        report.timeoutSeconds = payload.timeoutSeconds; report.tokenBudget = payload.tokenBudget;
        report.maxTokensPerTask = payload.maxTokensPerTask;
        const suite = fixture.suites.find(s => s.id === payload.suite);
        report.suite = suite.id; report.suiteName = suite.name; report.tasks = suite.tasks;
        report.version = 'camellia-bench-2';
        report.trials = suite.tasks.flatMap((t,n)=>fixture.engines.map((e,i)=>({id:n*5+i+1,task:t.id,engine:e.id,repeat:1,status:'pending'})));
        if (suite.library && suite.library !== 'builtin') {
          report.id = '23456789-1234-1234-1234-123456789abc'; report.suite = suite.id; report.suiteName = suite.name;
          report.library = {id:suite.library,name:fixture.libraries.find(l=>l.id===suite.library).name}; report.tasks = suite.tasks;
        }
        report.execution = {mode:'parallel-engines',maxConcurrentTrials:5,perEngineConcurrency:1};
        report.trials.forEach((t,i) => {t.status = i < 5 ? 'running' : 'pending'; t.checkScore = null; delete t.verification;});
        report.engines.forEach(e => Object.assign(e, {score:null,checkScore:null,passed:0,completed:0,tokens:0,durationMs:0}));
        window.fixture.active = report; window.fixture.busy = true; return {ok:true,id:report.id};
      }
      if (method === 'benchmarkCancel') {
        window.fixture.active.trials.forEach(t => {if (t.status === 'running') t.status = 'cancelled';});
        window.fixture.active.status = 'cancelled'; window.fixture.busy = false; return {ok:true};
      }
      return {ok:true};
    }});
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    page = browser.new_page(viewport={'width': 1280, 'height': 1000}, color_scheme='light')
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('window.fixture = ' + json.dumps(state) + ';window.savedReport = ' + json.dumps(report) + ';' + bridge)
    page.goto((repo / 'src/renderer/benchmark/benchmark.html').as_uri())
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading', name='One model. Five engines.')).to_be_visible()
    expect(page.locator('.score')).to_have_count(5)
    expect(page.locator('.score-label')).to_have_text(['Check score'] * 5)
    expect(page.get_by_text('Some check counts were not saved')).to_have_count(0)
    expect(page.locator('#start')).to_be_disabled()
    expect(page.locator('[data-install]')).to_have_count(5)
    for id, name in engine_names:
        page.locator(f'[data-install="{id}"]').click()
        expect(page.locator(f'[data-install="{id}"]')).to_have_count(0)
    expect(page.locator('#start')).to_be_disabled()
    page.evaluate("fixture.models=[{id:'demo-model',providerId:'fixture',provider:'Local UI fixture'}];fixture.routerReady=true;emitState(fixture)")
    expect(page.locator('#start')).to_be_enabled()
    expect(page.locator('#library option')).to_have_text(['Camellia built-in', 'DS-1000', 'SciCode'])
    expect(page.locator('input[value="preview"]')).to_be_checked()
    expect(page.locator('#timeout')).to_have_value('270')
    expect(page.locator('#timeoutLabel')).to_have_text('Time shared by each engine’s tasks')
    expect(page.locator('#timeout')).to_be_disabled()
    expect(page.locator('#library')).to_be_disabled()
    expect(page.locator('#modeGuide')).to_contain_text('4.5 minutes shared')
    expect(page.locator('#modeGuide')).not_to_be_visible()
    expect(page.locator('#budgetAdvice')).not_to_be_visible()
    expect(page.locator('#limitHint')).not_to_be_visible()
    expect(page.locator('#libraryDescription')).to_have_text('File editing, data processing and multi-file fixes.')
    expect(page.locator('#matrix tbody tr').first).to_contain_text('Fix basic text formatting')
    page.screenshot(path=str(screenshots / 'benchmark-five-minute-setup.png'), full_page=True)
    page.locator('input[value="full"]').check()
    expect(page.locator('#timeoutLabel')).to_have_text('Time per task')
    page.locator('#library').select_option('ds1000')
    expect(page.locator('#suite')).to_have_value('ds1000-full')
    expect(page.locator('#suite')).to_be_disabled()
    expect(page.locator('#runHint')).to_contain_text('5000 attempts')
    expect(page.locator('#modeGuide')).to_contain_text('200.0 hours per engine')
    page.locator('#library').select_option('builtin')
    expect(page.locator('#suite')).to_have_value('standard')
    page.locator('input[value="custom"]').check()
    expect(page.locator('#timeout')).to_have_value('auto')
    expect(page.locator('#budget')).to_have_value('')
    expect(page.locator('#tokensPerTask')).to_have_value('auto')
    expect(page.locator('#limitHint')).to_have_text('5 minutes per task · 250K tokens per task attempt')
    page.locator('#library').select_option('scicode')
    expect(page.locator('#limitHint')).to_contain_text('30 minutes per task')
    expect(page.locator('#limitHint')).to_contain_text('1M tokens per task attempt')
    expect(page.locator('#timeout option[value="auto"]')).to_have_text('Recommended · 30 minutes')
    expect(page.locator('#libraryStatus')).to_contain_text('1.05 GB')
    expect(page.locator('#libraryCaveat')).to_contain_text('Short samples omit #15')
    expect(page.locator('#start')).to_be_disabled()
    page.locator('#library').select_option('ds1000')
    expect(page.locator('#limitHint')).to_contain_text('10 minutes per task')
    page.locator('.limits summary').click()
    page.locator('#budget').select_option('20000000')
    page.locator('#tokensPerTask').select_option('2000000')
    page.locator('#timeout').select_option('3600')
    page.locator('#library').select_option('scicode')
    expect(page.locator('#timeout')).to_have_value('3600')
    expect(page.locator('#budget')).to_have_value('20000000')
    page.locator('#repeats').select_option('3')
    expect(page.locator('#budget')).to_have_value('20000000')
    expect(page.locator('#tokensPerTask')).to_have_value('2000000')
    expect(page.locator('#budgetAdvice')).to_contain_text('Whole-run cap: 20M')
    page.locator('#budget').select_option('')
    expect(page.locator('#budgetAdvice')).to_contain_text('Whole-run cap: off')
    page.locator('#tokensPerTask').select_option('auto')
    expect(page.locator('#limitHint')).to_contain_text('1M tokens per task attempt')
    page.locator('#repeats').select_option('1')
    expect(page.locator('#limitHint')).to_contain_text('60 minutes per task')
    page.locator('#timeout').select_option('auto')
    expect(page.locator('#limitHint')).to_contain_text('30 minutes per task')
    page.locator('#library').select_option('ds1000')
    page.locator('.limits summary').click()
    expect(page.locator('#suite')).to_have_value('ds1000-quick')
    expect(page.locator('#start')).to_be_disabled()
    page.evaluate("prepareError='Download failed; retry is available'")
    page.locator('#prepareLibrary').click()
    expect(page.locator('#notice')).to_contain_text('Download failed')
    expect(page.locator('#prepareLibrary')).to_be_enabled()
    page.evaluate('prepareError=null')
    page.locator('#prepareLibrary').click()
    expect(page.locator('#start')).to_be_enabled()
    expect(page.locator('#prepareLibrary')).not_to_be_visible()
    page.locator('#suite').select_option('ds1000-full')
    expect(page.locator('#runHint')).to_contain_text('5000 attempts')
    expect(page.locator('#limitHint')).to_contain_text('500K tokens per task attempt')
    expect(page.locator('#budgetAdvice')).to_contain_text('5000 task budgets: up to 2.5B reported tokens')
    expect(page.locator('#matrix tbody tr')).to_have_count(25)
    expect(page.locator('#taskPage')).to_have_text('1–25 of 1000 tasks')
    page.locator('#nextTasks').click()
    expect(page.locator('#matrix tbody tr').first).to_contain_text('DS-1000 #25')
    expect(page.locator('#taskPage')).to_have_text('26–50 of 1000 tasks')
    page.screenshot(path=str(screenshots / 'benchmark-library-select.png'), full_page=True)
    page.locator('#library').select_option('builtin')
    page.locator('#suite').select_option('standard')
    page.locator('#repeats').select_option('3')
    expect(page.locator('#runHint')).to_contain_text('105 attempts')
    expect(page.locator('#limitHint')).to_contain_text('250K tokens per task attempt')
    expect(page.locator('#runHint')).to_contain_text('uses your API quota')
    page.locator('#suite').select_option('quick')
    page.locator('#repeats').select_option('1')
    page.screenshot(path=str(screenshots / 'benchmark-ready.png'), full_page=True)
    page.locator('#start').click()
    expect(page.locator('#cancel')).to_be_visible()
    expect(page.locator('#model')).to_be_disabled()
    expect(page.locator('#runStatus')).to_have_text('Running')
    expect(page.locator('#runConfiguration')).not_to_be_visible()
    page.locator('#runDetails summary').click()
    expect(page.locator('#runConfiguration')).to_be_visible()
    expect(page.locator('#runConfiguration')).to_contain_text('5 engines in parallel')
    expect(page.locator('#runConfiguration')).to_contain_text('5 minutes per task · 250K tokens per task attempt')
    page.locator('#runDetails summary').click()
    expect(page.locator('#runMeta')).to_contain_text('Built-in v2')
    expect(page.locator('#timeout')).to_have_value('300')
    expect(page.locator('#budget')).to_have_value('')
    expect(page.locator('#tokensPerTask')).to_have_value('250000')
    expect(page.locator('#progressText')).to_have_text('0 / 15 attempts finished · 5 running')
    expect(page.locator('.cell.running')).to_have_count(5)
    page.screenshot(path=str(screenshots / 'benchmark-parallel-running.png'), full_page=True)
    assert page.evaluate("calls.find(c=>c.method==='benchmarkStart').payload") == {
        'model': 'demo-model', 'providerId': 'fixture', 'mode': 'custom', 'library': 'builtin', 'suite': 'quick', 'repeats': 1, 'timeoutSeconds': 300, 'maxTokensPerTask':250000, 'tokenBudget': None}
    page.evaluate("fixture.active.engines[0].completed=1;fixture.active.engines[0].observedCheckScore=91.7;fixture.active.engines[0].observedPassRate=0;fixture.active.engines[0].coverage=33.3;emitState(fixture)")
    expect(page.locator('.score-label').first).to_have_text('Preliminary check score')
    expect(page.locator('.score-number').first).to_have_text('91.7 / 100')
    expect(page.locator('.score').first).to_contain_text('1/3 evaluated')
    expect(page.locator('#runLimitNote')).to_have_text('Scores cover completed attempts only.')
    page.evaluate("Object.assign(fixture.active.engines[0],{completed:0,observedCheckScore:null,observedPassRate:null,coverage:0});emitState(fixture)")
    page.locator('#cancel').click()
    expect(page.locator('#start')).to_be_enabled()
    expect(page.locator('#runStatus')).to_have_text('Stopped')
    expect(page.locator('#timeout')).to_have_value('auto')
    expect(page.locator('#budget')).to_have_value('')
    expect(page.locator('#tokensPerTask')).to_have_value('auto')
    expect(page.locator('.cell.running')).to_have_count(0)
    assert all('—' in text for text in page.locator('.score-number').all_text_contents())
    page.evaluate("fixture.active=savedReport;fixture.history=[savedReport];emitState(fixture)")
    expect(page.locator('#runStatus')).to_have_text('Completed')
    expect(page.locator('#runConfiguration')).to_contain_text('Sequential run')
    expect(page.locator('#runMeta')).to_contain_text('Built-in v1')
    expect(page.locator('#matrix tbody tr').first).to_contain_text('Repair text normalization')
    expect(page.locator('.score-number').nth(3)).to_have_text('97.2 / 100')
    expect(page.locator('.strict-score').nth(3)).to_have_text('Full-task pass rate: 66.7%')
    expect(page.locator('.cell.partial')).to_have_count(1)
    expect(page.locator('.cell.partial .case-score')).to_have_text('91.7 / 100')
    expect(page.locator('.cell.passed .case-score')).to_have_count(0)
    page.get_by_role('button', name='Kimi Code · Repair text normalization · attempt 1 · Partial', exact=True).click()
    expect(page.locator('#detailSummary')).to_contain_text('Check score: 91.7 / 100')
    expect(page.locator('#detailVerdict')).to_contain_text('<img src=x onerror=alert(1)>')
    expect(page.locator('#detailVerdict img')).to_have_count(0)
    expect(page.locator('#checkSummary')).to_have_text('Independent checks: 11/12 passed')
    expect(page.locator('.case-failure h4')).to_contain_text('case 11')
    expect(page.locator('.case-values')).to_contain_text('["a\\u1ab0b"]')
    expect(page.locator('.case-values')).to_contain_text('"a-b"')
    expect(page.locator('#detailAdvice')).to_contain_text('Passed checks earn partial credit')
    expect(page.locator('#detailText')).not_to_be_visible()
    page.locator('#engineOutput summary').click()
    expect(page.locator('#detailText')).to_have_text('All my 11 checks passed.')
    page.locator('#engineOutput summary').click()
    page.locator('#trialDetail').screenshot(path=str(screenshots / 'benchmark-failure-detail.png'))
    page.locator('#changedFiles summary').click()
    expect(page.locator('#detailChanges')).to_contain_text('module.exports = 42;')
    page.locator('#closeDetail').click()
    page.locator('#export').click()
    assert page.evaluate("calls.some(c=>c.method==='benchmarkExport'&&c.payload===savedReport.id)")
    page.locator('#history').select_option('')
    page.locator('#history').select_option(report['id'])
    expect(page.locator('#runMeta')).to_contain_text('Simulated results')
    page.locator('#settings').click()
    page.locator('#home').click()
    assert page.evaluate("calls.some(c=>c.method==='openSettingsWindow'&&c.payload.page==='providers')")
    assert page.evaluate("calls.some(c=>c.method==='switchMode'&&c.payload==='home')")
    for scheme in ['light', 'dark']:
        page.emulate_media(color_scheme=scheme)
        page.screenshot(path=str(screenshots / f'benchmark-{scheme}.png'), full_page=True)
    page.set_viewport_size({'width': 760, 'height': 900})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(screenshots / 'benchmark-narrow.png'), full_page=True)
    assert page.evaluate("[...document.images].every(img=>img.complete&&img.naturalWidth>0)")
    page.get_by_role('button', name='Kimi Code · Repair text normalization · attempt 1 · Partial', exact=True).click()
    page.locator('#changedFiles summary').click()
    page.locator('#trialDetail').screenshot(path=str(screenshots / 'benchmark-failure-dark-narrow.png'))
    page.evaluate("delete fixture.active.trials[3].verification;fixture.active.trials[3].checkScore=null;fixture.active.engines[3].checkScore=null;emitState(fixture)")
    expect(page.locator('.score-number').nth(3)).to_have_text('— / 100')
    expect(page.get_by_text('Some check counts were not saved')).to_be_visible()
    expect(page.locator('#detailAdvice')).to_contain_text('older report')
    expect(page.locator('.case-failure')).to_have_count(0)
    page.evaluate("fixture.active.trials[3].status='error';fixture.active.trials[3].apiError='401: fixture key rejected';emitState(fixture)")
    expect(page.locator('#detailAdvice')).to_contain_text('Check model access')
    page.evaluate("fixture.active.trials[3].status='timeout';emitState(fixture)")
    expect(page.locator('#detailAdvice')).to_contain_text('same limit for all engines')
    expect(page.locator('#runLimitNote')).to_contain_text('1 timed out. Open a result for details.')
    page.evaluate("fixture.active.status='budget_exceeded';emitState(fixture)")
    expect(page.locator('#runLimitNote')).to_contain_text('Whole-run token cap reached (20M tokens).')
    expect(page.locator('#runConfiguration')).to_contain_text('5 minutes per task · 20M whole-run token cap')
    page.evaluate("fixture.active.trials[3].status='grader_error';fixture.active.trials[3].checkScore=null;fixture.active.engines[3].invalid=1;fixture.active.engines[3].score=null;fixture.active.engines[3].checkScore=null;emitState(fixture)")
    expect(page.locator('.cell.grader_error')).to_contain_text('Grader error')
    expect(page.locator('.cell.grader_error .case-score')).to_have_count(0)
    expect(page.locator('#detailAdvice')).to_contain_text('no valid score')
    expect(page.get_by_text('Grader error · score unavailable')).to_be_visible()
    page.evaluate("startError='The selected API has no available key'")
    page.locator('#start').click()
    expect(page.locator('#notice')).to_have_text('The selected API has no available key')
    expect(page.locator('#start')).to_be_enabled()
    page.evaluate('startError=null')
    page.locator('#library').select_option('ds1000')
    page.locator('#suite').select_option('ds1000-standard')
    page.locator('#start').click()
    expect(page.locator('#runMeta')).to_contain_text('DS-1000 · Standard sample')
    expect(page.locator('#library')).to_be_disabled()
    expect(page.locator('#matrix tbody tr')).to_have_count(6)
    assert page.evaluate("calls.filter(c=>c.method==='benchmarkStart').at(-1).payload.suite") == 'ds1000-standard'
    assert page.evaluate("calls.filter(c=>c.method==='benchmarkStart').at(-1).payload.timeoutSeconds") == 600
    assert page.evaluate("calls.filter(c=>c.method==='benchmarkStart').at(-1).payload.tokenBudget") is None
    assert page.evaluate("calls.filter(c=>c.method==='benchmarkStart').at(-1).payload.maxTokensPerTask") == 500000
    page.locator('#cancel').click()
    # The report describes its original tasks even if its dataset is now absent.
    page.evaluate("fixture.suites=fixture.suites.filter(s=>s.library!=='ds1000');emitState(fixture)")
    expect(page.locator('#matrix tbody tr')).to_have_count(6)
    expect(page.locator('#runMeta')).to_contain_text('DS-1000 · Standard sample')
    page.evaluate("""const warning={code:'seeded-monte-carlo-trajectory',message:'Equivalent sampling rules can fail steps 46.3 and 46.4.'};
      fixture.active.library={id:'scicode',name:'SciCode'};
      fixture.active.tasks=[{id:'scicode:46',name:'helium atom vmc',category:'SciCode #46',warnings:[warning]}];
      fixture.active.comparisonNotes=[{kind:'test_limitation',message:warning.message},{kind:'shared_failures',message:'At least 3 engines failed the same checks.'}];
      fixture.active.trials=fixture.engines.map((e,i)=>({id:100+i,engine:e.id,task:'scicode:46',repeat:1,status:'failed',checkScore:50,
        verification:{checks:{passed:7,total:14,evaluated:14,failures:[{case:'46.3 / 1',kind:'assertion',file:'solution.py',error:'Numerical comparison did not match',location:'official_scicode_test.py:3',log:'<img src=x onerror=alert(1)> literal log'}]}}}));
      emitState(fixture);""")
    expect(page.locator('#comparisonNotes')).to_contain_text('Equivalent sampling rules')
    expect(page.locator('.task-caveat')).to_have_text('Test limitation · see details')
    page.get_by_role('button', name='Claude Code · helium atom vmc · attempt 1 · Partial', exact=True).click()
    expect(page.locator('#taskCaveat')).to_contain_text('46.3 and 46.4')
    expect(page.locator('.case-failure h4')).to_contain_text('Check mismatch')
    expect(page.locator('.case-failure')).to_contain_text('official_scicode_test.py:3')
    page.get_by_text('Captured test output', exact=True).click()
    expect(page.locator('.case-failure pre')).to_contain_text('<img src=x')
    expect(page.locator('.case-failure img')).to_have_count(0)
    page.screenshot(path=str(screenshots / 'benchmark-known-test-limitation.png'), full_page=True)
    page.evaluate("""const trial=fixture.active.trials.find(t=>t.engine==='dsh');
      Object.assign(trial,{status:'error',failureKind:'output_limit',checkScore:0,error:'Single-response output limit reached (32,768 tokens).'});
      delete trial.verification; emitState(fixture);""")
    page.get_by_role('button', name='DeepSeek Harness · helium atom vmc · attempt 1 · Output limit', exact=True).click()
    expect(page.locator('#detailSummary')).to_contain_text('Output limit')
    expect(page.locator('#detailVerdict')).to_contain_text('32,768')
    expect(page.locator('#detailAdvice')).to_contain_text('separate from the per-task')
    page.locator('#closeDetail').click()
    page.locator('input[value="preview"]').check()
    page.locator('#start').click()
    assert page.evaluate("calls.filter(c=>c.method==='benchmarkStart').at(-1).payload") == {
        'model': 'demo-model', 'providerId': 'fixture', 'mode': 'preview', 'library': 'builtin', 'suite': 'quick',
        'repeats': 1, 'timeoutSeconds': 270, 'maxTokensPerTask': 250000, 'tokenBudget': None}
    expect(page.locator('#runClock')).to_contain_text('remaining in the whole-run budget')
    expect(page.locator('#runConfiguration')).to_contain_text('5-minute preview')
    expect(page.locator('#runConfiguration')).to_contain_text('shared across each engine')
    expect(page.locator('input[value="full"]')).to_be_disabled()
    page.evaluate("""fixture.active.status='time_limit_reached';fixture.active.finishedAt=new Date().toISOString();fixture.busy=false;
      fixture.active.trials.forEach((t,i)=>{t.status=i<5?'timeout':'skipped';t.failureKind=i<5?'run_time_limit':null;t.checkScore=i<5?0:null;});
      fixture.active.engines.forEach(e=>Object.assign(e,{completed:1,expected:3,score:null,checkScore:null,observedCheckScore:0,observedPassRate:0,coverage:33.3}));
      emitState(fixture);""")
    expect(page.locator('#runStatus')).to_have_text('Preview time budget reached')
    expect(page.locator('#progressText')).to_have_text('5 / 15 attempts finished')
    expect(page.locator('.cell.skipped')).to_have_count(10)
    expect(page.locator('#runLimitNote')).to_contain_text('unstarted tasks have no score')
    expect(page.locator('.score-number')).to_have_text(['0 / 100'] * 5)
    expect(page.locator('.score-label')).to_have_text(['Preliminary check score'] * 5)
    expect(page.locator('#start')).to_be_enabled()
    page.evaluate("""const t=fixture.active.trials[1];t.timeoutSeconds=184;
      t.timeoutContext={activity:'Waiting for model response',requestsInFlight:1};
      t.toolFailureCount=2;t.toolFailures=[{atMs:5000,tool:'commandExecution',input:'apply_patch $patch',output:'Invalid patch: <img src=x onerror=alert(1)> literal error'}];
      t.timeline=[{atMs:4000,type:'activity',detail:'Completed tool: fileChange'},{atMs:184000,type:'timeout',detail:'Waiting for model response; 1 API request(s) in flight'}];emitState(fixture);""")
    page.get_by_role('button', name='Codex CLI · Fix basic text formatting · attempt 1 · Timeout', exact=True).click()
    expect(page.locator('#detailSummary')).to_contain_text('Time allowance: 184 seconds')
    expect(page.locator('#timeoutContext')).to_contain_text('Waiting for model response')
    expect(page.locator('#timeoutContext')).to_contain_text('2 tool calls failed')
    page.get_by_text('Tool errors (2)', exact=True).click()
    expect(page.locator('#caseFailures pre')).to_contain_text('Invalid patch: <img src=x onerror=alert(1)> literal error')
    expect(page.locator('#caseFailures img')).to_have_count(0)
    page.locator('#trialTimeline summary').click()
    expect(page.locator('#timelineText')).to_contain_text('4.0s · Completed tool: fileChange')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(screenshots / 'benchmark-preview-deadline-narrow.png'), full_page=True)
    # Localizing the report must leave model identifiers and engine evidence intact.
    model_value = page.locator('#model').input_value()
    raw_output = page.locator('#detailText').text_content()
    page.evaluate("CamelliaI18n.setLanguage('zh-CN')")
    expect(page.locator('h1')).to_have_text('同一模型，五个引擎。')
    expect(page.locator('#runStatus')).to_have_text('预览时间已用尽')
    expect(page.locator('.score-label')).to_have_text(['暂定检查得分'] * 5)
    assert page.locator('#model').input_value() == model_value
    assert page.locator('#detailText').text_content() == raw_output
    page.set_viewport_size({'width':1200,'height':900})
    page.evaluate('window.scrollTo(0,0)')
    page.screenshot(path=str(screenshots / 'benchmark-zh-CN.png'), full_page=True)
    page.evaluate("CamelliaI18n.setLanguage('en')")
    expect(page.locator('h1')).to_have_text('One model. Five engines.')
    expect(page.locator('#runStatus')).to_have_text('Preview time budget reached')
    assert not errors, errors
    browser.close()
print('PASS: benchmark setup, install, start/stop, scoring, evidence, history/export, navigation, themes and narrow layout')
