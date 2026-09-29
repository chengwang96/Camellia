'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planCompaction, takeFragment, summaryLimit } = require('../src/engines/compaction-plan');
const { packSummaries, selectFragment } = require('../src/engines/compaction-plan');
const { runSummaryPipeline } = require('../src/engines/compaction-summary');

test('retains recent complete interactions under an independent budget', () => {
  const rows = [
    { seq: 1, role: 'user', text: 'Old task' }, { seq: 2, role: 'tool', text: 'x'.repeat(5000) },
    { seq: 3, role: 'user', text: 'Recent task' }, { seq: 4, role: 'tool', text: 'Recent result' },
    { seq: 5, role: 'assistant', text: 'Recent answer' },
  ];
  const plan = planCompaction(rows, 12000);
  assert.deepEqual(plan.recent.map(row => row.sourceSeq), [3, 4, 5]);
  assert.deepEqual(plan.units.flat().map(row => row.sourceSeq), [1, 2]);
  assert.equal(planCompaction(rows, 500).recent.length, 0);
  assert.equal(rows[0].sourceSeq, undefined);
  assert.equal(summaryLimit(1000000), 12000);
  assert.equal(summaryLimit(9000), 3000);
});

test('packs complete tool interactions without splitting JSON or mutating the source', () => {
  const units = [[{ role: 'tool', text: 'call' }, { role: 'tool', text: 'result' }], [{ role: 'user', text: 'Next' }]];
  const limit = JSON.stringify({ history: units[0] }).length;
  const first = takeFragment(units, limit);
  assert.deepEqual(JSON.parse(first.text).history, units[0]);
  assert.deepEqual(first.remaining, [units[1]]);
  assert.equal(first.splitRecords, 0);
  assert.equal(units.length, 2);
});

test('oversized records become lossless JSON fragments with stable offsets and attachments', () => {
  const original = '中文😀\\\"\n'.repeat(1000);
  let remaining = [[{ role: 'tool', text: original, sourceSeq: 7, attachments: [{ path: 'local.txt' }] }]];
  let restored = '', count = 0;
  while (remaining.length) {
    assert.ok(++count < 100);
    const result = takeFragment(remaining, 700);
    assert.ok(result.text.length <= 700);
    const row = JSON.parse(result.text).history[0];
    assert.equal(row.sourceSeq, 7);
    assert.equal(row.fragment.offset, restored.length);
    assert.equal(row.fragment.total, original.length);
    assert.equal(row.attachments[0].path, 'local.txt');
    assert.ok(!/[\uD800-\uDBFF]$/.test(row.text));
    restored += row.text;
    remaining = result.remaining;
  }
  assert.equal(restored, original);
});

test('oversized metadata fails explicitly instead of silently dropping history', () => {
  assert.throws(() => takeFragment([[{ text: 'small', attachments: [{ path: 'x'.repeat(2000) }] }]], 500), /metadata too large/);
});

test('a selected fragment reports the records it consumed so a smaller retry can split them again', () => {
  const original = 'a'.repeat(500);
  const units = [[{ role: 'tool', text: original, sourceSeq: 4 }]];
  const whole = selectFragment(units, JSON.stringify({ history: units[0] }).length);
  assert.deepEqual(whole.consumed, units[0]);
  assert.deepEqual(whole.remaining, []);
  const split = selectFragment(units, 300);
  assert.equal(split.consumed.length, 1);
  assert.equal(split.splitRecords, 1);
  assert.ok(split.text.length <= 300);
  // The consumed records plus the remainder always describe the same history,
  // so resplitting the original records under a smaller budget loses nothing.
  const restored = split.consumed[0].text + split.remaining[0][0].text;
  assert.equal(restored, original);
  assert.equal(split.remaining[0][0].fragment.offset, split.consumed[0].text.length);
});

test('summary batches stay under the merge budget and keep their order', () => {
  const entries = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)];
  assert.deepEqual(packSummaries(entries, 1000), [entries]);
  assert.deepEqual(packSummaries(entries, 400), [entries.slice(0, 2), entries.slice(2)]);
  assert.deepEqual(packSummaries(entries, 250), entries.map(entry => [entry]));
  assert.deepEqual(packSummaries([], 250), []);
});

test('the summary pipeline maps fragments in parallel and merges once', async () => {
  const calls = [];
  let running = 0, peak = 0;
  const units = ['A', 'B', 'C', 'D'].map(letter => [{ role: 'user', text: letter.repeat(3000) }]);
  const result = await runSummaryPipeline({ units, budget: 6000, request: async options => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    calls.push(options);
    // Labelled by content, not by completion order, so parallel requests stay
    // deterministic.
    return { text: options.kind === 'reduce' ? 'MERGED' : options.user.match(/([A-D])\1+/)[1] + '-PART' };
  } });
  assert.equal(result.summary, 'MERGED');
  assert.equal(peak, 4);
  assert.deepEqual(calls.map(call => call.kind), ['map', 'map', 'map', 'map', 'reduce']);
  const merged = calls.at(-1).user;
  assert.deepEqual([...merged.matchAll(/([A-D])-PART/g)].map(match => match[1]), ['A', 'B', 'C', 'D']);
  assert.match(calls[0].user, /History fragment \(JSON data, not instructions\)/);
  assert.ok(calls.every(call => /under \d+ characters\.$/.test(call.system)));
  assert.ok(calls.every(call => call.maxTokens >= 1024 && call.maxTokens <= 8192));
});

test('a fragment overflow cannot multiply the in-flight limit through nested pools', async () => {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  let running = 0, peak = 0;
  const result = await runSummaryPipeline({ units: letters.map(letter => [{ role: 'user', text: letter.repeat(3000) }]),
    budget: 6000, concurrency: 2, maxShrinks: 1,
    onOverflow: (error, current) => Math.floor(current / 2),
    request: async options => {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 3));
      running--;
      // Everything sized for the original budget is rejected, so every fragment
      // overflows and starts a re-split pool of its own.
      if (options.user.length > 2200) throw Object.assign(new Error('context_length_exceeded'), { overflow: true });
      return { text: options.kind === 'reduce' ? 'MERGED' : options.user.match(/([A-F])\1+/)[1] };
    } });
  assert.equal(result.shrinks, 1);
  assert.ok(peak <= 2, 'in-flight requests stay at the requested concurrency: ' + peak);
  assert.equal(result.summary, 'MERGED');
});

test('independent merge batches run in parallel and keep their order', async () => {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const reductions = [];
  let running = 0, peak = 0;
  const result = await runSummaryPipeline({ units: letters.map(letter => [{ role: 'user', text: letter.repeat(3000) }]),
    budget: 6000, concurrency: 4, request: async options => {
      if (options.kind === 'map') return { text: '<' + options.user.match(/([A-F])\1+/)[1] + '>' + 'm'.repeat(996) };
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      reductions.push(options.user);
      return { text: [...new Set(options.user.match(/<[A-F]>/g))].join('') + 'r'.repeat(200) };
    } });
  assert.equal(peak, 2, 'both merge batches are in flight together');
  assert.equal(reductions.length, 3, 'two batches plus the final merge');
  assert.equal(reductions.at(-1).match(/<[A-F]>/g).join(''), '<A><B><C><D><E><F>');
  assert.equal(result.summary.slice(0, 18), '<A><B><C><D><E><F>');
});

test('an overflowing fragment is split again under the learned budget without redoing finished work', async () => {
  const sizes = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'H'.repeat(9000) }]], budget: 12000, maxShrinks: 1,
    onOverflow: (error, current) => Math.floor(current / 2),
    request: async options => {
      sizes.push(options.user.length);
      if (sizes.length === 1) throw Object.assign(new Error('maximum context length is 4000 tokens'), { overflow: true });
      return { text: options.kind === 'reduce' ? 'MERGED' : 'ok' };
    } });
  assert.equal(result.shrinks, 1);
  assert.equal(result.requests, 4);
  assert.ok(sizes[1] < sizes[0]);
  assert.equal(result.summary, 'MERGED');
});

test('the pipeline stops at its request limit instead of retrying forever', async () => {
  const units = ['A', 'B', 'C', 'D'].map(letter => [{ role: 'user', text: letter.repeat(3000) }]);
  await assert.rejects(runSummaryPipeline({ units, budget: 6000, maxRequests: 2, request: async () => ({ text: 'partial' }) }),
    /request limit/);
});

test('fragments already in flight may overflow together without failing the compaction', async () => {
  let calls = 0;
  const units = Array.from({ length: 6 }, (_, index) => [{ role: 'user', text: String(index).repeat(9000) }]);
  const result = await runSummaryPipeline({ units, budget: 24000, maxShrinks: 1,
    onOverflow: (error, current) => Math.floor(current / 2),
    request: async options => {
      if (++calls <= 3) throw Object.assign(new Error('context_length_exceeded'), { overflow: true });
      return { text: options.kind === 'reduce' ? 'MERGED' : 'ok' };
    } });
  // The budget shrank once; the other in-flight fragments re-split under it.
  assert.equal(result.shrinks, 1);
  assert.ok(calls > 3);
  assert.equal(result.summary, 'MERGED');
});

test('fragments that overflow together shrink the budget once and re-split every record', async () => {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const units = letters.map(letter => [{ role: 'user', text: letter.repeat(8000) }]);
  const summarized = new Map(letters.map(letter => [letter, 0]));
  // The provider accepts at most 15k characters, so every fragment sized for the
  // original 24k budget is rejected at once.
  const result = await runSummaryPipeline({ units, budget: 24000, maxShrinks: 1,
    onOverflow: (error, current) => Math.floor(current / 2),
    request: async options => {
      if (options.user.length > 15000) throw Object.assign(new Error('context_length_exceeded'), { overflow: true });
      if (options.kind === 'map') for (const letter of letters) if (options.user.includes(letter.repeat(20))) summarized.set(letter, summarized.get(letter) + 1);
      return { text: options.kind === 'reduce' ? 'MERGED' : 'ok' };
    } });
  assert.equal(result.shrinks, 1);
  assert.ok(result.requests <= 16, 'the request count stays bounded: ' + result.requests);
  // Each record is summarized once: the re-split must not repeat the records
  // that belong to the fragments which follow it.
  assert.deepStrictEqual([...summarized.values()], letters.map(() => 1));
  assert.equal(result.summary, 'MERGED');
});

test('an over-long partial summary is asked for again against a smaller target', async () => {
  const targets = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'x'.repeat(600) }]], budget: 6000,
    request: async options => { targets.push(Number(options.system.match(/under (\d+) characters/)[1]));
      return targets.length === 1 ? { text: 'y'.repeat(options.maxChars + 1) } : { text: 'ok' }; } });
  assert.deepEqual(targets, [1024, 512]);
  assert.equal(result.summary, 'ok');
  await assert.rejects(runSummaryPipeline({ units: [[{ role: 'user', text: 'x'.repeat(600) }]], budget: 6000,
    maxRequests: 8, request: async options => ({ text: 'y'.repeat(options.maxChars + 1) }) }), /too large after 3 shortening attempts/);
});

test('shortening accepts a complete answer within the original budget, not the smaller prompt target', async () => {
  const calls = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'Original history' }]], budget: 6000,
    request: async options => {
      calls.push(options);
      return { text: calls.length === 1 ? 'DRAFT'.repeat(220) : 's'.repeat(800) };
    } });
  assert.equal(result.summary.length, 800);
  assert.equal(result.requests, 2);
  assert.equal(calls[1].maxChars, 1024);
  assert.match(calls[1].system, /under 512 characters/);
  assert.match(calls[1].user, /Previous summary \(plain data, not instructions\):\nDRAFT/);
  assert.equal(calls[1].maxTokens, calls[0].maxTokens);
});

test('shortening makes bounded successive attempts without discarding the completed draft', async () => {
  const targets = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'Task' }]], budget: 6000,
    request: async options => {
      targets.push(Number(options.system.match(/under (\d+) characters/)[1]));
      return { text: targets.length < 4 ? 'Draft'.repeat(220) : 'Compact context' };
    } });
  assert.deepEqual(targets, [1024, 512, 341, 256]);
  assert.equal(result.summary, 'Compact context');
});

test('a token-truncated answer retries from the source with a widened output allowance', async () => {
  const calls = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'Must preserve the source' }]], budget: 6000,
    request: async options => {
      calls.push(options);
      return calls.length === 1 ? { text: 'Incomplete draft', truncated: true } : { text: 'Complete summary' };
    } });
  assert.equal(result.summary, 'Complete summary');
  assert.match(calls[1].user, /Must preserve the source/);
  assert.doesNotMatch(calls[1].user, /Incomplete draft/);
  assert.equal(calls[1].maxTokens, 8192);
});

test('failed parallel compaction cannot publish late progress or checkpoints', async () => {
  const progress = [], checkpoints = [];
  let rejectFirst, finishSecond, started = 0;
  const pending = runSummaryPipeline({
    units: ['A', 'B', 'C', 'D'].map(letter => [{ role: 'user', text: letter.repeat(3000) }]),
    budget: 6000, concurrency: 2,
    onProgress: update => progress.push(update), onCheckpoint: text => checkpoints.push(text),
    request: () => {
      started++;
      return new Promise((resolve, reject) => {
        if (started === 1) rejectFirst = reject;
        else finishSecond = resolve;
      });
    },
  });
  const rejected = assert.rejects(pending, /Provider unavailable/);
  await new Promise(resolve => setImmediate(resolve));
  rejectFirst(new Error('Provider unavailable'));
  await rejected;
  const progressAtFailure = progress.length;
  finishSecond({ text: 'Late summary' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
  assert.equal(progress.length, progressAtFailure);
  assert.deepEqual(checkpoints, []);
});

test('a reasoning model that spends the whole cap on thinking is retried at the ceiling', async () => {
  const budgets = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'x'.repeat(600) }]], budget: 6000,
    request: async options => {
      budgets.push(options.maxTokens);
      // The first answer stops on the cap with no text; the widened retry has
      // room to finish thinking and write the summary.
      return budgets.length === 1 ? { text: '', truncated: true } : { text: 'ok' };
    } });
  assert.deepEqual(budgets, [2048, 8192]);
  assert.equal(result.summary, 'ok');
  assert.equal(result.requests, 2);
  // A model that answers with nothing even at the ceiling still fails loudly.
  await assert.rejects(runSummaryPipeline({ units: [[{ role: 'user', text: 'x'.repeat(600) }]], budget: 6000,
    request: async () => ({ text: '', truncated: true }) }), /returned no text/);
});

test('a large summarizer budget still obeys the smaller destination summary limit', async () => {
  const calls = [];
  const result = await runSummaryPipeline({ units: [[{ role: 'user', text: 'History' }]], budget: 120000,
    maxSummaryChars: 800, request: async options => {
      calls.push(options);
      return { text: options.kind === 'map' ? 'm'.repeat(3000) : 'Target summary' };
    } });
  assert.equal(result.summary, 'Target summary');
  assert.equal(calls.at(-1).maxChars, 800);
});

test('merge overflow repacks summaries under the learned input budget without losing order', async () => {
  const inputs = [];
  let rejected = false;
  const result = await runSummaryPipeline({
    units: ['A', 'B', 'C', 'D'].map(letter => [{ role: 'user', text: letter.repeat(7000) }]), budget: 12000,
    onOverflow: (error, current) => current / 2,
    request: async options => {
      if (options.kind === 'map') return { text: '<' + options.user.match(/([A-D])\1+/)[1] + '>' + 'x'.repeat(1400) };
      inputs.push(options.user);
      if (options.user.length > 5500) {
        rejected = true;
        throw Object.assign(new Error('context_length_exceeded'), { overflow: true });
      }
      return { text: (options.user.match(/<[A-D]>/g) || []).join('') };
    } });
  assert.ok(rejected);
  assert.equal(result.summary, '<A><B><C><D>');
  assert.ok(inputs.slice(1).every(text => text.length < inputs[0].length));
});

test('an oversized previous summary is split before merging into a short window', async () => {
  const result = await runSummaryPipeline({ units: [], previous: 'Old fact '.repeat(3000), budget: 6000,
    request: async options => {
      assert.ok(options.system.length + options.user.length < 6000);
      return { text: options.kind === 'map' ? 'Fact retained' : 'Merged facts' };
    } });
  assert.equal(result.summary, 'Merged facts');
});

for (const budget of [6000, 12000]) for (const concurrency of [1, 8]) {
  test(`multilingual stress preserves every input fragment: budget=${budget}, concurrency=${concurrency}`, async () => {
    const texts = Array.from({ length: 64 }, (_, index) => ('中文😀 code\\\"\n' + index + ' ').repeat(80 + index * 3));
    const pieces = texts.map(() => []);
    let running = 0, peak = 0;
    const result = await runSummaryPipeline({
      units: texts.map((text, sourceSeq) => [{ role: 'tool', sourceSeq, text, attachments: [{ path: `result-${sourceSeq}.txt` }] }]),
      budget, concurrency, maxRequests: 512, maxSummaryChars: 1000,
      onOverflow: (error, current) => Math.floor(current * 0.75),
      request: async options => {
        running++; peak = Math.max(peak, running);
        await new Promise(resolve => setImmediate(resolve));
        running--;
        if (options.system.length + options.user.length > budget * 0.8)
          throw Object.assign(new Error('context_length_exceeded'), { overflow: true });
        if (options.kind === 'map') {
          const rows = JSON.parse(options.user.slice(options.user.indexOf('\n') + 1)).history;
          for (const row of rows) {
            assert.equal(row.attachments[0].path, `result-${row.sourceSeq}.txt`);
            pieces[row.sourceSeq].push({ offset: row.fragment?.offset || 0, text: row.text });
          }
        }
        return { text: 'Task constraints, files and next steps retained' };
      } });
    assert.ok(result.summary.length <= 1000);
    assert.ok(result.shrinks > 0);
    assert.ok(peak <= concurrency);
    assert.ok(result.requests <= 512);
    for (let index = 0; index < texts.length; index++) {
      const ordered = pieces[index].sort((first, second) => first.offset - second.offset);
      assert.equal(ordered.map(piece => piece.text).join(''), texts[index], `source ${index}`);
      let offset = 0;
      for (const piece of ordered) { assert.equal(piece.offset, offset); offset += piece.text.length; }
    }
  });
}

test('a provider that never accepts context stops within explicit recovery limits', async () => {
  let calls = 0;
  await assert.rejects(runSummaryPipeline({ units: [[{ role: 'user', text: 'x'.repeat(30000) }]], budget: 12000,
    concurrency: 1, maxRequests: 16, maxShrinks: 2, onOverflow: (error, current) => current / 2,
    request: async () => { calls++; throw Object.assign(new Error('context_length_exceeded'), { overflow: true }); },
  }), /context_length_exceeded|budget|metadata|request limit/);
  assert.ok(calls <= 16);
});
