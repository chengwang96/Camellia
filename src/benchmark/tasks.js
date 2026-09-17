'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyTask } = require('./verifier');

const VERSION = 'camellia-bench-2';
// The entry task is an explicit smoke check: every acceptance case is available
// to the agent. Broader Unicode behavior remains a separate standard task.
const BASIC_TEXT_CASES = [
  ['Hello World', 'hello-world'], ['  Hello   WORLD  ', 'hello-world'],
  ['A\tB\nC', 'a-b-c'], ['Version 2', 'version-2'], ['', ''], [' \t\n ', ''],
];
const TASKS = [
  { id: 'slug-basic', name: 'Fix basic text formatting', category: 'Basic coding',
    instruction: 'Fix slug.cjs. It exports a function slug(text), which receives a string containing only ASCII letters, digits and whitespace. Trim leading and trailing whitespace, lowercase letters, and replace each internal run of whitespace with one hyphen. Return an empty string for empty or whitespace-only input. Preserve the CommonJS function export. Read check.cjs and run node check.cjs after editing; it contains all six acceptance cases. No external packages are needed.',
    files: { 'slug.cjs': "module.exports = function slug(text) { return text.toLowerCase().replace(' ', '-'); };\n",
      'check.cjs': "const assert = require('node:assert/strict');\nconst slug = require('./slug.cjs');\nfor (const [input, expected] of " + JSON.stringify(BASIC_TEXT_CASES) + ") {\n  assert.equal(slug(input), expected, JSON.stringify(input));\n}\nconsole.log('6/6 checks passed');\n" },
    probe: { file: 'slug.cjs', inputs: BASIC_TEXT_CASES.map(([input]) => [input]) },
    expected: BASIC_TEXT_CASES.map(([, expected]) => expected) },
  { id: 'slug', name: 'Repair Unicode text normalization', category: 'Unicode edge cases',
    instruction: 'Fix slug.cjs. Export a function slug(text). Normalize Unicode using NFKD, remove combining marks, lowercase, replace each run of non-ASCII-alphanumeric characters with one hyphen, and remove leading/trailing hyphens. Convert null and undefined to an empty string; other values are converted to strings. Do not change the export shape. Example: " Crème brûlée! " becomes "creme-brulee".',
    files: { 'slug.cjs': "module.exports = function slug(text) { return String(text).toLowerCase().replace(' ', '-'); };\n" },
    probe: { file: 'slug.cjs', inputs: [[' Crème brûlée! '], ['a___b -- c'], [null], [''], [123], ['你好 World'], ['---'], ['Ångström déjà vu'], ['a\tb\nc'], ['FOO...BAR'], ['a\u1ab0b'], []] },
    expected: ['creme-brulee', 'a-b-c', '', '', '123', 'world', '', 'angstrom-deja-vu', 'a-b-c', 'foo-bar', 'ab', ''] },
  { id: 'reconcile', name: 'Reconcile transaction files', category: 'Data processing',
    instruction: 'Read data/transactions.jsonl. Ignore malformed JSON and records unless id and customer are nonempty strings and cents is a nonnegative integer. For each id, keep its last VALID record. Include only records whose status is "paid". Write output/summary.json as an array sorted by customer (ASCII order), with one object per customer: {customer, count, cents}. Do not change the input file. You may use a script or the file tools.',
    files: { 'data/transactions.jsonl': '{"id":"a","customer":"Zoe","cents":500,"status":"paid"}\n{"id":"b","customer":"Amy","cents":101,"status":"paid"}\nnot json\n{"id":"c","customer":"Amy","cents":200,"status":"pending"}\n{"id":"a","customer":"Zoe","cents":700,"status":"paid"}\n{"id":"d","customer":"Amy","cents":99,"status":"paid"}\n{"id":"b","customer":"Amy","cents":-2,"status":"paid"}\n{"id":"e","customer":"Zoe","cents":0,"status":"paid"}\n{"id":"f","customer":"Amy","cents":80,"status":"refunded"}\n' },
    output: 'output/summary.json', expected: [{ customer: 'Amy', count: 2, cents: 200 }, { customer: 'Zoe', count: 2, cents: 700 }], preserve: ['data/transactions.jsonl'] },
  { id: 'invoice', name: 'Fix a multi-file invoice calculation', category: 'Multiple files',
    instruction: 'Repair money.cjs and invoice.cjs. money.cjs exports cents(price), converting a nonnegative decimal price string (zero, one or two fractional digits) to integer cents. invoice.cjs exports total(items, discountBps=0, taxBps=0). Each item has price and integer quantity. Compute subtotal in cents, round subtotal*discountBps/10000 to the nearest integer for discount, then round (subtotal-discount)*taxBps/10000 for tax. Return {subtotal, discount, tax, total}. Rates are integer basis points from 0 to 10000. Do not mutate items. Inputs meet these constraints. Use no external packages.',
    files: { 'money.cjs': 'exports.cents = price => parseInt(price, 10) * 100;\n',
      'invoice.cjs': "const { cents } = require('./money.cjs');\nexports.total = (items, discountBps = 0, taxBps = 0) => {\n const subtotal = items.reduce((sum, item) => sum + cents(item.price), 0);\n return { subtotal, discount: 0, tax: 0, total: subtotal };\n};\n" },
    probe: { file: 'invoice.cjs', export: 'total', inputs: [
      [[{ price: '0.10', quantity: 3 }, { price: '2.05', quantity: 2 }], 1000, 500],
      [[], 0, 0], [[{ price: '19.99', quantity: 3 }], 1500, 825], [[{ price: '0.01', quantity: 1 }], 5000, 0],
      [[{ price: '4', quantity: 0 }, { price: '1.2', quantity: 2 }], 0, 10000], [[{ price: '10.00', quantity: 1 }], 10000, 1000] ], immutable: true },
    expected: [{ subtotal: 440, discount: 44, tax: 20, total: 416 }, { subtotal: 0, discount: 0, tax: 0, total: 0 },
      { subtotal: 5997, discount: 900, tax: 421, total: 5518 }, { subtotal: 1, discount: 1, tax: 0, total: 0 },
      { subtotal: 240, discount: 0, tax: 240, total: 480 }, { subtotal: 1000, discount: 1000, tax: 0, total: 0 }],
    checks: [{ probe: { file: 'money.cjs', export: 'cents', inputs: [['0'], ['0.01'], ['1.2'], ['19.99'], ['123456.78']] }, expected: [0, 1, 120, 1999, 12345678] }] },
  { id: 'intervals', name: 'Implement interval merging', category: 'Algorithm',
    instruction: 'Implement mergeIntervals(intervals) as the default CommonJS export in intervals.cjs. Each valid interval is exactly two finite numbers [start,end] with start<=end. Ignore invalid entries. Return intervals sorted by start with overlapping or touching intervals merged. Keep disjoint zero-length intervals. Do not mutate the input. Example: [[3,5],[1,3],[8,8]] gives [[1,5],[8,8]]. Use no external packages.',
    files: { 'intervals.cjs': 'module.exports = intervals => intervals;\n' },
    probe: { file: 'intervals.cjs', inputs: [[[[3, 5], [1, 3], [8, 8]]], [[]], [[[1, 10], [2, 4], [10, 12]]],
      [[[4, 1], ['1', 2], null, [0, 1, 2], [2, 2]]], [[[-3, -1], [-2, 0], [4, 6], [1, 2]]], [[[2, 3], [2, 3], [0, 0]]]], immutable: true },
    expected: [[[1, 5], [8, 8]], [], [[1, 12]], [[2, 2]], [[-3, 0], [1, 2], [4, 6]], [[0, 0], [2, 3]]] },
  { id: 'retry', name: 'Implement a bounded retry policy', category: 'API logic',
    instruction: 'Implement retryPolicy(status, attempt, retryAfterSeconds=null) as the default CommonJS export in retry.cjs. Only status 429,500,502,503,504 can retry. attempt is zero-based; attempt>=3 never retries. Non-retry returns {retry:false,delayMs:0}. Retry returns {retry:true,delayMs:D}. If retryAfterSeconds is a finite nonnegative number, D is Math.round(retryAfterSeconds*1000); otherwise D is 250*2**attempt. Cap D at 8000 milliseconds. Preserve an explicit zero retry delay. Inputs have integer status and nonnegative integer attempt.',
    files: { 'retry.cjs': 'module.exports = () => ({ retry: false, delayMs: 0 });\n' },
    probe: { file: 'retry.cjs', inputs: [[429, 0], [503, 2], [500, 3], [401, 0, 2], [502, 0, 0], [504, 1, 1.25], [429, 1, 30], [400, 0], [500, 0, -1], [501, 0]] },
    expected: [{ retry: true, delayMs: 250 }, { retry: true, delayMs: 1000 }, { retry: false, delayMs: 0 }, { retry: false, delayMs: 0 },
      { retry: true, delayMs: 0 }, { retry: true, delayMs: 1250 }, { retry: true, delayMs: 8000 }, { retry: false, delayMs: 0 }, { retry: true, delayMs: 250 }, { retry: false, delayMs: 0 }] },
  { id: 'trace', name: 'Trace configuration precedence', category: 'Repository understanding',
    instruction: 'Inspect this repository without changing its existing files. Read src/config.cjs and the fixtures it uses. Determine the result of resolveConfig("production", {PORT:"0", FEATURE_X:"false", LABEL:""}). Write output/config.json with exactly the resulting object. Preserve the value types. Do not replace configuration loading with a hardcoded implementation.',
    files: { 'src/config.cjs': "const defaults = require('../config/defaults.json');\nconst environments = require('../config/environments.json');\nexports.resolveConfig = (name, env = {}) => {\n const result = { ...defaults, ...(environments[name] || {}) };\n if (env.PORT !== undefined) result.port = Number(env.PORT);\n if (env.FEATURE_X !== undefined) result.featureX = env.FEATURE_X === 'true';\n if (env.LABEL !== undefined) result.label = env.LABEL;\n return result;\n};\n",
      'config/defaults.json': '{"port":3000,"featureX":false,"label":"development","retries":2}\n',
      'config/environments.json': '{"production":{"port":8080,"featureX":true,"label":"live","retries":5},"test":{"port":9000}}\n' },
    output: 'output/config.json', expected: { port: 0, featureX: false, label: '', retries: 5 },
    preserve: ['src/config.cjs', 'config/defaults.json', 'config/environments.json'] },
];
const SUITES = [
  { id: 'quick', name: 'Quick check', description: '3 tasks · basic editing with public checks, data processing, multiple files', taskIds: ['slug-basic', 'reconcile', 'invoice'] },
  { id: 'standard', name: 'Standard', description: '7 tasks · adds Unicode edge cases, algorithms, API logic, repository understanding', taskIds: TASKS.map(t => t.id) },
];
const suiteHash = createHash('sha256').update(JSON.stringify(TASKS)).digest('hex');
function publicSuites() { return SUITES.map(s => ({ ...s, tasks: s.taskIds.map(id => { const { name, category } = TASKS.find(t => t.id === id); return { id, name, category }; }) })); }
function prepareTask(task, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  for (const [name, content] of Object.entries({ ...task.files, 'TASK.md': task.instruction + '\n' })) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
}
module.exports = { VERSION, TASKS, SUITES, suiteHash, publicSuites, prepareTask, verifyTask };
