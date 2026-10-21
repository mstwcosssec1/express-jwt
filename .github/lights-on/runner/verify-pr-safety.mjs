import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sanitizeGitHubOutputValue } from './load-config.mjs';
import { LABELS } from './state-store.mjs';

export const PROTECTED_PATH_PATTERNS = [
  /^\.git(\/|$)/i,
  /^\.github\/workflows(\/|$)/i,
  /^\.github\/lights-on(\/|$)/i,
  /^\.github\/lights-on\.ya?ml$/i,
  /^\.github\/actions(\/|$)/i,
  /^\.github\/skills(\/|$)/i,
  /^\.claude(\/|$)/i,
  /^(docs\/|\.github\/)?threat[_-]model\.(md|ya?ml|json)$/i,
  /^install\.(sh|ps1)$/i
];

export const DANGEROUS_DIFF_PATTERNS = [
  /curl\s+[^\n]*\|\s*(ba)?sh\b/i,
  /wget\s+[^\n]*\|\s*(ba)?sh\b/i,
  /\bsecrets\.[A-Za-z0-9_]+/,
  /process\.env\.(COPILOT_GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY)\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/
];

const DEFAULT_TRUSTED_BOT_AUTHORS = [
  'github-actions[bot]',
  'app/github-actions',
  'lights-on[bot]',
  'copilot-swe-agent[bot]',
  'app/copilot-swe-agent'
];

/**
 * Determines whether the PR author is a trusted autonomous agent or bot actor.
 */
export function isTrustedAgentAuthor(
  author,
  authorAssociation,
  trustedBotAuthors = DEFAULT_TRUSTED_BOT_AUTHORS
) {
  const login =
    typeof author === 'object' && author !== null ? author.login : author;
  if (!login || typeof login !== 'string') return false;

  const normalizedAuthor = login.trim().toLowerCase();
  const envBots = (process.env.LIGHTS_ON_BOT_ACTORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const trustedSet = new Set([
    ...(Array.isArray(trustedBotAuthors) ? trustedBotAuthors : DEFAULT_TRUSTED_BOT_AUTHORS).map(
      (b) => String(b).trim().toLowerCase()
    ),
    ...envBots
  ]);

  return trustedSet.has(normalizedAuthor);
}

function extractLabels(pr) {
  const rawLabels = Array.isArray(pr?.labels) ? pr.labels : [];
  return rawLabels
    .map((l) => (typeof l === 'string' ? l : l?.name || ''))
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeChangedFiles(changedFiles) {
  if (!Array.isArray(changedFiles)) return [];
  const extracted = [];
  for (const item of changedFiles) {
    if (typeof item === 'string') {
      extracted.push(item);
    } else if (item && typeof item === 'object') {
      if (item.filename || item.path) extracted.push(item.filename || item.path);
      if (item.previous_filename || item.previousFilename) {
        extracted.push(item.previous_filename || item.previousFilename);
      }

    }
  }
  return extracted
    .map((f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter(Boolean);
}

export function hasCompleteFileInventory(pr, changedFiles) {
  if (!pr || Array.isArray(pr) || !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
      !Number.isSafeInteger(pr.changed_files) || pr.changed_files <= 0 ||
      pr.changed_files > 3000 || !Array.isArray(changedFiles) ||
      changedFiles.length !== pr.changed_files) return false;
  const validPath = (value) => typeof value === 'string' && value.length > 0 &&
    !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '.' || !part) &&
    !/[\x00-\x1f\x7f]/.test(value);
  const names = [];
  for (const item of changedFiles) {
    const name = typeof item === 'string' ? item : item?.filename || item?.path;
    if (!validPath(name)) return false;
    if (item?.status === 'renamed' && !validPath(item.previous_filename || item.previousFilename)) return false;
    for (const previous of [item?.previous_filename, item?.previousFilename]) {
      if (previous !== undefined && !validPath(previous)) return false;
    }
    names.push(name);
  }
  return new Set(names).size === names.length;
}

/**
 * Evaluates deterministic pre-flight and post-review PR safety gates,
 * including external PR auto-merge policy enforcement.
 */
export function evaluatePrSafety({
  pr = {},
  changedFiles = [],
  diffText = '',
  reviewResult = null,
  ciStatus = 'pending',
  config,
  metadataInvalid = false
} = {}) {
  const resolvedConfig = config || loadConfig();
  const autonomy = {
    mode: 'lights-on',
    allow_external_pr_automerge: false,
    allow_agent_pr_automerge: true,
    require_ci_pass: true,
    require_independent_agent_review: true,
    merge_method: 'squash',
    ...(resolvedConfig?.autonomy || {})
  };

  const labelNames = extractLabels(pr);
  const labelSet = new Set(labelNames.map((l) => l.toLowerCase()));

  const isAgentPr = isTrustedAgentAuthor(pr?.user?.login, pr?.author_association);
  const isExternalPr = !isAgentPr;

  const hasExplicitAutomergeLabel = labelSet.has(LABELS.AUTOMERGE.toLowerCase());
  const hasApprovedOverrideLabel = labelSet.has(LABELS.APPROVED_OVERRIDE.toLowerCase());

  let safeToReview = true;
  let allowAutoMerge = true;
  let externalAutoMergeBlocked = false;
  let requiresHuman = false;
  const reasons = [];
  const recommendedLabels = new Set();

  if (pr?.draft === true) {
    allowAutoMerge = false;
    reasons.push('draft-pr');
  }

  if (metadataInvalid || !hasCompleteFileInventory(pr, changedFiles)) {
    safeToReview = false;
    allowAutoMerge = false;
    requiresHuman = true;
    reasons.push('missing-or-invalid-pr-metadata');
    recommendedLabels.add(LABELS.NEEDS_HUMAN);
  }

  // 1. Check enabled / per-PR pause label state
  if (resolvedConfig?.enabled === false || labelSet.has('lights-on:pause')) {
    safeToReview = false;
    allowAutoMerge = false;
    reasons.push('lights-on-disabled');
  }

  // 1b. Check autonomy mode (e.g., review-only or advisory disables auto-merge)
  if (String(autonomy.mode || 'lights-on').trim().toLowerCase() !== 'lights-on') {
    allowAutoMerge = false;
    reasons.push('mode-not-lights-on');
  }
  if (!['squash', 'merge'].includes(autonomy.merge_method)) {
    allowAutoMerge = false;
    requiresHuman = true;
    reasons.push('merge-method-not-safe-for-reference-isolation');
  }

  // 2. Check ignore / wontfix labels
  if (labelSet.has(LABELS.IGNORE.toLowerCase()) || labelSet.has('wontfix')) {
    safeToReview = false;
    allowAutoMerge = false;
    reasons.push('ignored-by-label');
  }

  // 3. Check hold label
  if (labelSet.has(LABELS.HOLD.toLowerCase())) {
    allowAutoMerge = false;
    reasons.push('held-by-label');
  }

  // 4. Check protected paths (can be overridden by a maintainer applying lights-on:approved-override)
  const normalizedFiles = normalizeChangedFiles(changedFiles);
  const touchesProtectedPath = normalizedFiles.some((filePath) =>
    PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(filePath))
  );
  if (touchesProtectedPath && !hasApprovedOverrideLabel) {
    allowAutoMerge = false;
    requiresHuman = true;
    reasons.push('protected-path-modified');
    recommendedLabels.add(LABELS.NEEDS_HUMAN);
  }

  // 5. Check dangerous diff patterns
  const rawDiff = typeof diffText === 'string' ? diffText : '';
  const hasDangerousDiff = DANGEROUS_DIFF_PATTERNS.some((pattern) => pattern.test(rawDiff));
  if (hasDangerousDiff) {
    allowAutoMerge = false;
    requiresHuman = true;
    reasons.push('dangerous-diff-pattern');
    recommendedLabels.add(LABELS.NEEDS_HUMAN);
  }

  // 6. Evaluate External PR Auto-Merge Policy
  if (isExternalPr && !autonomy.allow_external_pr_automerge && !hasExplicitAutomergeLabel) {
    allowAutoMerge = false;
    externalAutoMergeBlocked = true;
    reasons.push('external-pr-automerge-disabled');
    recommendedLabels.add(LABELS.AUTOMERGE_DISABLED_EXTERNAL);
  }

  // 7. Evaluate Agent PR Auto-Merge Policy
  if (isAgentPr && !autonomy.allow_agent_pr_automerge && !hasExplicitAutomergeLabel) {
    allowAutoMerge = false;
    reasons.push('agent-pr-automerge-disabled');
  }

  // 8. Evaluate 4-Gate Review Result when provided
  if (reviewResult && typeof reviewResult === 'object') {
    let reviewGatesPassed = true;
    if (reviewResult.status !== 'completed' || (reviewResult.dry_run !== undefined && reviewResult.dry_run !== false)) {
      allowAutoMerge = false;
      reviewGatesPassed = false;
      requiresHuman = true;
      reasons.push('review-not-completed');
      recommendedLabels.add(LABELS.NEEDS_HUMAN);
    }
    const verdict = String(reviewResult.verdict || '').toUpperCase();
    if (verdict !== 'APPROVE') {
      allowAutoMerge = false;
      reviewGatesPassed = false;
      requiresHuman = true;
      reasons.push('review-not-approved');
      recommendedLabels.add(LABELS.NEEDS_HUMAN);
    }

    if (reviewResult.breaking_api_change === true && !hasApprovedOverrideLabel) {
      allowAutoMerge = false;
      reviewGatesPassed = false;
      requiresHuman = true;
      reasons.push('breaking-api-change');
      recommendedLabels.add(LABELS.NEEDS_HUMAN);
    }

    const gates = reviewResult.gate_results || reviewResult.gates || {};
    const requiredGates = ['threat_model', 'intended_use', 'dependent_packages', 'tests'];
    for (const gateName of requiredGates) {
      const gateVal = gates[gateName];
      const normalizedGate = String(
        typeof gateVal === 'object' && gateVal !== null ? gateVal.status : gateVal || ''
      ).toLowerCase();
      if (normalizedGate !== 'pass') {
        allowAutoMerge = false;
        reviewGatesPassed = false;
        requiresHuman = true;
        reasons.push(`gate-failed:${gateName}`);
        recommendedLabels.add(LABELS.NEEDS_HUMAN);
      }
    }

    if (autonomy.require_ci_pass !== false && String(ciStatus).toLowerCase() !== 'success') {
      allowAutoMerge = false;
      reasons.push('ci-not-passing');
    }

    if (reviewGatesPassed && (!touchesProtectedPath || hasApprovedOverrideLabel) && !hasDangerousDiff) {
      recommendedLabels.add(LABELS.APPROVED);
      recommendedLabels.add(LABELS.REVIEWED);
    }
  } else {
    if (autonomy.require_independent_agent_review !== false) {
      allowAutoMerge = false;
      requiresHuman = true;
      reasons.push('review-missing');
    }
    if (autonomy.require_ci_pass !== false && String(ciStatus).toLowerCase() !== 'success') {
      allowAutoMerge = false;
      reasons.push('ci-not-passing');
    }
  }

  return {
    safeToReview,
    allowAutoMerge,
    isAgentPr,
    isExternalPr,
    externalAutoMergeBlocked,
    requiresHuman,
    reasons,
    recommendedLabels: Array.from(recommendedLabels),
    mergeMethod: autonomy.merge_method || 'squash'
  };
}

export function parseJsonOrPaginatedArray(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error('Empty JSON input');
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(Array.isArray)) {
      return parsed.flat();
    }
    return parsed;
  } catch (err) {
    // Support concatenated JSON arrays emitted by `gh api --paginate` without `--slurp` (e.g., `[{...}][{...}]`)
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && /\][\s\r\n]*\[/.test(trimmed)) {
      const normalized = `[${trimmed.replace(/\][\s\r\n]*\[/g, '],[')}]`;
      const pages = JSON.parse(normalized);
      return Array.isArray(pages) ? pages.flat() : pages;
    }
    throw err;
  }
}

function readJsonFileSafe(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return parseJsonOrPaginatedArray(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runCli() {
  const args = process.argv.slice(2);
  let prFile = null;
  let filesFile = null;
  let diffFile = null;
  let reviewFile = null;
  let ciStatus = 'pending';
  let githubOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr-file' && args[i + 1]) {
      prFile = path.resolve(args[++i]);
    } else if (args[i] === '--files-file' && args[i + 1]) {
      filesFile = path.resolve(args[++i]);
    } else if (args[i] === '--diff-file' && args[i + 1]) {
      diffFile = path.resolve(args[++i]);
    } else if (args[i] === '--review-file' && args[i + 1]) {
      reviewFile = path.resolve(args[++i]);
    } else if (args[i] === '--ci-status' && args[i + 1]) {
      ciStatus = args[++i];
    } else if (args[i] === '--github-output') {
      githubOutput = true;
    }
  }

  const SENTINEL = Symbol('invalid');
  const pr = readJsonFileSafe(prFile, SENTINEL);
  const changedFiles = readJsonFileSafe(filesFile, SENTINEL);
  const metadataInvalid =
    pr === SENTINEL ||
    changedFiles === SENTINEL ||
    !pr ||
    typeof pr !== 'object' ||
    Array.isArray(pr) ||
    !Array.isArray(changedFiles);

  const diffText = diffFile && fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : '';
  const reviewResult = reviewFile && fs.existsSync(reviewFile) ? readJsonFileSafe(reviewFile, null) : null;
  const config = loadConfig();

  const result = evaluatePrSafety({
    pr: metadataInvalid ? {} : pr,
    changedFiles: metadataInvalid ? [] : changedFiles,
    diffText,
    reviewResult,
    ciStatus,
    config,
    metadataInvalid
  });

  if (githubOutput && process.env.GITHUB_OUTPUT) {
    const lines = [
      `safeToReview=${result.safeToReview}`,
      `safe_to_review=${result.safeToReview}`,
      `allowAutoMerge=${result.allowAutoMerge}`,
      `allow_auto_merge=${result.allowAutoMerge}`,
      `isAgentPr=${result.isAgentPr}`,
      `is_agent_pr=${result.isAgentPr}`,
      `isExternalPr=${result.isExternalPr}`,
      `is_external_pr=${result.isExternalPr}`,
      `externalAutoMergeBlocked=${result.externalAutoMergeBlocked}`,
      `external_auto_merge_blocked=${result.externalAutoMergeBlocked}`,
      `requiresHuman=${result.requiresHuman}`,
      `requires_human=${result.requiresHuman}`,
      `mergeMethod=${sanitizeGitHubOutputValue(result.mergeMethod)}`,
      `merge_method=${sanitizeGitHubOutputValue(result.mergeMethod)}`,
      `reasons=${sanitizeGitHubOutputValue(JSON.stringify(result.reasons))}`,
      `recommendedLabels=${sanitizeGitHubOutputValue(JSON.stringify(result.recommendedLabels))}`
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }

  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
