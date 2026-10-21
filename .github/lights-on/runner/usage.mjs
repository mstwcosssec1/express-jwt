const nonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (values) => values.length && values.every((value) => nonNegative(value) !== null)
  ? values.reduce((total, value) => total + value, 0) : null;
const round = (value) => Math.round(value * 1e6) / 1e6;

export function normalizeUsage(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const totalTokens = nonNegative(value.total_tokens) ??
    sum([value.prompt_tokens ?? value.input_tokens, value.completion_tokens ?? value.output_tokens]);
  const knownTokens = nonNegative(value.known_total_tokens) ?? totalTokens ?? 0;
  let cost = nonNegative(Object.hasOwn(value, 'cost_usd') ? value.cost_usd : value.cost ?? value.total_cost);
  let costSource = value.cost_source || (cost !== null ? 'reported' : 'unavailable');
  // Preserve an explicit unknown cost (notably Copilot's non-USD billing).
  if (cost === null && !Object.hasOwn(value, 'cost_usd') && !value.cost_source && totalTokens !== null) {
    cost = (totalTokens / 1_000_000) * 5;
    costSource = 'estimated';
  }
  return {
    total_tokens: totalTokens,
    known_total_tokens: knownTokens,
    tokens_status: value.tokens_status || (totalTokens === null ? 'unavailable' : 'reported'),
    cost_usd: cost,
    known_cost_usd: nonNegative(value.known_cost_usd) ?? cost ?? 0,
    cost_source: costSource,
    premium_requests: nonNegative(value.premium_requests),
    copilot_nano_aiu: nonNegative(value.copilot_nano_aiu),
    copilot_ai_credits_status: value.copilot_ai_credits_status || null,
    copilot_cli_invocations: nonNegative(value.copilot_cli_invocations) ?? 0,
    copilot_sdk_requests: nonNegative(value.copilot_sdk_requests) ?? 0,
    copilot_usage_reports: nonNegative(value.copilot_usage_reports) ?? 0
  };
}

export function normalizeCopilotUsage(report, { backend = 'cli' } = {}) {
  const metrics = report?.modelMetrics && typeof report.modelMetrics === 'object' && !Array.isArray(report.modelMetrics)
    ? Object.values(report.modelMetrics) : [];
  // modelMetrics is the session aggregate. agentMetrics/providerModelMetrics overlap it.
  const tokens = sum(metrics.map((metric) => sum([metric?.usage?.inputTokens, metric?.usage?.outputTokens])));
  return normalizeUsage({
    total_tokens: tokens,
    known_total_tokens: metrics.reduce((total, metric) =>
      total + (nonNegative(metric?.usage?.inputTokens) ?? 0) + (nonNegative(metric?.usage?.outputTokens) ?? 0), 0),
    tokens_status: tokens !== null ? 'reported' : metrics.length ? 'partial' : 'unavailable',
    cost_usd: null,
    cost_source: 'unavailable',
    premium_requests: nonNegative(report?.totalPremiumRequestCost),
    copilot_nano_aiu: nonNegative(report?.totalNanoAiu),
    copilot_ai_credits_status: typeof report?.aiCreditsStatus === 'string' ? report.aiCreditsStatus : 'unavailable',
    copilot_cli_invocations: backend === 'cli' ? 1 : 0,
    copilot_sdk_requests: backend === 'sdk' ? 1 : 0,
    copilot_usage_reports: metrics.length ? 1 : 0
  });
}

export function createUsageAccumulator() {
  const entries = [];
  return {
    add(raw) { entries.push(normalizeUsage(raw)); },
    snapshot() {
      const totalTokens = sum(entries.map((item) => item.total_tokens));
      const cost = sum(entries.map((item) => item.cost_usd));
      const knownTokens = entries.reduce((total, item) => total + item.known_total_tokens, 0);
      const knownCost = entries.reduce((total, item) => total + item.known_cost_usd, 0);
      const costSources = new Set(entries.map((item) => item.cost_source));
      const copilot = entries.filter((item) => item.copilot_cli_invocations + item.copilot_sdk_requests > 0);
      const creditStatuses = new Set(copilot.map((item) => item.copilot_ai_credits_status));
      return {
        total_tokens: totalTokens,
        known_total_tokens: knownTokens,
        tokens_status: totalTokens !== null ? 'reported' :
          entries.some((item) => item.tokens_status !== 'unavailable') ? 'partial' : 'unavailable',
        cost_usd: cost === null ? null : round(cost),
        known_cost_usd: round(knownCost),
        cost_source: cost === null ? (entries.some((item) => item.cost_source !== 'unavailable') ? 'partial' : 'unavailable') :
          costSources.size === 1 ? entries[0].cost_source : 'mixed',
        premium_requests: sum(copilot.map((item) => item.premium_requests)),
        copilot_nano_aiu: sum(copilot.map((item) => item.copilot_nano_aiu)),
        copilot_ai_credits_status: creditStatuses.size === 1 ? [...creditStatuses][0] : copilot.length ? 'mixed' : null,
        copilot_cli_invocations: copilot.reduce((total, item) => total + item.copilot_cli_invocations, 0),
        copilot_sdk_requests: copilot.reduce((total, item) => total + item.copilot_sdk_requests, 0),
        copilot_usage_reports: copilot.reduce((total, item) => total + item.copilot_usage_reports, 0)
      };
    }
  };
}

export function usageSummary(usage) {
  const value = normalizeUsage(usage);
  return {
    Tokens: value.total_tokens === null ? `Unknown (at least ${value.known_total_tokens} reported)` : value.total_tokens,
    'USD cost': value.cost_usd === null ? 'Unavailable; USD budgets cannot fully account for this usage' :
      `$${value.cost_usd.toFixed(6)} (${value.cost_source})`,
    ...(value.copilot_cli_invocations + value.copilot_sdk_requests ? {
      ...(value.copilot_cli_invocations ? { 'Copilot CLI invocations': value.copilot_cli_invocations } : {}),
      ...(value.copilot_sdk_requests ? { 'Copilot SDK requests': value.copilot_sdk_requests } : {}),
      'Copilot usage reports': `${value.copilot_usage_reports}/${value.copilot_cli_invocations + value.copilot_sdk_requests}`,
      'Premium requests (not USD)': value.premium_requests ?? 'unavailable',
      'Copilot nano-AIU (reported billing units)': value.copilot_nano_aiu ?? 'unavailable',
      'Copilot AI-credit status': value.copilot_ai_credits_status
    } : {})
  };
}
