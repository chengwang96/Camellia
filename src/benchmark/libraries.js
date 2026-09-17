'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { writeJson, readJson } = require('../shared/json-store');
const { createDownloadConnection } = require('../main/download-network');
const { run } = require('../main/runtime-manager');
const { taskWarnings } = require('./diagnostics');

const ADAPTER_VERSION = 'python-libraries-1';
const PYTHON_VERSION = '3.10.21';
const DS_REV = 'b39aab71da6d23ef8d3cac59a7c5f834516ab334';
const SCI_REV = '4510f6a6aa27c43fad7b43da2c59602a86e88480';
const SCI_CODE_REV = 'e3158ea011d4235245a547460d3688d7ccbf9900';
const SPECS = {
  ds1000: { id: 'ds1000', name: 'DS-1000', count: 1000, split: 'test', revision: DS_REV,
    source: 'https://github.com/xlang-ai/DS-1000', license: 'CC-BY-SA-4.0',
    description: '1,000 Python data-science problems across seven libraries. Official execution and code-constraint checks.',
    downloadSize: 'Python and scientific packages · several GB of disk space',
    files: [{ name: 'ds1000.jsonl.gz', url: `https://raw.githubusercontent.com/xlang-ai/DS-1000/${DS_REV}/data/ds1000.jsonl.gz`,
      size: 418089, sha256: 'e8c6daa9d7223976bce0296644f3933f78d7f47830669ff05cd61da62c6ba9b3' }],
    imports: ['numpy', 'pandas', 'scipy', 'matplotlib', 'sklearn', 'gensim', 'seaborn', 'statsmodels', 'xgboost', 'yaml', 'torch', 'tensorflow'] },
  scicode: { id: 'scicode', name: 'SciCode', count: 65, split: 'test', revision: SCI_REV, codeRevision: SCI_CODE_REV,
    source: 'https://github.com/scicode-bench/SciCode', license: 'Apache-2.0',
    description: '65 research problems from the test split. Scientific background and subproblem instructions are included; official numerical tests grade your solution.',
    downloadSize: '1.05 GB of numerical test data, plus Python and scientific packages',
    files: [{ name: 'problems_test.jsonl', url: `https://huggingface.co/datasets/SciCode1/SciCode/resolve/${SCI_REV}/problems_test.jsonl`,
      size: 933500, sha256: '38797fef78f434720be6d053b4f3a86839d6f8ea5fb9115450677cd3a6edf81d' },
    { name: 'test_data.h5', url: 'https://drive.usercontent.google.com/download?id=17G_k65N_6yFFZ2O-jQH00Lh6iaw3z-AW&export=download&confirm=t',
      size: 1049345865, sha256: '48b0272a88b17dbd29777c217e1b4fb2b019b92e11cc2add847409db9541b890' }],
    imports: ['numpy', 'scipy', 'matplotlib', 'sympy', 'h5py'] },
};
const EXTERNAL_SUITES = Object.values(SPECS).flatMap(library => [
  { id: `${library.id}-quick`, name: 'Quick sample', count: 3 },
  { id: `${library.id}-standard`, name: 'Standard sample', count: 6 },
  { id: `${library.id}-extended`, name: 'Extended sample', count: 12 },
  { id: `${library.id}-full`, name: 'Full test split', count: library.count },
].map(suite => ({ ...suite, library: library.id, description: `${suite.count} problems from ${library.name}` })));
const digest = data => createHash('sha256').update(data).digest('hex');
const publicTask = task => ({ id: task.id, name: task.name, category: task.category, sourceId: task.sourceId,
  ...(taskWarnings(task.id).length ? { warnings: taskWarnings(task.id) } : {}) });

function makeTasks(library, records) {
  return records.map(record => {
    if (library === 'ds1000') {
      const id = String(record.metadata.problem_id);
      return { id: `ds1000:${id}`, library, sourceId: id, name: `DS-1000 #${id}`, category: record.metadata.library,
        instruction: 'Solve the original DS-1000 problem below. Write ONLY the Python solution fragment to solution.py, without Markdown fences. The evaluator inserts this fragment into the context shown in the question; do not hardcode the example inputs or include the surrounding question. You can use scratch files to try the public example.\n\n' + record.prompt,
        files: { 'solution.py': '# Write the solution fragment here.\n' }, record,
        checkCount: Math.max(1, record.metadata.test_case_cnt) + (/def test_string\s*\(/.test(record.code_context) ? 1 : 0) };
    }
    const id = String(record.problem_id);
    const steps = record.sub_steps.filter(step => step.test_cases.length);
    const helpers = record.sub_steps.filter(step => !step.test_cases.length).map(step => {
      const name = step.step_number;
      if (!['13.6', '62.1', '76.3'].includes(name)) throw new Error('Unrecognized SciCode provided step');
      return fs.readFileSync(path.join(__dirname, 'python', 'provided', name + '.txt'), 'utf8');
    }).join('\n\n');
    return { id: `scicode:${id}`, library, sourceId: id, name: record.problem_name.replace(/_/g, ' '), category: `SciCode #${id} · ${steps.length} subproblems`,
      instruction: 'Implement this SciCode research problem in solution.py. Include every requested function/class so the subproblems and final solution work together. Keep the provided helper definitions. Use the specified interfaces and return values. You may write scratch tests using the public description.\n\n' +
        [record.problem_description_main, record.problem_io, record.problem_background_main,
          ...steps.map(step => `## Subproblem ${step.step_number}\n${step.step_description_prompt}\n${step.step_background || ''}\n\n${step.function_header}\n${step.return_line || ''}`)].filter(Boolean).join('\n\n'),
      files: { 'solution.py': record.required_dependencies + '\n\n' + helpers + '\n\n# Implement the requested functions here.\n' }, record,
      checkCount: steps.reduce((sum, step) => sum + step.test_cases.length, 0) };
  });
}
function selectTasks(tasks, count) {
  // Stable, nested samples independent of model answers. DS-1000 rotates through
  // its seven libraries before taking a second problem from any one library.
  const groups = new Map();
  for (const task of tasks) {
    const group = task.library === 'ds1000' ? task.category : 'science';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(task);
  }
  const queues = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, rows]) =>
    rows.sort((a, b) => Number(Boolean(taskWarnings(a.id).length)) - Number(Boolean(taskWarnings(b.id).length))
      || digest('camellia-sample-1:' + a.id).localeCompare(digest('camellia-sample-1:' + b.id))));
  const selected = [];
  for (let i = 0; selected.length < Math.min(count, tasks.length); i++) for (const rows of queues) {
    if (rows[i] && selected.length < count) selected.push(rows[i]);
  }
  return selected;
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
async function download(file, target, connection, report = () => {}) {
  if (fs.existsSync(target) && fs.statSync(target).size === file.size && await fileDigest(target) === file.sha256) return;
  const temporary = target + '.download';
  try {
    const response = await connection.fetch(file.url, { signal: AbortSignal.timeout(1800000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Download failed (HTTP ${response.status}): ${file.name}`); }
    const hash = createHash('sha256'); let bytes = 0, last = 0;
    const meter = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length; hash.update(chunk);
      if (bytes > file.size) return done(new Error(`Unexpected download size: ${file.name}`));
      if (Date.now() - last > 1000) { report(`Downloading ${file.name}: ${Math.floor(bytes / file.size * 100)}%`); last = Date.now(); }
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary));
    if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Download checksum mismatch: ${file.name}`);
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function createLibraryManager({ directory, downloadOptions = () => undefined, onChange = () => {}, runCommand = run,
  connect = createDownloadConnection, platform = process.platform, arch = process.arch }) {
  const cache = new Map(), suiteCache = new Map(), progress = new Map(); let pending = null;
  const root = path.resolve(directory);
  const envPython = dir => path.join(dir, 'env', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const fingerprint = id => digest(JSON.stringify(SPECS[id]) + ADAPTER_VERSION + PYTHON_VERSION +
    fs.readFileSync(path.join(__dirname, 'requirements', id + '.lock')));
  function locate(id) {
    if (!SPECS[id]) return null;
    const dir = path.join(root, id), python = envPython(dir);
    try {
      const installed = readJson(path.join(dir, 'installed.json'));
      if (installed?.fingerprint !== fingerprint(id) || installed.platform !== platform + '-' + arch || !fs.existsSync(python)) return null;
      if (!SPECS[id].files.every(file => fs.statSync(path.join(dir, file.name)).size === file.size)) return null;
      return { python, directory: dir, fingerprint: installed.fingerprint, pythonVersion: PYTHON_VERSION };
    } catch { return null; }
  }
  function tasks(id) {
    if (cache.has(id)) return cache.get(id);
    const runtime = locate(id);
    if (!runtime) return [];
    const bytes = fs.readFileSync(path.join(runtime.directory, SPECS[id].files[0].name));
    const text = id === 'ds1000' ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    const rows = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (rows.length !== SPECS[id].count) throw new Error('The installed question count is incorrect');
    const value = makeTasks(id, rows); cache.set(id, value); return value;
  }
  function state() {
    return Object.values(SPECS).map(({ id, name, count, split, source, description, downloadSize, license }) =>
      ({ id, name, count, split, source, description, downloadSize, license, ready: Boolean(locate(id)), ...progress.get(id) }));
  }
  function suites() {
    return EXTERNAL_SUITES.map(suite => {
      if (suiteCache.has(suite.id) && locate(suite.library)) return suiteCache.get(suite.id);
      const selected = selectTasks(tasks(suite.library), suite.count);
      const value = { ...suite, taskIds: selected.map(t => t.id), tasks: selected.map(publicTask) };
      if (selected.length) suiteCache.set(suite.id, value);
      return value;
    });
  }
  function resolve(suiteId) {
    const suite = EXTERNAL_SUITES.find(s => s.id === suiteId);
    if (!suite) return null;
    if (pending) throw new Error('Wait for question library preparation to finish');
    const runtime = locate(suite.library);
    if (!runtime) throw new Error(`Prepare ${SPECS[suite.library].name} before starting the run`);
    const selected = selectTasks(tasks(suite.library), suite.count), spec = SPECS[suite.library];
    return { suite: { ...suite, taskIds: selected.map(t => t.id) }, tasks: selected, runtime,
      suiteHash: digest(JSON.stringify({ fingerprint: runtime.fingerprint, ids: selected.map(t => t.sourceId) })),
      library: { id: spec.id, name: spec.name, source: spec.source, license: spec.license, revision: spec.revision, codeRevision: spec.codeRevision,
        split: spec.split, available: spec.count, sample: spec.id === 'scicode' ? 'camellia-sample-2-known-issues-last' : 'camellia-sample-1', adapterVersion: ADAPTER_VERSION,
        pythonVersion: PYTHON_VERSION, environmentHash: runtime.fingerprint, background: spec.id === 'scicode',
        dataHashes: Object.fromEntries(spec.files.map(file => [file.name, file.sha256])) } };
  }
  function ensure(id) {
    if (!SPECS[id]) return Promise.reject(new Error('Unknown question library'));
    if (pending) return pending.id === id ? pending.promise : Promise.reject(new Error('Another question library is being prepared'));
    if (locate(id)) return Promise.resolve(locate(id));
    const report = message => { progress.set(id, { status: 'installing', message }); onChange(); };
    const promise = Promise.resolve().then(async () => {
      const options = await downloadOptions();
      const connection = connect(options);
      const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
      try {
        report(`Preparing ${SPECS[id].name}…`);
        const uvConfig = require('./python/runtime.json').platforms[platform + '-' + arch];
        if (!uvConfig) throw new Error('Scientific question libraries support Windows x64 and macOS ARM64');
        const installer = path.join(root, 'installer'); fs.mkdirSync(installer, { recursive: true });
        const uv = path.join(installer, uvConfig.uv);
        if (!fs.existsSync(uv)) {
          const response = await connection.fetch(uvConfig.url, { signal: AbortSignal.timeout(180000) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Python installer download failed (HTTP ${response.status})`); }
          const data = Buffer.from(await response.arrayBuffer());
          if (digest(data) !== uvConfig.sha256) throw new Error('Python installer checksum mismatch');
          const archive = path.join(installer, uvConfig.archive); fs.writeFileSync(archive, data);
          await runCommand('tar', ['-xf', archive, '-C', installer]);
          if (platform !== 'win32') fs.chmodSync(uv, 0o755);
        }
        const env = { ...connection.env, UV_NO_CONFIG: '1', UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(installer, 'cache') };
        for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX']) delete env[key];
        report('Installing Python ' + PYTHON_VERSION + '…');
        await runCommand(uv, ['python', 'install', PYTHON_VERSION, '--install-dir', env.UV_PYTHON_INSTALL_DIR, '--no-bin'], { env, cwd: dir });
        const python = path.join(root, 'python', platform === 'win32' ? `cpython-${PYTHON_VERSION}-windows-x86_64-none/python.exe` : `cpython-${PYTHON_VERSION}-macos-aarch64-none/bin/python3.10`);
        await runCommand(uv, ['venv', path.join(dir, 'env'), '--python', python, '--allow-existing'], { env, cwd: dir });
        report('Installing pinned scientific packages…');
        // Copy the lock outside app.asar so the Python installer can read it.
        const lock = path.join(dir, 'requirements.lock'); fs.copyFileSync(path.join(__dirname, 'requirements', id + '.lock'), lock);
        await runCommand(uv, ['pip', 'install', '--python', envPython(dir), '--require-hashes', '--only-binary', ':all:', '-r', lock], { env, cwd: dir },
          chunk => { for (const line of chunk.split(/\r?\n/)) if (/^\s*(Downloading|Downloaded|Prepared|Installed)\b/.test(line)) report(line.trim()); });
        for (const file of SPECS[id].files) await download(file, path.join(dir, file.name), connection, report);
        report('Checking Python packages and test data…');
        await runCommand(envPython(dir), ['-I', '-c', SPECS[id].imports.map(name => `import ${name}`).join('; ')], { env, cwd: dir });
        writeJson(path.join(dir, 'installed.json'), { fingerprint: fingerprint(id), platform: platform + '-' + arch, pythonVersion: PYTHON_VERSION });
        cache.delete(id); suiteCache.clear(); tasks(id);
        progress.set(id, { status: 'ready', message: 'Ready' }); onChange();
        return locate(id);
      } catch (error) { progress.set(id, { status: 'error', message: error.message }); onChange(); throw error; }
      finally { await connection.close(); }
    }).finally(() => { pending = null; onChange(); });
    pending = { id, promise }; return promise;
  }
  return { state, suites, resolve, ensure, locate, get busy() { return Boolean(pending); } };
}

module.exports = { SPECS, EXTERNAL_SUITES, ADAPTER_VERSION, createLibraryManager, makeTasks, selectTasks, publicTask, download };
