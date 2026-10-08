"""Streaming parse volume, final parity and DOM/control stability. No model calls."""
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
bridge = ast.literal_eval(bridge_node.value.func.value).replace('FIXTURE', json.dumps(fixture))
output = repo / 'dist/ui-preview'
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(bridge)
    page.goto((repo / 'src/renderer/chat/claude.html').as_uri() + '?harness=codex', wait_until='networkidle')
    page.wait_for_function('uiReady')
    metrics = page.evaluate(r'''async () => {
      const render = mdRender;
      const canonical = source => { const t = document.createElement('div'); t.className = 'md'; t.innerHTML = render(source); t.normalize(); return t; };
      const samples = [
        'plain\n\n**bold**\n\nend', '***across\n\nblocks***',
        '**across\n\nblocks**\n\nend', '*across\n\nblocks*',
        '**open **\n\nlater**', '*open *\n\nlater*',
        '`code`\n\n> **quote**\n> next\n\n---\n\n# heading',
        '- [x] done\n- todo\n  - nested\n  continuation\n\nend',
        '3. third\n4. fourth\n\nnext', '    code\n\n    more\n\n\nend',
        '```js\nfirst\n\nsecond\n```\n\nend', '````js\ncode\n````\nend',
        'before\n\n```latex\n\\frac{a}{b}\n```\n\n$$a^2$$\n\nend',
        'before\n\n\\[\na=b\n\n+c\n\\]\n\nend',
        '| a | b |\n| --- | ---: |\n| **one** | `a|b` |\n| two | $a^2$ |\n\nend',
        '| a | b |\n| --- | --- |\n| first | value |\nplain after table',
        '| a | b |\n| --- | --- |\n| ```js\ncode\n``` | value |',
        '[link](https://example.com/guide_(v2))\n\n![file](D:/test.png)',
        'price $5 and $10\n\nend', 'raw <script>bad</script>\n\nend',
        'one\r\n\r\n```js\r\ncode\r\n```\r\nend',
      ];
      for (const source of samples) for (const width of [1, 2, 7, 43]) {
        const el = document.createElement('div'); el.className = 'md'; chat.appendChild(el);
        const stream = CamelliaStreamingMarkdown.create(el, { render, codeBlock: renderCodeBlock });
        for (let at = 0; at < source.length; at += width) {
          stream.append(source.slice(at, at + width)); stream.flush();
          const actual = el.cloneNode(true);
          actual.querySelector(':scope > .cursor')?.remove();
          for (const node of [...actual.childNodes]) if (node.nodeType === Node.COMMENT_NODE) node.remove();
          actual.normalize();
          const prefix = source.slice(0, at + width);
          if (!actual.isEqualNode(canonical(prefix))) throw Error('Intermediate parity failed: ' + JSON.stringify({prefix,width,actual:actual.innerHTML,expected:canonical(prefix).innerHTML}));
        }
        stream.finish(source);
        if (!el.isEqualNode(canonical(source))) throw Error('Final parity failed: ' + JSON.stringify({source, width, html:el.innerHTML}));
        if (stream.tail || stream.element || stream.boundaries) throw Error('Stream state retained after finish');
        el.remove();
      }
      // Selection in the appended literal suffix survives merging into the
      // large parsed text node, including the HTML parser's 64 KiB node split.
      const selected = document.createElement('div'); selected.className='md'; chat.appendChild(selected);
      const longStream = CamelliaStreamingMarkdown.create(selected, {render,codeBlock:renderCodeBlock});
      let longText='a'.repeat(100000); longStream.append(longText); longStream.flush();
      longStream.append('selected tail'); longText+='selected tail'; longStream.flush();
      const selectedNode=longStream.literal;
      const selection=getSelection(), range=document.createRange();
      range.setStart(selectedNode,0); range.setEnd(selectedNode,8);
      const selectedEvent = new Promise(resolve => document.addEventListener('selectionchange',resolve,{once:true}));
      selection.removeAllRanges(); selection.addRange(range); await selectedEvent;
      longStream.append('b'.repeat(13000)); longText+='b'.repeat(13000); longStream.flush();
      if(selection.toString()!=='selected') throw Error('Literal suffix selection lost when parsed');
      longStream.finish(longText);
      if(selection.toString()!=='selected') throw Error('Long text selection lost at completion');
      const clearedEvent = new Promise(resolve => document.addEventListener('selectionchange',resolve,{once:true}));
      selection.removeAllRanges(); await clearedEvent; selected.remove();
      const cases = {
        paragraphs: Array.from({length:250}, (_, i) => `Paragraph ${i}: **ready**. ` + '中文 text '.repeat(16)).join('\n\n'),
        code: '```python\n' + 'print("hello")\n'.repeat(7000) + '```',
        table: '| name | value |\n| --- | ---: |\n' + Array.from({length:1500}, (_, i) => `| row ${i} | **${i}** |\n`).join(''),
        paragraph: 'A long paragraph: ' + '中文 text '.repeat(16000),
        list: Array.from({length:1600}, (_, i) => `- item ${i}: **ready** and more text\n`).join(''),
      };
      const metrics = {};
      for (const [name, source] of Object.entries(cases)) {
        const el = document.createElement('div'); el.className = 'md'; chat.appendChild(el);
        let characters = 0, calls = 0, baselineCharacters = 0, retained = null, parseMs = 0;
        const stream = CamelliaStreamingMarkdown.create(el, {
          render: text => { characters += text.length; calls++; const t = performance.now(); const html = render(text); parseMs += performance.now() - t; return html; }, codeBlock: renderCodeBlock,
        });
        const start = performance.now();
        for (let at = 0; at < source.length; at += 200) {
          stream.append(source.slice(at, at + 200)); stream.flush();
          if (name === 'code' || name === 'table') {
            const node = el.querySelector(name === 'code' ? '.md-code-block' : 'tbody > tr');
            if (!retained) retained = node;
            else if (node !== retained) throw Error('Growing ' + name + ' recreated completed nodes');
          }
          baselineCharacters += Math.min(source.length, at + 200);
        }
        const streamingMs = performance.now() - start;
        const streamedCharacters = characters;
        const stop = performance.now(); stream.finish(source);
        const expected = canonical(source);
        if (!el.isEqualNode(expected)) {
          const difference = (a,b,path='root') => {
            if (!a || !b || a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return {path,a:a?.nodeName,b:b?.nodeName};
            if (a.nodeType===3 && a.data!==b.data) return {path,actualLength:a.length,expectedLength:b.length,actual:a.data.slice(-100),expected:b.data.slice(-100)};
            if(a.nodeType===1 && (a.attributes.length!==b.attributes.length || [...a.attributes].some(attr=>b.getAttribute(attr.name)!==attr.value))) return {path,actual:[...a.attributes].map(attr=>[attr.name,attr.value]),expected:[...b.attributes].map(attr=>[attr.name,attr.value])};
            for(let i=0;i<Math.max(a.childNodes.length,b.childNodes.length);i++) { const d=difference(a.childNodes[i],b.childNodes[i],path+'/'+i); if(d) return d; }
          };
          throw Error('Large final parity failed: ' + name + ' ' + JSON.stringify(difference(el,expected)));
        }
        if (stream.tail || stream.element) throw Error('Large stream retained state');
        metrics[name] = {length:source.length, streamedCharacters, totalCharacters:characters, baselineCharacters,
          reduction: +(1 - streamedCharacters / baselineCharacters).toFixed(5), calls, parseMs:+parseMs.toFixed(1), streamingMs:+streamingMs.toFixed(1), finalMs:+(performance.now()-stop).toFixed(1)};
        if (streamedCharacters >= baselineCharacters / 3) throw Error('Insufficient parse reduction: ' + name);
        el.remove();
      }
      return metrics;
    }''')

    # Real event handlers: completed nodes, selection, focus, previews and scroll.
    page.evaluate(r'''() => {
      window.savedRender = mdRender; window.renderCalls = 0;
      mdRender = (...args) => { renderCalls++; return savedRender(...args); };
      const text = 'Stable paragraph.\n\n```latex\n\\frac{a}{b}\n```\n\n$$x^2$$\n\n';
      onBlockStart({type:'text', text, phase:'final_answer'}, 88); flushBlockRenders();
      window.liveBlock = blocks[88]; window.stableCode = liveBlock.el.querySelector('.md-code-block');
      window.stableMath = liveBlock.el.querySelector(':scope > section .katex');
      window.stableText = liveBlock.el.firstChild;
      while (stableText.nodeType !== Node.TEXT_NODE) stableText = stableText.nextSibling;
    }''')
    code = page.locator('#chat .md-code-block').last
    code.locator('.md-code-latex').click()
    code.locator('.md-code-wrap').click()
    page.evaluate(r'''() => {
      window.previewNode = stableCode.querySelector('.md-latex-body').firstChild;
      stableCode.querySelector('.md-code-latex').focus();
      const range = document.createRange(); range.setStart(stableText, 0); range.setEnd(stableText, 6);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      window.selectedText = getSelection().toString();
      const spacer = document.createElement('div'); spacer.style.height = '2000px'; chat.prepend(spacer);
      chat.scrollTop = 0; followRunOutput = false; window.savedScroll = chat.scrollTop;
      for (let i = 0; i < 20; i++) { onBlockDelta({type:'text_delta', text:`tail ${i} `}, 88); flushBlockRenders(); }
      if (liveBlock.el.querySelector('.md-code-block') !== stableCode) throw Error('Stable code recreated');
      if (liveBlock.el.querySelector(':scope > section .katex') !== stableMath) throw Error('Stable math recreated');
      if (stableCode.querySelector('.md-latex-body').firstChild !== previewNode) throw Error('Stable preview redrawn');
      if (getSelection().toString() !== selectedText) throw Error('Selection lost during streaming');
      if (document.activeElement !== stableCode.querySelector('.md-code-latex')) throw Error('Focus lost during streaming');
      if (chat.scrollTop !== savedScroll) throw Error('Scrolled away from user position');
      onBlockStop(88);
      if (liveBlock.markdown || liveBlock.thinkingStream) throw Error('Temporary state survived stop');
      const raw = liveBlock.raw;
      const stoppedCalls = renderCalls;
      rebuildTurn([{type:'text', text:raw, phase:'final_answer'}]);
      rebuildTurn([{type:'text', text:raw, phase:'final_answer'}]);
      if (renderCalls !== stoppedCalls) throw Error('Canonical text parsed again');
      if (turnEl.querySelector('.md-code-block') !== stableCode || stableCode.querySelector('.md-latex-panel').hidden) throw Error('Preview lost on final reconcile');
      if (stableCode.querySelector('.md-latex-body').firstChild !== previewNode) throw Error('Final preview redrawn');
      if (getSelection().toString() !== selectedText) throw Error('Selection lost at completion');
      if (document.activeElement !== stableCode.querySelector('.md-code-latex')) throw Error('Final focus lost');
      onBlockStart({type:'thinking', thinking:'Native reasoning'}, 89);
      onBlockDelta({type:'thinking_delta', thinking:' finishes immediately'}, 89);
      onBlockStop(89);
      if (blocks[89].el.querySelector('.think-body').textContent !== blocks[89].raw) throw Error('Native thinking not flushed at stop');
      if (blockRenderTimer !== null || blockRenderFrame !== null) throw Error('Stop left a scheduled render');
      const before = renderCalls;
      onBlockStart({type:'text', text:'batch'}, 90);
      for (let i=0; i<100; i++) onBlockDelta({type:'text_delta', text:' token'}, 90);
      if (renderCalls !== before) throw Error('Deltas rendered synchronously');
      window.batchCalls = before;
    }''')
    page.wait_for_function('blocks[90].el.textContent.includes("batch token")')
    page.evaluate('if (renderCalls !== batchCalls + 1) throw Error("Deltas were not coalesced"); onBlockStop(90);')
    page.evaluate(r'''() => {
      const source = '<think>Check `</think>` literally.</think>Answer **ready**.';
      onBlockStart({type:'text', text:''}, 91);
      for (const character of source) { onBlockDelta({type:'text_delta',text:character},91); flushBlockRenders(); }
      onBlockStop(91);
      const block = blocks[91];
      if (block.el.artifactText !== splitThinking(source).body || block.thinkEl.querySelector('.think-body').textContent !== 'Check `</think>` literally.') throw Error('Tagged thinking drifted');
      rebuildTurn([{type:'text',text:source}]);
      if (turnEl.querySelector('.think-body').textContent !== 'Check `</think>` literally.') throw Error('Canonical thinking drifted');
      onBlockStart({type:'text',text:'stale'},92); flushBlockRenders();
      const stale = blocks[92]; stale.el.remove();
      onBlockDelta({type:'text_delta',text:' delta'},92); flushBlockRenders();
      if (stale.markdown || stale.thinkingStream) throw Error('Detached block retained state');
      finalizeStreamBlocks();
    }''')
    page.evaluate(r'''() => {
      chat.querySelector('[style="height: 2000px;"]')?.remove();
      onBlockStart({type:'text',phase:'final_answer',text:'## Streaming Markdown\n\nCompleted paragraphs stay stable while the answer grows.\n\n| Content | Update |\n| --- | --- |\n| Code | Append text |\n| Table | Append rows |\n| Formula | Reuse preview |\n\n```latex\n\\frac{a}{b} = c\n```\n\n$$L = \\sum_i x_i^2$$'},94);
      flushBlockRenders(); onBlockStop(94);
    }''')
    page.locator('#chat .md-code-latex').last.click()
    page.evaluate('chat.scrollTop = chat.scrollHeight')
    page.screenshot(path=str(output / 'streaming-markdown.png'), animations='disabled')
    assert not errors, errors
    (output / 'streaming-markdown-metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    page.close()
    browser.close()
print('Streaming Markdown: final parity, parse volume, node identity, preview, selection, focus, scroll, batching and state release passed.')
