import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeUsage } from './usage.mjs';

export const LABELS = {
  IGNORE: 'lights-on:ignore',
  ACTIONABLE: 'lights-on:actionable',
  MIGRATE_DEP: 'lights-on:migrate-dep',
  HOLD: 'lights-on:hold',
  AUTOMERGE: 'lights-on:automerge',
  RE_REVIEW: 'lights-on:re-review',
  NEEDS_HUMAN: 'lights-on:needs-human',
  APPROVED_OVERRIDE: 'lights-on:approved-override',
  APPROVED: 'lights-on:approved',
  CHANGES_REQUESTED: 'lights-on:changes-requested',
  AUTOMERGE_DISABLED_EXTERNAL: 'lights-on:automerge-disabled-external',
  TRIAGED: 'lights-on:triaged',
  IN_PROGRESS: 'lights-on:in-progress',
  REVIEWED: 'lights-on:reviewed',
  AUTOMATION: 'lights-on:automation',
  RELEASE: 'lights-on:release',
  AGENT_PR: 'lights-on:agent-pr',
  PAUSE: 'lights-on:pause',
  UPSTREAM: 'lights-on:upstream'
};

export const PROTECTED_MAINTAINER_ADD_LABELS = new Set([
  LABELS.AUTOMERGE.toLowerCase(),
  LABELS.APPROVED_OVERRIDE.toLowerCase(),
  LABELS.MIGRATE_DEP.toLowerCase(),
  LABELS.PAUSE.toLowerCase(),
  LABELS.RELEASE.toLowerCase(),
  LABELS.APPROVED.toLowerCase(),
  LABELS.AGENT_PR.toLowerCase(),
  LABELS.UPSTREAM.toLowerCase()
]);

export const PROTECTED_MAINTAINER_REMOVE_LABELS = new Set([
  LABELS.HOLD.toLowerCase(),
  LABELS.IGNORE.toLowerCase(),
  LABELS.NEEDS_HUMAN.toLowerCase(),
  LABELS.PAUSE.toLowerCase()
]);

export const STATE_MARKER_REGEX = /<!--\s*lights-on-state:\s*(\{[\s\S]*?\})\s*-->/;

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_STATE_BOT_LOGINS = new Set([
  'github-actions[bot]',
  'app/github-actions',
  'lights-on[bot]',
  'copilot-swe-agent[bot]',
  'app/copilot-swe-agent'
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripDangerousKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripDangerousKeys);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    clean[k] = v && typeof v === 'object' ? stripDangerousKeys(v) : v;
  }
  return clean;
}

export function isTrustedStateAuthor(userOrLogin, authorAssociation) {
  const login =
    typeof userOrLogin === 'object' && userOrLogin !== null
      ? userOrLogin.login
      : userOrLogin;
  if (typeof login === 'string' && TRUSTED_STATE_BOT_LOGINS.has(login.trim().toLowerCase())) {
    return true;
  }
  if (typeof userOrLogin === 'object' && userOrLogin !== null && userOrLogin.id === 41898282) {
    return true;
  }
  return isMaintainerAssociation(authorAssociation);
}

export function sanitizeAgentLabelChanges(labelsToAdd = [], labelsToRemove = [], { readOnly = false } = {}) {
  const validLabel = (label) =>
    typeof label === 'string' && label.length <= 50 && !/[,\r\n"'\x00-\x1f\x7f]/.test(label);
  for (const label of [...(Array.isArray(labelsToAdd) ? labelsToAdd : []), ...(Array.isArray(labelsToRemove) ? labelsToRemove : [])]) {
    if (!validLabel(label)) {
      throw new Error('Invalid agent label: labels must be individual names without CSV delimiters or control characters.');
    }
  }
  const safeAdd = (Array.isArray(labelsToAdd) ? labelsToAdd : [])
    .map((l) => String(l || '').trim())
    .filter((l) => {
      if (!l) return false;
      const lower = l.toLowerCase();
      if (PROTECTED_MAINTAINER_ADD_LABELS.has(lower)) return false;
      if (readOnly && lower === LABELS.ACTIONABLE.toLowerCase()) return false;
      return true;
    });

  const safeRemove = (Array.isArray(labelsToRemove) ? labelsToRemove : [])
    .map((l) => String(l || '').trim())
    .filter((l) => l && !PROTECTED_MAINTAINER_REMOVE_LABELS.has(l.toLowerCase()));

  return { labelsToAdd: safeAdd, labelsToRemove: safeRemove };
}

export function sanitizeBranchName(candidateBranch, fallbackBranch, defaultBranch = 'main') {
  const fallback = String(fallbackBranch || 'lights-on/automated-update').trim();
  if (!candidateBranch || typeof candidateBranch !== 'string') {
    return fallback;
  }
  const trimmed = candidateBranch.trim();
  const forbidden = new Set(['main', 'master', 'develop', 'trunk', String(defaultBranch || 'main').trim()]);
  if (
    forbidden.has(trimmed) ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    !/^lights-on\/[A-Za-z0-9._-]+$/.test(trimmed)
  ) {
    return fallback;
  }
  return trimmed;
}

export function createInitialState() {
  return {
    version: 1,
    updated_at: null,
    last_run_by_task: {},
    ecosystem_cache: {},
    cooldowns: {},
    processed_items: {},
    usage_history: []
  };
}

export function formatStateComment(bodyOrState, stateObj = {}) {
  if (bodyOrState && typeof bodyOrState === 'object' && !Array.isArray(bodyOrState)) {
    const payload = { v: 1, ...bodyOrState };
    return `<!-- lights-on-state: ${JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
  }
  const payload = { v: 1, ...stateObj };
  const marker = `<!-- lights-on-state: ${JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
  const rawBody = typeof bodyOrState === 'string' ? bodyOrState : '';
  const strippedBody = rawBody.replace(/<!--\s*lights-on-state:\s*[\s\S]*?\s*-->/gi, '').trimEnd();

  if (!strippedBody.trim()) {
    return marker;
  }

  return strippedBody + '\n\n' + marker;
}

export function parseStateFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(STATE_MARKER_REGEX);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? stripDangerousKeys(parsed) : null;
  } catch {
    return null;
  }
}

export function parseSlashCommand(commentBody) {
  if (!commentBody || typeof commentBody !== 'string') return null;
  const lines = commentBody.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const match = trimmed.match(/^\/lights-on(?:\s+([a-zA-Z0-9_-]+))?(?:\s+(.*))?$/);
    if (match) {
      return {
        command: (match[1] || 'help').toLowerCase(),
        args: (match[2] || '').trim(),
        raw: trimmed
      };
    }
  }
  return null;
}

export function isMaintainerAssociation(association) {
  if (!association || typeof association !== 'string') return false;
  return MAINTAINER_ASSOCIATIONS.has(association.trim().toUpperCase());
}

function resolveStateFilePath(options = {}) {
  if (typeof options === 'string' && options.trim()) {
    return options.trim();
  }
  return options?.stateFile || process.env.LIGHTS_ON_STATE_FILE || '/tmp/lights-on-cache/state.json';
}

export function loadState(options = {}) {
  const stateFile = resolveStateFilePath(options);
  const initial = createInitialState();

  if (!fs.existsSync(stateFile)) {
    return initial;
  }

  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = stripDangerousKeys(JSON.parse(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        (parsed.usage_history !== undefined && !Array.isArray(parsed.usage_history))) {
      throw new Error('Invalid state schema');
    }
    return {
      ...initial,
      ...parsed,
      last_run_by_task: { ...(parsed.last_run_by_task || {}) },
      ecosystem_cache: { ...(parsed.ecosystem_cache || {}) },
      cooldowns: { ...(parsed.cooldowns || {}) },
      processed_items: { ...(parsed.processed_items || {}) },
      usage_history: Array.isArray(parsed.usage_history) ? parsed.usage_history : []
    };
  } catch {
    throw new Error('Lights On state is unreadable or invalid; refusing to reset usage accounting. Inspect the state file before retrying.');
  }
}

export function saveState(state, options = {}) {
  const stateFile = resolveStateFilePath(options);
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });

  const updated = {
    ...createInitialState(),
    ...state,
    updated_at: new Date().toISOString()
  };

  const temporary = path.join(dir, `.lights-on-state-${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(updated, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // Keep the prior ledger intact if writing or replacement fails.
    fs.renameSync(temporary, stateFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return updated;
}

export function recordCooldown(state, key, reason, ttlHours = 168, now = Date.now()) {
  if (!state.cooldowns) state.cooldowns = {};
  const expiresAt = new Date(now + ttlHours * 3600 * 1000).toISOString();
  state.cooldowns[key] = {
    reason,
    recorded_at: new Date(now).toISOString(),
    expires_at: expiresAt
  };
  return state.cooldowns[key];
}

export function isOnCooldown(state, key, now = Date.now()) {
  const entry = state?.cooldowns?.[key];
  if (!entry) return false;
  if (!entry.expires_at) return true;
  const expiresMs = Date.parse(entry.expires_at);
  if (Number.isNaN(expiresMs)) return false;
  return now < expiresMs;
}

export function recordAttempt(state, itemKey, meta = {}) {
  if (!state.processed_items) state.processed_items = {};
  const prev = state.processed_items[itemKey] || { attempts: 0, history: [] };
  const attempts = (prev.attempts || 0) + 1;
  const nowIso = new Date().toISOString();

  state.processed_items[itemKey] = {
    ...prev,
    ...meta,
    attempts,
    last_attempt_at: nowIso,
    history: [
      ...(Array.isArray(prev.history) ? prev.history : []),
      { at: nowIso, ...meta }
    ]
  };
  return state.processed_items[itemKey];
}

export function getAttempts(state, itemKey) {
  return state?.processed_items?.[itemKey]?.attempts || 0;
}

export function recordUsage(state, { task = 'general', tokensUsed = null, costUsd = null, usage, outcome = 'completed', now = Date.now() } = {}) {
  if (!Array.isArray(state.usage_history)) {
    state.usage_history = [];
  }
  const cutoff48h = now - 48 * 3600 * 1000;
  state.usage_history = state.usage_history.filter((entry) => {
    const ts = Date.parse(entry?.at || '');
    return Number.isFinite(ts) && ts >= cutoff48h;
  });

  const normalized = normalizeUsage(usage || { total_tokens: tokensUsed, cost_usd: costUsd });
  const record = {
    at: new Date(now).toISOString(),
    task: String(task || 'general'),
    outcome,
    tokens_used: normalized.total_tokens,
    cost_usd: normalized.cost_usd,
    known_tokens_used: normalized.known_total_tokens,
    known_cost_usd: normalized.known_cost_usd,
    tokens_status: normalized.tokens_status,
    cost_source: normalized.cost_source,
    premium_requests: normalized.premium_requests,
    copilot_nano_aiu: normalized.copilot_nano_aiu,
    copilot_ai_credits_status: normalized.copilot_ai_credits_status,
    copilot_cli_invocations: normalized.copilot_cli_invocations,
    copilot_sdk_requests: normalized.copilot_sdk_requests,
    copilot_usage_reports: normalized.copilot_usage_reports
  };
  state.usage_history.push(record);
  return record;
}

export function checkBudgetAndRateLimits(state, config = {}, { task = 'general', itemKey = null, now = Date.now() } = {}) {
  const limits = config?.limits || {};
  const history = Array.isArray(state?.usage_history) ? state.usage_history : [];

  const oneHourAgo = now - 3600 * 1000;
  const oneDayAgo = now - 24 * 3600 * 1000;

  const runsLast24h = history.filter((e) => {
    const ts = Date.parse(e?.at || '');
    return Number.isFinite(ts) && ts >= oneDayAgo;
  });

  const issueResponsesLastHour = history.filter((e) => {
    const ts = Date.parse(e?.at || '');
    return Number.isFinite(ts) && ts >= oneHourAgo && e?.task === 'issue-responder';
  });

  const validCost = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const costTrackingComplete = runsLast24h.every((entry) => validCost(entry.cost_usd));
  const knownDailySpendUsd = runsLast24h.reduce((sum, e) =>
    sum + (validCost(e.known_cost_usd) ? e.known_cost_usd : validCost(e.cost_usd) ? e.cost_usd : 0), 0);
  const reservedDailyBudgetUsd = runsLast24h.reduce((sum, e) => sum + Math.max(0,
    (validCost(e.reserved_cost_usd) ? e.reserved_cost_usd : 0) -
    (validCost(e.known_cost_usd) ? e.known_cost_usd : validCost(e.cost_usd) ? e.cost_usd : 0)), 0);
  const budgetAccountedUsd = knownDailySpendUsd + reservedDailyBudgetUsd;
  const dailySpendUsd = costTrackingComplete ? knownDailySpendUsd : null;

  if (
    typeof limits.max_daily_budget_usd === 'number' &&
    limits.max_daily_budget_usd >= 0 &&
    budgetAccountedUsd >= limits.max_daily_budget_usd &&
    limits.max_daily_budget_usd > 0
  ) {
    return {
      allowed: false,
      reason: 'daily-budget-exceeded',
      details: { dailySpendUsd, knownDailySpendUsd, reservedDailyBudgetUsd, budgetAccountedUsd, costTrackingComplete, maxDailyBudgetUsd: limits.max_daily_budget_usd }
    };
  }
  if (limits.max_daily_budget_usd === 0) {
    return {
      allowed: false,
      reason: 'daily-budget-exceeded',
      details: { dailySpendUsd, maxDailyBudgetUsd: 0 }
    };
  }

  if (
    typeof limits.max_agent_runs_per_day === 'number' &&
    runsLast24h.length >= limits.max_agent_runs_per_day
  ) {
    return {
      allowed: false,
      reason: 'max-daily-runs-exceeded',
      details: { runsLast24h: runsLast24h.length, maxAgentRunsPerDay: limits.max_agent_runs_per_day }
    };
  }

  if (
    task === 'issue-responder' &&
    typeof limits.max_issue_responses_per_hour === 'number' &&
    issueResponsesLastHour.length >= limits.max_issue_responses_per_hour
  ) {
    return {
      allowed: false,
      reason: 'hourly-issue-rate-limit-exceeded',
      details: {
        issueResponsesLastHour: issueResponsesLastHour.length,
        maxIssueResponsesPerHour: limits.max_issue_responses_per_hour
      }
    };
  }

  if (itemKey && typeof limits.max_attempts_per_issue === 'number') {
    const attempts = getAttempts(state, itemKey);
    if (attempts >= limits.max_attempts_per_issue) {
      return {
        allowed: false,
        reason: 'max-attempts-per-item-exceeded',
        details: { itemKey, attempts, maxAttemptsPerIssue: limits.max_attempts_per_issue }
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    details: {
      runsLast24h: runsLast24h.length,
      issueResponsesLastHour: issueResponsesLastHour.length,
      dailySpendUsd,
      knownDailySpendUsd,
      reservedDailyBudgetUsd,
      budgetAccountedUsd,
      costTrackingComplete
    }
  };
}

export function recoverStateFromGitHubItems(state, items = []) {
  if (!state.cooldowns) state.cooldowns = {};
  if (!state.processed_items) state.processed_items = {};

  for (const item of items) {
    if (!item || item.number === undefined) continue;
    const itemKey = `${item.pull_request ? 'pr' : 'issue'}:${item.number}`;
    const labelNames = (item.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '')).filter(Boolean);

    if (labelNames.includes(LABELS.IGNORE) || labelNames.includes('wontfix')) {
      recordCooldown(state, itemKey, 'labeled_ignore_or_wontfix', 24 * 365);
    }

    const entriesToScan = [];
    if (isTrustedStateAuthor(item.user || item.author, item.author_association || item.authorAssociation)) {
      entriesToScan.push(item.body || '');
    }

    if (Array.isArray(item.comments)) {
      for (const c of item.comments) {
        if (!c || typeof c !== 'object') {
          continue;
        }
        if (isTrustedStateAuthor(c.user || c.author, c.author_association || c.authorAssociation)) {
          entriesToScan.push(c.body || '');
        }
      }
    }

    for (const text of entriesToScan) {
      const markerState = parseStateFromText(text);
      if (!markerState) continue;

      const existing = state.processed_items[itemKey] || { attempts: 0, history: [] };
      const markerAttempts = typeof markerState.attempts === 'number' ? markerState.attempts : existing.attempts;

      state.processed_items[itemKey] = stripDangerousKeys({
        ...existing,
        ...markerState,
        attempts: Math.max(existing.attempts || 0, markerAttempts || 0)
      });

      if (markerState.upstream_ref && typeof markerState.upstream_ref === 'string') {
        const upstreamKey = `upstream:${markerState.upstream_ref}`;
        state.processed_items[upstreamKey] = stripDangerousKeys({
          ...(state.processed_items[upstreamKey] || {}),
          ...markerState,
          local_issue_number: item.number,
          attempts: Math.max(1, markerAttempts || 1)
        });
      }

      if (markerState.dep_key && (labelNames.includes(LABELS.IGNORE) || labelNames.includes('wontfix'))) {
        recordCooldown(state, markerState.dep_key, 'dep_pr_ignored', 24 * 365);
      }

      if (markerState.cooldown_key && markerState.cooldown_reason) {
        recordCooldown(
          state,
          markerState.cooldown_key,
          markerState.cooldown_reason,
          markerState.cooldown_ttl_hours || 168
        );
      }
    }
  }

  return state;
}

function runCli() {
  const args = process.argv.slice(2);
  const state = loadState();

  const getIdx = args.indexOf('--get-cooldown');
  if (getIdx !== -1 && args[getIdx + 1]) {
    const key = args[getIdx + 1];
    console.log(JSON.stringify({ key, onCooldown: isOnCooldown(state, key), entry: state.cooldowns[key] || null }));
    return;
  }

  const setIdx = args.indexOf('--set-cooldown');
  if (setIdx !== -1 && args[setIdx + 1]) {
    const key = args[setIdx + 1];
    const reason = args[setIdx + 2] || 'manual_cli';
    recordCooldown(state, key, reason);
    saveState(state);
    console.log(JSON.stringify({ key, recorded: state.cooldowns[key] }));
    return;
  }

  const recoverIdx = args.indexOf('--recover');
  if (recoverIdx !== -1) {
    const inputFile = args[recoverIdx + 1];
    const items = inputFile && fs.existsSync(inputFile)
      ? JSON.parse(fs.readFileSync(inputFile, 'utf8'))
      : [];
    recoverStateFromGitHubItems(state, items);
    saveState(state);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (args.includes('--save')) {
    const saved = saveState(state);
    console.log(JSON.stringify(saved, null, 2));
    return;
  }

  console.log(JSON.stringify(state, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli();
}
