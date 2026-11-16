"""Reply citations follow visible order through streaming, snapshots and reloads."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/chat-source-numbering'
output.mkdir(parents=True, exist_ok=True)

first = 'https://www.xyfsy.com/m/article/2563.html'
fetched = 'https://www.mskcc.org/cancer-care/patient-education/low-fiber-diet'
third = 'https://www.bedfordshirehospitals.nhs.uk/patient-information-leaflets/endo-mucosal-resection-advice-on-discharge/'
again = 'http://xyfsy.com/m/article/2563.html?utm_source=chat#section'
sources = [{'index': i + 1, 'title': f'Unused {i + 1}', 'url': f'https://example.org/unused-{i}'} for i in range(36)]
sources[26] = {'index': 27, 'title': 'Hospital guidance', 'url': first}
sources[32] = {'index': 33, 'title': 'EMR guidance', 'url': third}

part_one = f'[Hospital]({first})\n\n[Fetched-only diet guidance]({fetched})'
part_two = f'| Source | Note |\n| --- | --- |\n| [EMR]({third}) | Third |\n| [Hospital again]({again}) | Same source |'
fixture = {
    'id': 'source-numbering', 'title': 'Citation order', 'origin': 'codex',
    'currentEngine': 'codex', 'workspaceId': None, 'cwd': repo.as_posix(),
    'messages': [
        {'role': 'user', 'text': 'An earlier question'},
        {'role': 'assistant', 'engine': 'codex', 'text': f'[Earlier]({third})'},
        {'role': 'user', 'text': f'Please check [this page]({first}).'},
        {'role': 'assistant', 'engine': 'codex', 'text': part_one + '\n\n' + part_two,
         'sources': sources,
         'process': [
             {'type': 'text', 'text': '[Progress](https://example.org/progress)'},
             {'type': 'tool', 'title': 'camellia_web_search', 'status': 'completed',
              'text': json.dumps({'ok': True, 'results': sources})},
             {'type': 'tool', 'title': 'camellia_web_fetch', 'status': 'completed',
              'text': json.dumps({'ok': True, 'url': fetched, 'title': 'Diet guidance', 'content': 'Low fibre diet.'})},
         ],
         'outputBlocks': [{'phase': 'final_answer', 'text': part_one}, {'phase': 'final_answer', 'text': part_two}]},
    ],
}

bridge = r"""(() => {
  const fixture = FIXTURE;
  const settings = {model:'fixture-model',permissionMode:'default',connection:'api'};
  window.dshDesktop = {
    sharedConversations:true,
    onLanguageChanged:()=>()=>{},
    conversationCommand:async ({action}) => {
      if(action==='list-sessions') return {ok:true,sessions:[{...fixture,mtimeMs:Date.now()}],workspaces:[],pagination:{}};
      if(action==='get-live') return {ok:true,live:null};
      if(action==='load-session') return {ok:true,...fixture,preferences:{mode:'direct',warnOnSwitch:false,showOrigin:false},settings};
      if(action==='get-settings') return settings;
      if(action==='task-list') return {ok:true,tasks:[]};
      return {ok:true};
    },
    workbenchSettings:async()=>({ok:true,conversations:{mode:'direct',warnOnSwitch:false,showOrigin:false}}),
    conversationSwitch:async()=>({ok:true}),apiRouterGetState:async()=>({enabled:true,models:['fixture-model']}),
    onConversationEvent:fn=>{window.deliver=fn;return()=>{};},onConversationGoal:()=>{},onConversationStatus:()=>{},
    onEngineSettingsChanged:()=>{},onApiRouterState:()=>{},onNetworkHealth:()=>{},onHarnessNavigate:()=>{},openSettingsWindow:()=>{},
    previewFile:async()=>({ok:false,error:'fixture'}),openFileExternally:async()=>({ok:true}),
  };
})();"""


def marker_numbers(locator):
    return locator.locator('.md-source-marker').all_text_contents()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    errors = []
    for variant in ['saved-sources', 'legacy-process', 'trimmed-history']:
        saved = json.loads(json.dumps(fixture))
        if variant != 'saved-sources':
            saved['messages'][-1].pop('sources')
        if variant == 'trimmed-history':
            saved['messages'][-1].pop('process')
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda error: errors.append(str(error.stack or error)))
        page.add_init_script(bridge.replace('FIXTURE', json.dumps(saved)))
        page.goto((repo / 'src/renderer/chat/workbench.html').as_uri() + '?harness=codex&conversation=source-numbering', wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        answer = page.locator('.turn').last.locator('.turn-body > .md')
        expect(answer.locator('.md-source-marker')).to_have_count(4)
        assert marker_numbers(answer) == ['1', '2', '3', '1'], variant
        assert marker_numbers(page.locator('.turn').first) == ['1'], variant
        expect(page.locator('.msg-user .md-source-marker')).to_have_count(0)
        expect(answer.locator('a[data-chat-source="2"]')).to_have_attribute('href', fetched)
        expect(answer.locator('.md-source-marker').nth(2)).to_have_attribute('aria-label', 'Source 3')
        if variant != 'trimmed-history':
            assert marker_numbers(page.locator('.turn').last.locator('.execution-process .md')) == ['1']
        page.reload(wait_until='networkidle')
        page.wait_for_function('uiReady && !loadingSession')
        assert marker_numbers(page.locator('.turn').last.locator('.turn-body > .md')) == ['1', '2', '3', '1'], variant
        if variant != 'saved-sources':
            page.close()
            continue

        # A new live run sees many search results and a progress link first.
        page.evaluate("""sources => {
          deliver({type:'conversation:started',session_id:'source-numbering',runId:71,prompt:'New question',userSeq:7});
          deliver({type:'gui:tool',id:'search',name:'camellia_web_search',status:'completed',
            output:JSON.stringify({ok:true,results:sources}),session_id:'source-numbering',runId:71});
          onBlockStart({type:'text',phase:'commentary',text:'[Progress](https://example.org/progress)'},0);
          onBlockStop(0);
          onBlockStart({type:'text',phase:'final_answer',text:'[Hospital]('},1);
          flushBlockRenders();
        }""", sources)
        live = page.locator('.turn').last
        assert marker_numbers(live.locator('.md[data-phase="final_answer"]')) == []
        chunks = [first + ')\n\n', '[Fetched](', fetched + ')\n\n',
                  '| Source | Note |\n| --- | --- |\n',
                  f'| [EMR]({third}) | Third |\n', f'| [Again]({again}) | First |\n']
        expected = [['1'], ['1'], ['1', '2'], ['1', '2'], ['1', '2', '3'], ['1', '2', '3', '1']]
        for chunk, numbers in zip(chunks, expected):
            page.evaluate("text => {onBlockDelta({type:'text_delta',text},1);flushBlockRenders();}", chunk)
            assert marker_numbers(live.locator('.md[data-phase="final_answer"]')) == numbers
        page.evaluate('onBlockStop(1)')

        # A second answer block continues the same numbering, even while live.
        extra = f'[Another](https://example.org/fourth) [Duplicate]({fetched})'
        page.evaluate("text => {onBlockStart({type:'text',phase:'final_answer',text},2);onBlockStop(2);}", extra)
        final_blocks = live.locator('.md[data-phase="final_answer"]')
        assert marker_numbers(final_blocks) == ['1', '2', '3', '1', '4', '2']
        full = '[Hospital](' + ''.join(chunks)
        canonical = [{'type': 'text', 'phase': 'final_answer', 'text': full},
                     {'type': 'text', 'phase': 'final_answer', 'text': extra}]
        page.evaluate("content => {rebuildTurn(content,'canonical');rebuildTurn(content,'canonical');consolidateFinishedTurn();}", canonical)
        assert marker_numbers(live.locator('.turn-body > .md')) == ['1', '2', '3', '1', '4', '2']
        page.screenshot(path=str(output / 'numbered-reply.png'), animations='disabled')

        # A later reply starts at 1 regardless of the earlier sources.
        page.evaluate("""url => {
          deliver({type:'conversation:started',session_id:'source-numbering',runId:72,prompt:'Next question',userSeq:9});
          onBlockStart({type:'text',phase:'final_answer',text:'[New reply]('+url+')'},0);
          onBlockStop(0);
        }""", third)
        assert marker_numbers(page.locator('.turn').last.locator('.md[data-phase="final_answer"]')) == ['1']

        # Engines without phase tags still number only the displayed answer.
        page.evaluate("""url => {
          deliver({type:'conversation:started',session_id:'source-numbering',runId:73,prompt:'Unphased reply',userSeq:11});
          onBlockStart({type:'text',text:'[Earlier progress](https://example.org/progress)'},0);
          onBlockStop(0);
          onBlockStart({type:'text',text:'[Answer]('+url+')'},1);
          onBlockStop(1);
          consolidateFinishedTurn();
        }""", third)
        assert marker_numbers(page.locator('.turn').last.locator('.turn-body > .md')) == ['1']
        page.close()
    browser.close()
    assert not errors, errors
print('PASS: reply-order citations, fetched/direct sources, duplicates, progress isolation, partial links, streaming tables, multiple answer blocks, snapshots, history reloads and reply reset')
