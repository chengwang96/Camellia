'use strict';

const identifier = { type: 'string', minLength: 1, maxLength: 160 };
const schema = (properties, required = []) => ({ type: 'object',
  properties: { ...properties, run_token: identifier }, required: [...required, 'run_token'], additionalProperties: false });
const finding = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low', 'info'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    category: { type: 'string', maxLength: 40 },
    file: { type: 'string', maxLength: 1000 },
    line: { type: 'integer', minimum: 1, maximum: 1000000000 },
    evidence: { type: 'string', minLength: 1, maxLength: 4000 },
    recommendation: { type: 'string', minLength: 1, maxLength: 4000 },
  },
  required: ['id', 'severity', 'evidence', 'recommendation'],
  additionalProperties: false,
};
const report = {
  review_id: identifier,
  target_hash: { type: 'string', minLength: 16, maxLength: 256 },
  verdict: { type: 'string', enum: ['pass', 'changes_requested', 'blocked'] },
  summary: { type: 'string', minLength: 1, maxLength: 12000 },
  findings: { type: 'array', maxItems: 50, items: finding },
  open_questions: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 } },
};

const tools = [
  { name: 'camellia_review_report',
    description: 'Submit the structured report for the active cross-engine review. Only the current reviewer child may call this. Do not use for ordinary conversation answers.',
    inputSchema: schema({ ...report, findings: report.findings, open_questions: report.open_questions },
      ['review_id', 'target_hash', 'verdict', 'summary', 'findings']) },
];

const instructions = 'The reviewer-only tool camellia_review_report submits a bounded structured report for the active review. It is not available to ordinary turns or children. A report must match the active review id and target hash; the reviewer must not edit files or apply fixes.';

module.exports = { tools, instructions };
