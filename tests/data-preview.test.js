'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTable, supports, searchJson } = require('../src/renderer/chat/data-preview');

test('CSV and TSV preserve quoting, multiline fields, BOM and empty cells', () => {
  const csv = parseTable('\uFEFFname,value,extra\r\n"A,B","line 1\nline 2",\r\n"a""b",42,end\r\n', ',');
  assert.deepEqual(csv.rows, [['name', 'value', 'extra'], ['A,B', 'line 1\nline 2', ''], ['a"b', '42', 'end']]);
  assert.deepEqual(csv.errors, []);
  assert.deepEqual(parseTable('name\tvalue\nA\t42', '\t').rows, [['name', 'value'], ['A', '42']]);
  assert.equal(supports({ extension: '.JSON' }), true);
  assert.equal(supports({ name: 'report.csv' }), true);
  assert.equal(supports({ extension: 'JSONL' }), false);
});

test('data previews bound rows and columns and retain parse warnings', () => {
  const rows = parseTable('value\n' + 'a\n'.repeat(20001), ',');
  assert.equal(rows.rows.length, 20000);
  assert.equal(rows.truncated, true);
  const columns = parseTable(Array(201).fill('a').join(','), ',');
  assert.equal(columns.rows[0].length, 200);
  assert.equal(columns.truncated, true);
  assert.ok(parseTable('name,value\n"unclosed', ',').errors.length);
});

test('JSON search finds nested keys and values without unsafe property traversal', () => {
  const data = JSON.parse('{"__proto__":{"label":"Needle"},"other":[1,false,null]}');
  assert.equal(searchJson(data, 'needle').matches[0].path, '$["__proto__"]["label"]');
  assert.equal(searchJson(data, 'false').matches[0].value, false);
  assert.equal(searchJson(data, 'absent').matches.length, 0);
  assert.equal(searchJson(Array(201).fill('match'), 'match').matches.length, 100);
  assert.equal(searchJson(Array(201).fill('match'), 'match').limited, true);
  let deep = 'value';
  for (let depth = 0; depth < 55; depth++) deep = { child: deep };
  assert.equal(searchJson(deep, 'absent').limited, true);
});
