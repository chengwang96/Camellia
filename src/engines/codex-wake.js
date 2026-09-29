'use strict';

// One explicit greeting on the requested profile; no retries or account rotation.
async function wakeAccount({ createClient, cwd, model, usageMeter, timeoutMs = 60000 }) {
  let client, timer, threadId, completed = false, active = true;
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A notification may arrive while the turn/start response is still pending.
  done.catch(() => {});
  try {
    client = createClient({
      onNotification(method, params) {
        if (params.threadId !== threadId) return;
        if (method === 'thread/tokenUsage/updated') usageMeter?.codex(params.tokenUsage);
        if (method === 'model/rerouted') usageMeter?.reroute(params.toModel);
        if (method !== 'turn/completed') return;
        if (params.turn.status === 'completed') resolve();
        else reject(new Error(params.turn.error?.message || 'Account wake request did not complete'));
      },
      onRequest(request) { client.write({ id: request.id, error: { code: -32600, message: 'Account wake does not allow tools or interactions' } }); },
      onClose(error) { reject(error); },
    });
    timer = setTimeout(() => reject(new Error('Account wake timed out. It may have consumed usage; refresh quota before retrying.')), timeoutMs);
    const run = async () => {
      await client.ready;
      const result = await client.request('thread/start', { cwd, model, modelProvider: 'openai', ephemeral: true,
        approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Reply to the greeting with only 你好. Do not use tools, read files, or access the network.',
        config: { 'features.shell_tool': false, web_search: 'disabled', 'model_reasoning_effort': 'low' } });
      threadId = result.thread.id;
      if (usageMeter) await usageMeter.begin(threadId, () => active);
      if (!active) return;
      await client.request('turn/start', { threadId, model, input: [{ type: 'text', text: '你好' }] });
      await done;
    };
    await Promise.race([run(), done]);
    completed = true;
  } finally {
    active = false;
    clearTimeout(timer);
    try { await client?.shutdown(); }
    finally { await usageMeter?.end({ subtype: completed ? 'success' : 'error', is_error: !completed }); }
  }
}
module.exports = { wakeAccount };
