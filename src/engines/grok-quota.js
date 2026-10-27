'use strict';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const cents = value => finite(value?.val) ? value.val / 100 : null;
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function normalizeGrokBilling(input, topupInput = null) {
  const raw = input?.result || input || {}, config = raw.config || {};
  const topup = topupInput?.result || topupInput || {};
  const period = config.currentPeriod || {};
  const windows = [], balances = [];
  let usedPercent = finite(config.creditUsagePercent) ? config.creditUsagePercent : null;
  if (usedPercent === null && finite(config.used?.val) && finite(config.monthlyLimit?.val) && config.monthlyLimit.val > 0) {
    usedPercent = config.used.val / config.monthlyLimit.val * 100;
  }
  if (usedPercent !== null) {
    const weekly = /WEEKLY/i.test(period.periodType || period.type || '');
    windows.push({ id: weekly ? 'weekly' : 'monthly', label: weekly ? 'Weekly included' : 'Included usage',
      usedPercent: Math.max(0, usedPercent), resetsAt: time(period.end || config.billingPeriodEnd) });
  }
  const prepaidBalance = cents(config.prepaidBalance);
  if (prepaidBalance !== null) balances.push({ id: 'prepaid', label: 'Prepaid balance', value: prepaidBalance, currency: 'USD' });
  const onDemandCap = cents(config.onDemandCap), onDemandUsed = cents(config.onDemandUsed);
  const autoTopup = topup.rule ? { enabled: topup.rule.enabled === true,
    threshold: cents(topup.rule.minBeforeHittingSl), amount: cents(topup.rule.topupAmount), monthlyCap: cents(topup.rule.maxAmountPerMonth) } : null;
  const plan = raw.subscriptionTier || null;
  const additionalAvailable = prepaidBalance > 0 || raw.onDemandEnabled === true && (onDemandCap === null || onDemandUsed === null || onDemandUsed < onDemandCap)
    || autoTopup?.enabled === true;
  const exhausted = windows.some(window => window.usedPercent >= 100) && !additionalAvailable;
  if (!windows.length && !balances.length && !plan) throw new Error('Grok returned no recognized subscription quota.');
  return { plan, windows, balances, modelUsage: [], prepaidBalance, onDemandCap, onDemandUsed,
    onDemandEnabled: raw.onDemandEnabled === true, unifiedBilling: config.isUnifiedBillingUser === true, autoTopup, exhausted };
}

function normalizeGrokModels(input) {
  const raw = input?.result || input || {};
  return (raw.availableModels || raw.models || []).map(model => {
    const id = model.modelId || model.id;
    const meta = model._meta || model.meta || {};
    const efforts = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
    const supportedReasoningEfforts = efforts.map(entry => entry.value || entry.id).filter(value => typeof value === 'string' && value);
    const defaultReasoningEffort = meta.reasoningEffort || efforts.find(entry => entry.default === true)?.value
      || efforts.find(entry => entry.default === true)?.id;
    return { id, name: model.name || model.displayName || id, description: model.description || '',
      isDefault: raw.currentModelId === id || raw.currentModel === id,
      contextWindow: Number(meta.totalContextTokens || meta.contextWindow || model.contextWindow) || undefined,
      supportsImages: model.promptCapabilities?.image !== false,
      supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) };
  }).filter(model => typeof model.id === 'string' && model.id);
}

module.exports = { normalizeGrokBilling, normalizeGrokModels };
