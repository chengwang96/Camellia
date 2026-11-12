'use strict';

const identifier = { type: 'string', minLength: 1, maxLength: 160 };
const schema = (properties, required = []) => ({ type: 'object',
  properties: { ...properties, run_token: identifier }, required: [...required, 'run_token'], additionalProperties: false });

const tools = [
  {
    name: 'camellia_review_start',
    description: 'Use when the user explicitly asks another engine or model to review, audit, challenge or double-check the current change. Starts a read-only cross-engine review. If conversation consent is missing this returns a consent request instead of spending quota. Reuse the same request_id for a retry.',
    inputSchema: schema({
      request_id: { type: 'string', minLength: 1, maxLength: 128 },
      reviewer_engine: { type: 'string', minLength: 1, maxLength: 32 },
      mode: { type: 'string', enum: ['standard', 'adversarial'] },
      focus: { type: 'string', maxLength: 4000 },
      base: { type: 'string', maxLength: 200 },
      wait: { type: 'boolean' },
      max_tokens: { type: 'integer', minimum: 1000, maximum: 1000000 },
    }, ['request_id']),
  },
  {
    name: 'camellia_review_status',
    description: 'Read the status of a review started from this conversation.',
    inputSchema: schema({ review_id: identifier }, ['review_id']),
  },
  {
    name: 'camellia_review_result',
    description: 'Read the structured report of a review started from this conversation. A stale, failed or cancelled review is not a pass.',
    inputSchema: schema({ review_id: identifier }, ['review_id']),
  },
  {
    name: 'camellia_review_cancel',
    description: 'Cancel a running review started from this conversation and preserve its current report state.',
    inputSchema: schema({ review_id: identifier }, ['review_id']),
  },
];

const instructions = 'When the user explicitly asks another engine or model to review, audit, challenge, double-check or 审查/复核 this change, call camellia_review_start instead of saying cross-engine review is unavailable. Use the engine the user names; otherwise choose an available different engine according to the conversation defaults. Use adversarial mode for challenge or design review. A review consumes reviewer quota and runs in a read-only snapshot. Reuse request_id on retries, then use status/result to report the structured outcome. Never treat a stale, failed, cancelled or missing report as a pass.';

const consentInstructions = 'When the user explicitly asks another engine or model to review, audit, challenge, double-check or 审查/复核 this change, call camellia_review_start instead of saying cross-engine review is unavailable. The first call returns an in-conversation consent request without spending reviewer quota. Tell the user a confirmation card is waiting; do not retry until it is approved.';

module.exports = { tools, startTool: tools[0], instructions, consentInstructions };
