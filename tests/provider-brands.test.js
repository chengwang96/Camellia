'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { providerBrand } = require('../src/shared/provider-brands');

test('known provider types map to their own brand marks', () => {
  for (const [type, brand] of [
    ['ollama', 'ollama'], ['deepseek', 'deepseek'], ['kimi', 'kimi'], ['kimi-code', 'kimi'],
    ['gemini', 'gemini'], ['commandcode', 'commandcode'], ['mimo', 'mimo'],
    ['mimo-token-plan-cn', 'mimo'], ['mimo-token-plan-sgp', 'mimo'], ['mimo-token-plan-ams', 'mimo'],
    ['opencode', 'opencode'], ['opencode-go', 'opencode'], ['qclaw', 'qclaw'],
  ]) assert.equal(providerBrand({ type }), brand, type);
});

test('custom providers identify a brand only from their documented host or name', () => {
  assert.equal(providerBrand({ type: 'custom', baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'nvidia');
  assert.equal(providerBrand({ type: 'custom', name: 'NVIDIA NIM' }), 'nvidia');
  assert.equal(providerBrand({ type: 'custom', name: 'Relay', baseUrl: 'https://api.deepseek.com/v1' }), 'deepseek');
  assert.equal(providerBrand({ type: 'custom', name: 'Codex 池', baseUrl: 'https://api.xnova.online/v1' }), '');
  assert.equal(providerBrand({ type: 'custom', name: 'Private OpenAI-compatible' }), '');
});

test('every identified brand has a bundled local asset', () => {
  for (const brand of ['ollama', 'deepseek', 'kimi', 'gemini', 'commandcode', 'mimo', 'nvidia', 'opencode']) {
    assert.ok(fs.existsSync(path.join(__dirname, '../assets/brands', brand + '.svg')), brand);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '../assets/brands/qclaw.png')));
});
