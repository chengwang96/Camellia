'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { spawn } = require('node:child_process');

const GRADER_VERSION = '1.1.0';
const MAX_FAILURES = 12;
function preview(value) {
  const encoded = JSON.stringify(value);
  // Escaping non-ASCII characters makes invisible combining marks inspectable.
  const text = encoded === undefined ? 'undefined' : encoded.replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return text.length > 1200 ? text.slice(0, 1200) + ' ... [truncated]' : text;
}
function readArtifact(cwd, relative) {
  const real = fs.realpathSync(path.join(cwd, relative));
  const rel = path.relative(fs.realpathSync(cwd), real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile() || fs.statSync(real).size > 1024 * 1024) throw new Error('Invalid result file');
  return fs.readFileSync(real, 'utf8');
}

// Only inputs are sent to this child. Expected answers and comparisons stay in
// the parent, and diagnostics are never fed back into a scored agent attempt.
const PROBE_SCRIPT = `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const probe = JSON.parse(input), mod = require(probe.file), fn = probe.export ? mod[probe.export] : mod;
    const outputs = [], errors = [], mutations = [], types = [];
    for (const args of probe.inputs) {
      const before = JSON.stringify(args);
      try {
        const value = await fn(...args);
        outputs.push(value); types.push(typeof value); errors.push(null);
      } catch (error) {
        outputs.push(null); types.push('error'); errors.push(String(error?.message || error).slice(0, 1000));
      }
      mutations.push(Boolean(probe.immutable && JSON.stringify(args) !== before));
    }
    process.stdout.write(JSON.stringify({ outputs, errors, mutations, types }));
  } catch (error) { process.stderr.write(String(error.message)); process.exitCode = 1; }
});`;

function verifyCode(probe, cwd, node, env) {
  readArtifact(cwd, probe.file);
  return new Promise((resolve, reject) => {
    const proc = spawn(node, ['--permission', '--allow-fs-read=' + cwd, '--input-type=commonjs', '-e', PROBE_SCRIPT],
      { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', error = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Result verification timed out')); }, 5000);
    proc.stdout.on('data', data => { out += data; if (out.length > 1000000) { proc.kill('SIGKILL'); reject(new Error('Result output exceeded limit')); } });
    proc.stderr.on('data', data => { error = (error + data).slice(-1000); });
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(error || 'Candidate module failed to execute');
        let data;
        try { data = JSON.parse(out); } catch { throw new Error('Candidate output could not be read by the checker'); }
        if (!['outputs', 'errors', 'mutations', 'types'].every(key => Array.isArray(data?.[key]) && data[key].length === probe.inputs.length)) {
          throw new Error('Candidate output did not contain all check results');
        }
        resolve(data);
      } catch (e) { reject(e); }
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify({ ...probe, file: path.join(cwd, probe.file) }));
  });
}

async function verifyTask(task, cwd, node, env) {
  const probes = task.probe ? [{ probe: task.probe, expected: task.expected }, ...(task.checks || [])] : [];
  const checks = { passed: 0, evaluated: 0, total: (task.preserve?.length || 0) + (task.output ? 1 : 0) + probes.reduce((n, c) => n + c.probe.inputs.length, 0),
    failures: [], omittedFailures: 0 };
  function failure(record) {
    if (checks.failures.length < MAX_FAILURES) checks.failures.push(record); else checks.omittedFailures++;
  }
  for (const file of task.preserve || []) {
    try {
      const actual = readArtifact(cwd, file); checks.evaluated++;
      if (actual === task.files[file]) checks.passed++;
      else failure({ kind: 'input_changed', file, expected: preview(task.files[file]), actual: preview(actual), error: 'An input file that must be preserved was changed' });
    } catch (error) { failure({ kind: 'file', file, error: String(error.message).slice(0, 1000) }); }
  }
  if (task.output) {
    try {
      const text = readArtifact(cwd, task.output); let actual;
      try { actual = JSON.parse(text); } catch {
        checks.evaluated++; failure({ kind: 'invalid_json', file: task.output, expected: preview(task.expected), actual: preview(text), error: 'The output file is not valid JSON' });
      }
      if (actual !== undefined) {
        checks.evaluated++;
        if (isDeepStrictEqual(actual, task.expected)) checks.passed++;
        else failure({ kind: 'output', file: task.output, expected: preview(task.expected), actual: preview(actual) });
      }
    } catch (error) { failure({ kind: 'file', file: task.output, error: String(error.message).slice(0, 1000) }); }
  }
  for (const { probe, expected } of probes) {
    try {
      const result = await verifyCode(probe, cwd, node, env);
      for (const [index, input] of probe.inputs.entries()) {
        checks.evaluated++;
        const actual = result.outputs[index], error = result.errors[index];
        const passed = !error && !result.mutations[index] && isDeepStrictEqual(actual, expected[index]);
        if (passed) checks.passed++;
        else failure({ kind: error ? 'exception' : result.mutations[index] ? 'input_mutated' : 'output', file: probe.file, case: index + 1,
          input: preview(input), expected: preview(expected[index]), actual: error ? undefined : result.types[index] === 'undefined' ? 'undefined' : preview(actual),
          ...(error || result.mutations[index] ? { error: error || 'The function mutated its input' } : {}) });
      }
    } catch (error) { failure({ kind: 'execution', file: probe.file, error: String(error.message).slice(0, 1000) }); }
  }
  const passed = checks.passed === checks.total;
  const unevaluated = checks.total - checks.evaluated;
  const firstError = checks.failures.find(f => f.error)?.error;
  const detail = `${checks.passed}/${checks.total} checks passed${unevaluated ? `; ${unevaluated} could not be evaluated` : ''}${firstError ? '. ' + firstError : ''}`;
  return { passed, detail, graderVersion: GRADER_VERSION, checks };
}

module.exports = { GRADER_VERSION, verifyTask };
