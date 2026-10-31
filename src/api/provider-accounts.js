'use strict';

const { endpoint, modelId } = require('./api-router-config');
const { normalizeThinking } = require('../shared/model-levels');
const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const labels = { session: "Current session", rolling: "5-hour", fiveHour: "5-hour", weekly: "Weekly", monthly: "Monthly", daily: "Daily" };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function creditTime(value) {
  if (typeof value !== 'number' && !/^\d+(?:\.\d+)?$/.test(String(value))) return time(value);
  const timestamp = number(value);
  if (timestamp === null || timestamp <= 0) return null;
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function windowRow(id, value, multiplier = 1) {
  const percent = number(value);
  return percent === null ? null : { id, label: labels[id] || id, usedPercent: Math.max(0, percent * multiplier), resetsAt: null };
}
function empty() { return { balances: [], windows: [], modelUsage: [] }; }
function requireData(result) {
  if (!result.balances.length && !result.windows.length) throw new Error("The API returned no recognized balance or quota. The previous result was retained.");
  return result;
}
async function requestJson(url, key, { fetchImpl = fetch, method = 'GET', body, headers = {}, timeoutMs = 20000, signal, maxResponseBytes = 0 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
  } catch (e) { throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? "Query timed out. Try again later." : "Cannot connect to the provider. Check the network and API URL."); }
  if (!response.ok) {
    const reason = { 401: "Key is invalid or expired", 402: "Insufficient account balance", 403: "This key lacks access or the required subscription", 404: "The provider does not offer this endpoint", 429: "Too many queries. Try again later." }[response.status];
    throw Object.assign(new Error(`HTTP ${response.status} · ${reason || "The provider cannot complete this query right now"}`), { status: response.status });
  }
  try {
    if (!maxResponseBytes || !response.body?.getReader) return await response.json();
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw Object.assign(new Error('The provider response is too large. Try a narrower query or another page.'), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error.code === 'RESPONSE_TOO_LARGE') throw error;
    throw new Error("The provider returned an unreadable response");
  }
}

// Each adapter owns its endpoint and schema. A relay/custom host does not
// inherit an official provider's account API or receive another host's keys.
const adapters = [
  {
    id: 'deepseek', label: "DeepSeek account balance", source: 'official',
    docs: 'https://api-docs.deepseek.com/api/get-user-balance/',
    matches: u => u.hostname === 'api.deepseek.com',
    async query(u, get) {
      const data = await get(`${u.origin}/user/balance`), out = empty();
      for (const balance of data.balance_infos || []) {
        const value = number(balance.total_balance);
        if (value !== null) out.balances.push({ id: balance.currency, label: "Available balance", value, currency: balance.currency,
          parts: [{ label: "Top-up", value: number(balance.topped_up_balance) }, { label: "Promotional", value: number(balance.granted_balance) }] });
      }
      return requireData(out);
    },
  },
  {
    id: 'moonshot', label: "Kimi platform balance", source: 'official',
    docs: 'https://platform.kimi.com/docs/api/balance',
    matches: u => ['api.moonshot.cn', 'api.moonshot.ai'].includes(u.hostname),
    async query(u, get) {
      const result = await get(`${u.origin}/v1/users/me/balance`), data = result.data, out = empty();
      const value = number(data?.available_balance);
      if (result.status !== false && value !== null) out.balances.push({ id: 'available', label: "Available balance", value, currency: u.hostname.endsWith('.cn') ? 'CNY' : 'USD',
        parts: [{ label: "Cash", value: number(data.cash_balance) }, { label: "Vouchers", value: number(data.voucher_balance) }] });
      return requireData(out);
    },
  },
  {
    id: 'kimi-code', label: "Kimi Code subscription quota", source: 'client',
    docs: 'https://github.com/MoonshotAI/kimi-code',
    matches: u => ['api.kimi.com', 'api.kimi.ai'].includes(u.hostname) && u.pathname.startsWith('/coding/'),
    async query(u, get) {
      const data = await get(`${u.origin}/coding/v1/usages`), out = empty();
      const rows = [{ id: 'weekly', label: "Weekly", detail: data.usage }, ...(data.limits || []).map((row, i) => ({ id: 'limit-' + i, ...row }))];
      const units = { TIME_UNIT_MINUTE: "minutes", TIME_UNIT_HOUR: "hours", TIME_UNIT_DAY: "days", TIME_UNIT_WEEK: "weeks" };
      for (const row of rows) {
        const used = number(row.detail?.used), limit = number(row.detail?.limit);
        if (used === null || limit === null || limit <= 0) continue;
        out.windows.push({ id: row.id, label: row.name || row.label || (row.window ? `${row.window.duration} ${units[row.window.timeUnit] || ''}` : "Subscription quota"),
          usedPercent: Math.max(0, used / limit * 100), resetsAt: time(row.detail.resetTime) });
      }
      return requireData(out);
    },
  },
  {
    id: 'opencode-go', label: "OpenCode Go subscription quota", source: 'client',
    docs: 'https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts',
    matches: u => u.hostname === 'opencode.ai' && u.pathname.startsWith('/zen/go/'),
    async query(u, get) {
      const data = await get(`${u.origin}/zen/go/v1/usage`), out = empty();
      for (const [id, usage] of Object.entries(data.usage || {})) {
        const row = windowRow(id, usage.percent);
        if (row) out.windows.push({ ...row, resetsAt: time(usage.resetsAt) });
      }
      return requireData(out);
    },
  },
  {
    id: 'ollama', label: "Ollama Cloud quota", source: 'official',
    docs: 'https://docs.ollama.com/api/balance',
    matches: u => u.hostname === 'ollama.com',
    async query(u, get) {
      const data = await get(`${u.origin}/api/balance`), out = empty();
      const included = data.included;
      // Legacy plans report the percentage remaining, rather than a usage
      // fraction. The usage endpoint now contains request statistics only.
      for (const id of ['session', 'weekly']) {
        const remaining = number(included?.[id]?.remaining_percent);
        if (remaining === null || remaining < 0 || remaining > 100) continue;
        out.windows.push({ ...windowRow(id, 100 - remaining), resetsAt: time(included[id].resets_at) });
      }
      const plan = number(included?.balance_usd), purchased = number(data.purchased?.balance_usd);
      if (plan !== null && purchased !== null) {
        const value = plan + purchased;
        out.balances.push({ id: 'available', label: "Available balance", value, currency: 'USD',
          parts: [{ label: "Plan", value: plan }, { label: "Add-on", value: purchased }] });
        // New plans have a monthly credit allowance, with no session/weekly
        // limits. A spent allowance does not block purchased credits.
        out.exhausted = value <= 0;
      }
      const allowance = number(included?.allowance_usd);
      if (plan !== null && purchased !== null && allowance !== null && allowance > 0) {
        out.windows.push({ ...windowRow('monthly', (allowance - plan) / allowance * 100), resetsAt: time(included.period?.until) });
      }
      return requireData(out);
    },
  },
  {
    id: 'commandcode', label: 'Command Code Credits', source: 'client',
    docs: 'https://commandcode.ai/docs/resources/usage-limits',
    matches: u => u.hostname === 'api.commandcode.ai',
    async query(u, get) {
      const who = await get(`${u.origin}/alpha/whoami?limits=1`);
      const org = who.org?.id ? '?orgId=' + encodeURIComponent(who.org.id) : '';
      const [data, subscriptionResponse] = await Promise.all([
        get(`${u.origin}/alpha/billing/credits${org}`),
        get(`${u.origin}/alpha/billing/subscriptions${org}`).catch(() => null),
      ]);
      const out = empty();
      const credits = data.credits;
      if (credits) {
        const parts = [['monthlyCredits', "Plan"], ['purchasedCredits', "Add-on"], ['freeCredits', "Promotional"]].map(([key, label]) => ({ label, value: number(credits[key]) }));
        if (parts.every(p => p.value !== null)) out.balances.push({ id: 'credits', label: "Remaining credits", value: parts.reduce((sum, p) => sum + p.value, 0), currency: 'credits', parts });
      }
      for (const [id, usage] of Object.entries(data.windowLimits || {})) {
        // This container also includes limited/exceeded flags; exceeded may
        // be null when no usage window is currently exhausted.
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
        const used = number(usage.used), cap = number(usage.cap);
        if (used !== null && cap !== null && cap > 0) out.windows.push({ id, label: labels[id] || id, usedPercent: Math.max(0, used / cap * 100), resetsAt: creditTime(usage.resetAt) });
      }
      const subscription = subscriptionResponse?.success !== false ? subscriptionResponse?.data : null;
      const monthly = number(credits?.monthlyCredits);
      if (monthly !== null && ['active', 'trialing'].includes(subscription?.status)) {
        // The API reports remaining monthly credits, but no monthly cap. Show
        // that amount directly; published plan totals can vary by renewal.
        out.windows.push({ id: 'monthly', label: "Monthly", usedPercent: null, remainingValue: monthly,
          unit: 'credits', resetsAt: creditTime(subscription.currentPeriodEnd) });
      }
      for (const limit of who.orgLimits || []) {
        const spent = number(limit.spent), cap = number(limit.limit);
        if (spent !== null && cap !== null && cap > 0) out.windows.push({ id: 'org-' + (limit.model || 'all'), label: limit.modelLabel || limit.model || "Organization limit",
          model: limit.model || null, usedPercent: Math.max(0, spent / cap * 100), resetsAt: creditTime(limit.resetAt) });
      }
      if (out.balances.length) {
        const extra = number(credits.purchasedCredits) + number(credits.freeCredits);
        out.exhausted = out.balances[0].value <= 0 || (extra <= 0 && out.windows.some(window => window.usedPercent >= 100));
      }
      return requireData(out);
    },
  },
];

function accountCapability(provider) {
  const u = new URL(provider.baseUrl);
  const adapter = adapters.find(a => a.matches(u));
  if (u.hostname === 'generativelanguage.googleapis.com') return { supported: false,
    label: 'Gemini billing and quotas are managed in Google AI Studio. Camellia tracks usage for each key and model',
    source: 'official', docs: 'https://aistudio.google.com/usage' };
  if (!adapter) return { supported: false, label: u.hostname === 'opencode.ai' ? "OpenCode Zen does not provide API-key balance queries" : "Balance queries not supported", source: null };
  return { supported: true, id: adapter.id, label: adapter.label, source: adapter.source, docs: adapter.docs };
}
async function queryAccount(provider, key, options = {}) {
  const capability = accountCapability(provider);
  if (!capability.supported) return { status: 'unsupported', ...capability };
  const adapter = adapters.find(a => a.id === capability.id);
  return { status: 'ok', ...capability, ...await adapter.query(new URL(provider.baseUrl), url => requestJson(url, key, options)) };
}
function catalogModel(provider, entry) {
  const upstream = typeof entry === 'string' ? entry : entry?.id || entry?.name || entry?.model;
  if (typeof upstream !== 'string' || !upstream.trim()) return null;
  let id = upstream;
  try { id = modelId(id); } catch { return null; }
  const wire = typeof entry === 'object' && entry !== null ? entry.api || entry.protocol : '';
  const protocol = /anthropic|messages/i.test(wire) || (provider.type === 'commandcode' && /claude/.test(id)) ? 'anthropic' : 'auto';
  // Catalogs like OpenRouter report the model's context limit; keep it as the cap.
  const maxContext = typeof entry === 'object' && entry !== null
    ? Number(entry.context_length ?? entry.context_window ?? entry.max_context_length ?? entry.max_context ?? entry.max_input_tokens) || undefined : undefined;
  const thinking = catalogThinking(entry);
  return { id, upstream, protocol, ...(Number.isSafeInteger(maxContext) && maxContext >= 4096 ? { maxContext } : {}), ...(thinking ? { thinking } : {}) };
}
function catalogThinking(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  for (const source of [entry, entry.capabilities, entry.metadata]) {
    if (!source || typeof source !== 'object') continue;
    const thinking = normalizeThinking(source.thinking);
    if (thinking) return thinking;
    // Command Code's client catalog uses reasoningEfforts; OpenCode Zen/Go
    // uses capabilities.reasoning.effort; Kimi uses support_efforts.
    const reasoning = source.reasoning;
    const efforts = source.supported_reasoning_efforts ?? source.supportedReasoningEfforts ?? source.supported_reasoning_levels
      ?? source.reasoning_efforts ?? source.reasoningEfforts ?? source.support_efforts ?? source.effort?.supported_levels
      ?? reasoning?.supported_efforts ?? reasoning?.efforts ?? reasoning?.effort;
    const defaultValue = source.default_reasoning_effort ?? source.defaultReasoningEffort ?? source.default_reasoning_level
      ?? source.default_effort ?? source.effort?.default_level ?? reasoning?.default?.value ?? reasoning?.default;
    const levelValue = level => {
      const value = typeof level === 'object' && level !== null ? level.reasoningEffort ?? level.effort : level;
      return value === 'off' ? 'none' : value;
    };
    const capabilities = Array.isArray(source.capabilities) ? source.capabilities : [];
    const toggle = reasoning?.toggle === true || capabilities.includes('thinking') && !capabilities.includes('always_thinking');
    if (reasoning?.supported === false) return { values: [] };
    if (!Array.isArray(efforts)) {
      if (toggle) return { values: [false, true] };
      // A null list in Command Code's client schema explicitly means there
      // is no selectable effort. Do not probe a nonexistent detail endpoint.
      if (source.reasoningEfforts === null) return { values: [] };
      continue;
    }
    const values = efforts.map(levelValue);
    if (toggle && values.length && !values.includes('none')) values.unshift('none');
    const reported = normalizeThinking({ values: values.length ? values : toggle ? [false, true] : [], default: levelValue(defaultValue) });
    if (reported) return reported;
  }
}
function documentedThinking(provider, model) {
  const host = new URL(provider.baseUrl).hostname;
  const mimoHosts = ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com'];
  const mimoModels = ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'];
  if (!model.thinking && mimoHosts.includes(host) && mimoModels.includes(model.upstream)) model.thinking = { values: [false, true], default: true };
  // https://api-docs.deepseek.com/guides/thinking_mode/ (2026-10-20).
  // Only the official host and documented IDs inherit this fallback.
  if (!model.thinking && host === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model.upstream)) {
    model.thinking = { values: ['none', 'low', 'high', 'max'], default: 'high' };
  }
  if (host === 'api.deepseek.com' && model.thinking?.values.some(value => typeof value === 'string') && !model.thinking.values.includes('none')) {
    model.thinking.values.unshift('none');
  }
  if (model.thinking) return;
  // These first-party APIs do not consistently advertise controls in /models.
  // Exact documented IDs only; a provider type on a relay is not evidence.
  // https://platform.kimi.ai/docs/guide/use-thinking-models (2026-10-31).
  if (['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.ai'].includes(host) && new URL(provider.baseUrl).pathname.replace(/\/+$/, '') === '/v1') {
    if (['kimi-k3', 'kimi-k3.1-pro'].includes(model.upstream)) model.thinking = { values: ['low', 'high', 'max'], default: 'max' };
    if (['kimi-k2.5', 'kimi-k2.6'].includes(model.upstream)) model.thinking = { values: [false, true], default: true };
    if (['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo'].includes(model.upstream)) model.thinking = { values: [] };
  }
  // https://www.kimi.com/code/docs/en/kimi-code/models.html (2026-10-31).
  if (['api.kimi.com', 'api.kimi.ai'].includes(host) && /^\/coding(?:\/v1)?\/?$/.test(new URL(provider.baseUrl).pathname)) {
    if (['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding'].includes(model.upstream)) {
      model.thinking = { values: ['low', 'high', 'max'], default: model.upstream === 'kimi-for-coding' ? 'max' : 'high' };
    }
    if (model.upstream === 'kimi-for-coding-highspeed') model.thinking = { values: [] };
  }
  // https://ai.google.dev/gemini-api/docs/openai#thinking and /thinking.
  // OpenAI effort names, not native thinking budgets. No blanket Gemini match:
  // image/audio/embedding models and future IDs must report their own controls.
  if (host === 'generativelanguage.googleapis.com') {
    const gemini = {
      'gemini-4-argon': ['low', 'medium', 'high'],
      'gemini-3.8-flash': ['low', 'medium', 'high'],
      'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
      'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
      'gemini-3.1-flash-lite': ['minimal', 'low', 'medium', 'high'],
      'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
      'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
      'gemini-3-pro-preview': ['low', 'high'],
      'gemini-2.5-pro': ['low', 'medium', 'high'],
      'gemini-2.5-flash': ['none', 'low', 'medium', 'high'],
      'gemini-2.5-flash-lite': ['none', 'low', 'medium', 'high'],
    };
    const values = Object.hasOwn(gemini, model.upstream) ? gemini[model.upstream] : undefined;
    if (values) model.thinking = { values };
  }
}
async function fetchModels(provider, key, options = {}) {
  const base = endpoint(provider.baseUrl);
  const ollama = provider.type === 'ollama' || new URL(base).hostname === 'ollama.com';
  const commandcode = new URL(base).hostname === 'api.commandcode.ai' && new URL(base).pathname === '/provider/v1';
  let data;
  if (options.configuredOnly && ollama) data = { data: [] };
  else {
    try {
      // The standard Command Code list omits reasoningEfforts. This is the
      // same richer, same-host catalog used by their official CLI (v1.88.2).
      if (commandcode) {
        try {
          data = await requestJson(base + '/models?view=client', key, options);
          if (!Array.isArray(data?.data)) data = undefined;
        } catch { /* Older servers may expose only the standard catalog. */ }
      }
      if (!data) data = await requestJson(base + '/models', key, options);
    }
    catch (error) { if (!options.configuredOnly) throw error; data = { data: [] }; }
  }
  if (!Array.isArray(data.data) && !Array.isArray(data.models)) throw new Error("No model catalog was returned. Add models manually.");
  const unique = new Map();
  for (const entry of data.data || data.models) {
    // The client catalog also carries hidden/legacy models. Preserve them
    // only for existing configured routes, not the Add models picker.
    if (commandcode && entry?.hidden === true && !options.configuredOnly) continue;
    const model = catalogModel(provider, entry);
    if (!model) continue;
    const existing = unique.get(model.upstream);
    if (!existing) unique.set(model.upstream, model);
    else if (existing.upstream === model.upstream) {
      if (!existing.thinking && model.thinking) existing.thinking = model.thinking;
      if (!existing.maxContext && model.maxContext) existing.maxContext = model.maxContext;
    }
  }
  // Background discovery updates configured routes, never adds catalog entries
  // or depends on a working list endpoint for manually configured models.
  const models = options.configuredOnly ? (provider.models || []).map(model =>
    unique.get(model.upstream) || { id: model.id, upstream: model.upstream, protocol: model.protocol }) : [...unique.values()];
  for (const model of models) documentedThinking(provider, model);
  if (provider.type !== 'qclaw') {
    const configured = new Set((provider.models || []).map(model => model.upstream));
    const queue = models.filter(model => ollama || !model.thinking).sort((first, second) => Number(configured.has(second.upstream)) - Number(configured.has(first.upstream)));
    const showUrl = base.replace(/\/(?:v1|api)$/, '') + '/api/show';
    const budget = AbortSignal.timeout(options.detailBudgetMs || 15000);
    const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
    let unsupported = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && !signal.aborted && unsupported < 4) {
        const model = queue.shift();
        try {
          const data = await requestJson(ollama ? showUrl : base + '/models/' + encodeURIComponent(model.upstream), key, {
            ...options, method: ollama ? 'POST' : 'GET', body: ollama ? { model: model.upstream } : undefined, timeoutMs: 5000, signal,
          });
          const details = data?.data && !Array.isArray(data.data) ? data.data : data;
          if (!details || typeof details !== 'object') continue;
          const reportedId = details.id || details.name || details.model;
          if (!ollama && reportedId !== model.upstream) continue;
          const thinking = catalogThinking(details);
          if (thinking) model.thinking = thinking;
          documentedThinking(provider, model);
          const detailedModel = catalogModel(provider, details);
          const limits = Object.entries(details.model_info || {}).filter(([name]) => name.endsWith('.context_length'))
            .map(([, value]) => Number(value)).filter(value => Number.isSafeInteger(value) && value >= 4096);
          if (!model.maxContext && detailedModel?.maxContext) model.maxContext = detailedModel.maxContext;
          if (!model.maxContext && limits.length) model.maxContext = Math.min(...limits);
        } catch (error) {
          if (!ollama && [400, 404, 405, 501].includes(error.status)) unsupported++;
        }
      }
    }));
  }
  return models;
}
async function verifyModel(provider, key, model, options = {}) {
  const wire = model.protocol && model.protocol !== 'auto' ? model.protocol : provider.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const base = endpoint(wire === 'anthropic' && provider.anthropicBaseUrl ? provider.anthropicBaseUrl : provider.baseUrl);
  const data = await requestJson(base + (wire === 'anthropic' ? '/messages' : '/chat/completions'), key, {
    ...options, method: 'POST', headers: wire === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {},
    body: { model: model.upstream, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16, stream: false },
  });
  if (data.error || !(wire === 'anthropic' ? Array.isArray(data.content) : Array.isArray(data.choices) && data.choices.length)) throw new Error("The API did not return a valid model response");
  return { model: model.id, usage: data.usage || null };
}
module.exports = { accountCapability, queryAccount, requestJson, fetchModels, verifyModel };
