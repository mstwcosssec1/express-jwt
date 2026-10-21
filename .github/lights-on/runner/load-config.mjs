import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  events: { allow_external_triggers: false },
  engine: {
    provider: 'auto',
    copilot_backend: 'cli',
    models: {
      default: '',
      reasoning: ''
    },
    fallback_providers: []
  },
  threat_model: {
    path: 'THREAT_MODEL.md',
    generator_repo: 'https://github.com/alpha-omega-security/threat-model',
    triage_policy: 'relaxed'
  },
  upstream: {
    repo: 'auto',
    sync_issues: true,
    sync_prs: false,
    sync_threat_model_context: true,
    max_items_per_run: 3
  },
  autonomy: {
    mode: 'lights-on',
    allow_external_pr_automerge: false,
    allow_agent_pr_automerge: true,
    merge_method: 'squash',
    require_ci_pass: true,
    required_checks: [],
    require_independent_agent_review: true
  },
  policies: {
    block_automerge_on: [
      'breaking_public_api',
      'workflow_or_runner_modification',
      'new_unapproved_runtime_dependency',
      'threat_model_boundary_weakening'
    ],
    dependency_health: {
      stale_release_months: 24,
      min_maintainers: 1,
      auto_migrate_deprecated_or_archived: true,
      auto_migrate_unpatched_cve: true
    }
  },
  limits: {
    max_prs_per_run: 2,
    max_attempts_per_issue: 2,
    max_issue_responses_per_hour: 10,
    max_agent_runs_per_day: 25,
    max_turns_per_run: 25,
    max_tokens_per_run: 100000,
    max_cost_per_run_usd: 2.0,
    max_daily_budget_usd: 10.0,
    max_input_bytes: 262144,
    max_output_tokens: 8192,
    max_model_calls_per_run: 30
  },
  release: {
    enabled: true,
    auto_publish: true,
    max_auto_bump: 'minor',
    min_commits_for_release: 1,
    immediate_on_security: true,
    create_github_release: true,
    provenance: true,
    package_names: {}
  },
  dependencies: {
    update_max_turns: 8,
    migration_plan_max_turns: 12,
    migration_max_turns: 20,
    validation_commands: [],
    approved_migrations: []
  },
  toolchains: {
    enabled: false,
    node: {
      support_policy: 'supported',
      update_ci: true,
      update_runtime_files: true,
      build_files: []
    }
  }
};

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeObjectKey(key) {
  return typeof key === 'string' && key.length > 0 && !DANGEROUS_OBJECT_KEYS.has(key);
}

export function sanitizeGitHubOutputValue(val) {
  return String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
}

const PROVIDER_ORDER = ['copilot', 'claude', 'codex', 'openrouter'];

const PROVIDER_ENV_VARS = {
  copilot: 'COPILOT_GITHUB_TOKEN',
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
};

export const PROVIDER_DEFAULT_MODELS = {
  copilot: 'claude-sonnet-5.5',
  claude: 'claude-sonnet-5-5',
  codex: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5'
};

export const PROVIDER_REASONING_MODELS = {
  copilot: 'claude-opus-5.5',
  claude: 'claude-opus-5-5',
  codex: 'gpt-6-astra',
  openrouter: 'anthropic/claude-opus-5.5'
};

function escapedQuote(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !escapedQuote(raw, i)) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) {
        return raw.slice(0, i).trim();
      }
    }
  }
  return raw.trim();
}

function splitFlowItems(inner) {
  const items = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && !escapedQuote(inner, i)) {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') {
        depth++;
        current += ch;
      } else if (ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        if (current.trim().length > 0) {
          items.push(current.trim());
        }
        current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
}

function parseScalar(raw) {
  const val = stripInlineComment(raw);
  if (val === '') return '';
  if (val === 'true' || val === 'True' || val === 'TRUE') return true;
  if (val === 'false' || val === 'False' || val === 'FALSE') return false;
  if (val === 'null' || val === '~' || val === 'Null' || val === 'NULL') return null;

  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    const inner = val.slice(1, -1);
    return val.startsWith('"') ? JSON.parse(val) : inner.replace(/''/g, "'");
  }

  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowItems(inner).map((item) => parseScalar(item));
  }

  if (val.startsWith('{') && val.endsWith('}')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return {};
    const obj = {};
    for (const pair of splitFlowItems(inner)) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx !== -1) {
        const k = pair.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
        const v = pair.slice(colonIdx + 1).trim();
        if (isSafeObjectKey(k)) {
          if (Object.hasOwn(obj, k)) throw new Error(`Duplicate YAML key: ${k}`);
          obj[k] = parseScalar(v);
        }
      }
    }
    return obj;
  }

  if (/^-?\d+(\.\d+)?$/.test(val)) {
    return Number(val);
  }

  return val;
}

/**
 * Pure-JS parser for declarative YAML configuration files.
 * Supports comments (#), nested indentation maps, block lists (- item),
 * inline lists ([a, b]), inline maps ({ a: 1 }), booleans, numbers, and strings.
 */
export function parseSimpleYaml(text, { strict = false } = {}) {
  if (!text || typeof text !== 'string') return {};

  const rawLines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (strict && /^\s*\t/.test(rawLine)) throw new Error('YAML indentation must use spaces.');
    const indent = rawLine.match(/^(\s*)/)[1].length;
    lines.push({ indent, content: stripInlineComment(trimmed) });
  }

  function parseBlock(startIndex, minIndent) {
    if (startIndex >= lines.length) return { value: {}, nextIndex: startIndex };

    const first = lines[startIndex];
    if (first.indent < minIndent) {
      return { value: {}, nextIndex: startIndex };
    }

    const isArray = first.content === '-' || first.content.startsWith('- ');
    if (isArray) {
      const arr = [];
      let idx = startIndex;
      const blockIndent = first.indent;

      while (idx < lines.length) {
        const line = lines[idx];
        if (line.indent < blockIndent) break;
        if (line.indent > blockIndent) {
          if (strict) throw new Error('Unsupported YAML list indentation; use inline maps or a hyphen on its own line.');
          idx++;
          continue;
        }
        if (!(line.content === '-' || line.content.startsWith('- '))) break;

        const rest = line.content.slice(1).trim();
        if (!rest) {
          const nested = parseBlock(idx + 1, blockIndent + 1);
          arr.push(nested.value);
          idx = nested.nextIndex;
        } else {
          if (strict && /^[A-Za-z_][\w-]*\s*:/.test(rest)) {
            throw new Error('Use an inline YAML map or put the list hyphen on its own line.');
          }
          arr.push(parseScalar(rest));
          idx++;
        }
      }
      return { value: arr, nextIndex: idx };
    }

    const obj = {};
    let idx = startIndex;
    const blockIndent = first.indent;

    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < blockIndent) break;
      if (line.indent > blockIndent) {
        if (strict) throw new Error('Unsupported YAML indentation or multiline scalar.');
        idx++;
        continue;
      }
      if (line.content === '-' || line.content.startsWith('- ')) break;

      const colonIdx = line.content.indexOf(':');
      if (colonIdx === -1) {
        if (strict) throw new Error('Expected a YAML mapping entry.');
        idx++;
        continue;
      }

      const key = line.content.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
      const rest = line.content.slice(colonIdx + 1).trim();
      if (strict && Object.hasOwn(obj, key)) throw new Error(`Duplicate YAML key: ${key}`);

      if (!isSafeObjectKey(key)) {
        if (rest === '' && idx + 1 < lines.length && lines[idx + 1].indent > blockIndent) {
          const skipped = parseBlock(idx + 1, lines[idx + 1].indent);
          idx = skipped.nextIndex;
        } else {
          idx++;
        }
        continue;
      }

      if (rest === '') {
        if (idx + 1 < lines.length && lines[idx + 1].indent > blockIndent) {
          const nested = parseBlock(idx + 1, lines[idx + 1].indent);
          obj[key] = nested.value;
          idx = nested.nextIndex;
        } else {
          obj[key] = null;
          idx++;
        }
      } else {
        obj[key] = parseScalar(rest);
        idx++;
      }
    }

    return { value: obj, nextIndex: idx };
  }

  const parsed = parseBlock(0, 0);
  if (strict && parsed.nextIndex !== lines.length) throw new Error('Unsupported trailing YAML content.');
  return parsed.value;
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeObjectKey(key) || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      output[key] = [...value];
    } else if (
      typeof value === 'object' &&
      typeof output[key] === 'object' &&
      output[key] !== null &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function parseBoolOverride(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('Invalid boolean configuration override; use true/false or 1/0.');
}

function parseNumberOverride(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const num = Number(String(raw).trim());
  if (!Number.isFinite(num) || num < 0) throw new Error('Invalid numeric configuration override; use a finite nonnegative number.');
  return num;
}

function validateConfigTypes(value, defaults, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${prefix || 'Configuration'} must be a mapping.`);
  }
  for (const [key, expected] of Object.entries(defaults)) {
    if (!Object.hasOwn(value, key)) continue;
    const actual = value[key], name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) throw new Error(`${name} must be an array.`);
    } else if (typeof expected === 'object') {
      validateConfigTypes(actual, expected, name);
    } else if (typeof actual !== typeof expected || (typeof actual === 'number' && (!Number.isFinite(actual) || actual < 0))) {
      throw new Error(`${name} must be ${typeof expected === 'number' ? 'a finite nonnegative number' : `a ${typeof expected}`}.`);
    }
  }
}

export function loadConfig(options = {}, maybeEnv = undefined) {
  const normalizedOptions =
    typeof options === 'string'
      ? { repoRoot: options, ...(maybeEnv ? { env: maybeEnv } : {}) }
      : options || {};
  const { configPath, repoRoot = process.cwd(), env = process.env } = normalizedOptions;
  const resolvedPath = configPath || path.join(repoRoot, '.github', 'lights-on.yml');

  let config = structuredClone(DEFAULT_CONFIG);

  let rawText;
  try { rawText = fs.readFileSync(resolvedPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || configPath) throw new Error(`Cannot read Lights On configuration: ${resolvedPath}`, { cause: error });
  }
  if (rawText !== undefined) {
    const parsed = parseSimpleYaml(rawText, { strict: true });
    validateConfigTypes(parsed, DEFAULT_CONFIG);
    config = deepMerge(config, parsed);
  }

  const enabledOverride = parseBoolOverride(env.LIGHTS_ON_ENABLED);
  if (enabledOverride !== undefined) {
    config.enabled = enabledOverride;
  }

  const maxPrsPerRun = parseNumberOverride(env.LIGHTS_ON_MAX_PRS_PER_RUN);
  if (maxPrsPerRun !== undefined) config.limits.max_prs_per_run = maxPrsPerRun;

  const maxAttemptsPerIssue = parseNumberOverride(env.LIGHTS_ON_MAX_ATTEMPTS_PER_ISSUE);
  if (maxAttemptsPerIssue !== undefined) config.limits.max_attempts_per_issue = maxAttemptsPerIssue;

  const maxIssueResponsesPerHour = parseNumberOverride(env.LIGHTS_ON_MAX_ISSUE_RESPONSES_PER_HOUR);
  if (maxIssueResponsesPerHour !== undefined) config.limits.max_issue_responses_per_hour = maxIssueResponsesPerHour;

  const maxAgentRunsPerDay = parseNumberOverride(env.LIGHTS_ON_MAX_AGENT_RUNS_PER_DAY);
  if (maxAgentRunsPerDay !== undefined) config.limits.max_agent_runs_per_day = maxAgentRunsPerDay;

  const maxTurnsPerRun = parseNumberOverride(env.LIGHTS_ON_MAX_TURNS_PER_RUN);
  if (maxTurnsPerRun !== undefined) config.limits.max_turns_per_run = maxTurnsPerRun;

  const maxTokensPerRun = parseNumberOverride(env.LIGHTS_ON_MAX_TOKENS_PER_RUN);
  if (maxTokensPerRun !== undefined) config.limits.max_tokens_per_run = maxTokensPerRun;

  const maxCostPerRunUsd = parseNumberOverride(env.LIGHTS_ON_MAX_COST_PER_RUN_USD);
  if (maxCostPerRunUsd !== undefined) config.limits.max_cost_per_run_usd = maxCostPerRunUsd;

  const maxDailyBudgetUsd = parseNumberOverride(env.LIGHTS_ON_MAX_DAILY_BUDGET_USD);
  if (maxDailyBudgetUsd !== undefined) config.limits.max_daily_budget_usd = maxDailyBudgetUsd;

  if (env.LIGHTS_ON_PROVIDER && env.LIGHTS_ON_PROVIDER.trim() !== '') {
    config.engine.provider = env.LIGHTS_ON_PROVIDER.trim();
  }
  if (env.LIGHTS_ON_COPILOT_BACKEND !== undefined) config.engine.copilot_backend = env.LIGHTS_ON_COPILOT_BACKEND.trim();
  if (!['cli', 'sdk'].includes(config.engine.copilot_backend)) throw new Error('engine.copilot_backend must be cli or sdk.');

  if (env.LIGHTS_ON_MODEL && env.LIGHTS_ON_MODEL.trim() !== '') {
    config.engine.models.default = env.LIGHTS_ON_MODEL.trim();
  }

  if (env.LIGHTS_ON_REASONING_MODEL && env.LIGHTS_ON_REASONING_MODEL.trim() !== '') {
    config.engine.models.reasoning = env.LIGHTS_ON_REASONING_MODEL.trim();
  }

  if (env.LIGHTS_ON_MODE && env.LIGHTS_ON_MODE.trim() !== '') {
    config.autonomy.mode = env.LIGHTS_ON_MODE.trim();
  }

  const extAutomerge = parseBoolOverride(env.LIGHTS_ON_ALLOW_EXTERNAL_PR_AUTOMERGE);
  if (extAutomerge !== undefined) {
    config.autonomy.allow_external_pr_automerge = extAutomerge;
  }

  const agentAutomerge = parseBoolOverride(env.LIGHTS_ON_ALLOW_AGENT_PR_AUTOMERGE);
  if (agentAutomerge !== undefined) {
    config.autonomy.allow_agent_pr_automerge = agentAutomerge;
  }

  if (env.LIGHTS_ON_MERGE_METHOD && env.LIGHTS_ON_MERGE_METHOD.trim() !== '') {
    config.autonomy.merge_method = env.LIGHTS_ON_MERGE_METHOD.trim();
  }

  const releaseEnabled = parseBoolOverride(env.LIGHTS_ON_RELEASE_ENABLED);
  if (releaseEnabled !== undefined) {
    config.release.enabled = releaseEnabled;
  }

  const autoPublish = parseBoolOverride(env.LIGHTS_ON_AUTO_PUBLISH);
  if (autoPublish !== undefined) {
    config.release.auto_publish = autoPublish;
  }

  const createGithubRelease = parseBoolOverride(env.LIGHTS_ON_CREATE_GITHUB_RELEASE);
  if (createGithubRelease !== undefined) {
    config.release.create_github_release = createGithubRelease;
  }

  if (env.LIGHTS_ON_MAX_AUTO_BUMP && ['patch', 'minor'].includes(env.LIGHTS_ON_MAX_AUTO_BUMP.trim().toLowerCase())) {
    config.release.max_auto_bump = env.LIGHTS_ON_MAX_AUTO_BUMP.trim().toLowerCase();
  }

  if (env.LIGHTS_ON_UPSTREAM_REPO !== undefined) {
    config.upstream.repo = String(env.LIGHTS_ON_UPSTREAM_REPO).trim();
  }

  const upstreamSyncIssues = parseBoolOverride(env.LIGHTS_ON_UPSTREAM_SYNC_ISSUES);
  if (upstreamSyncIssues !== undefined) {
    config.upstream.sync_issues = upstreamSyncIssues;
  }

  const upstreamSyncPrs = parseBoolOverride(env.LIGHTS_ON_UPSTREAM_SYNC_PRS);
  if (upstreamSyncPrs !== undefined) {
    config.upstream.sync_prs = upstreamSyncPrs;
  }

  const upstreamSyncThreatModel = parseBoolOverride(env.LIGHTS_ON_UPSTREAM_SYNC_THREAT_MODEL_CONTEXT);
  if (upstreamSyncThreatModel !== undefined) {
    config.upstream.sync_threat_model_context = upstreamSyncThreatModel;
  }

  const upstreamMaxItems = parseNumberOverride(env.LIGHTS_ON_UPSTREAM_MAX_ITEMS_PER_RUN);
  if (upstreamMaxItems !== undefined) {
    config.upstream.max_items_per_run = upstreamMaxItems;
  }

  validateConfigTypes(config, DEFAULT_CONFIG);
  return config;
}

export function resolveProvider(config, env = process.env, tier = 'default') {
  const availableProviders = PROVIDER_ORDER.filter((p) => {
    const envVar = PROVIDER_ENV_VARS[p];
    return Boolean(env[envVar] && String(env[envVar]).trim() !== '');
  });

  const configuredProvider = (config?.engine?.provider || 'auto').trim().toLowerCase();
  let provider;

  if (!configuredProvider || configuredProvider === 'auto') {
    if (availableProviders.length > 0) {
      provider = availableProviders[0];
    } else {
      provider = 'copilot';
    }
  } else {
    provider = configuredProvider;
  }
  if (!PROVIDER_ORDER.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);

  const reasoningModel = config?.engine?.models?.reasoning?.trim();
  const defaultModel = config?.engine?.models?.default?.trim();
  let model = '';

  if (tier === 'reasoning') {
    if (reasoningModel) {
      model = reasoningModel;
    } else if (defaultModel) {
      model = defaultModel;
    } else {
      model = PROVIDER_REASONING_MODELS[provider] || PROVIDER_REASONING_MODELS.copilot;
    }
  } else if (defaultModel) {
    model = defaultModel;
  } else {
    model = PROVIDER_DEFAULT_MODELS[provider] || PROVIDER_DEFAULT_MODELS.copilot;
  }

  const apiKeyEnvVar = PROVIDER_ENV_VARS[provider] || 'COPILOT_GITHUB_TOKEN';
  const isConfigured = availableProviders.includes(provider);

  const configuredFallbacks = Array.isArray(config?.engine?.fallback_providers)
    ? config.engine.fallback_providers
    : [];
  const fallbackProviders = configuredFallbacks.length > 0
    ? [...new Set(configuredFallbacks.map((value) => {
        if (typeof value !== 'string' || !PROVIDER_ORDER.includes(value.trim().toLowerCase())) {
          throw new Error('Unsupported fallback provider.');
        }
        return value.trim().toLowerCase();
      }))].filter((p) => p !== provider)
    : availableProviders.filter((p) => p !== provider);

  return {
    provider,
    model,
    apiKeyEnvVar,
    isConfigured,
    availableProviders,
    fallbackProviders
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const config = loadConfig();
  const defaultResolution = resolveProvider(config, process.env, 'default');
  const reasoningResolution = resolveProvider(config, process.env, 'reasoning');

  if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    const lines = [
      `enabled=${Boolean(config.enabled !== false)}`,
      `provider=${sanitizeGitHubOutputValue(defaultResolution.provider)}`,
      `model=${sanitizeGitHubOutputValue(defaultResolution.model)}`,
      `reasoning_model=${sanitizeGitHubOutputValue(reasoningResolution.model)}`,
      `reasoningModel=${sanitizeGitHubOutputValue(reasoningResolution.model)}`,
      `copilot_backend=${config.engine.copilot_backend}`,
      `mode=${sanitizeGitHubOutputValue(config.autonomy.mode)}`,
      `allow_external_pr_automerge=${Boolean(config.autonomy.allow_external_pr_automerge)}`,
      `allowExternalPrAutomerge=${Boolean(config.autonomy.allow_external_pr_automerge)}`,
      `allow_agent_pr_automerge=${Boolean(config.autonomy.allow_agent_pr_automerge)}`,
      `allowAgentPrAutomerge=${Boolean(config.autonomy.allow_agent_pr_automerge)}`,
      `merge_method=${sanitizeGitHubOutputValue(config.autonomy.merge_method)}`,
      `mergeMethod=${sanitizeGitHubOutputValue(config.autonomy.merge_method)}`,
      `threat_model_path=${sanitizeGitHubOutputValue(config.threat_model.path)}`,
      `threatModelPath=${sanitizeGitHubOutputValue(config.threat_model.path)}`,
      `release_enabled=${Boolean(config.release?.enabled)}`,
      `releaseEnabled=${Boolean(config.release?.enabled)}`,
      `auto_publish=${Boolean(config.release?.auto_publish)}`,
      `autoPublish=${Boolean(config.release?.auto_publish)}`,
      `create_github_release=${Boolean(config.release?.create_github_release !== false)}`,
      `createGithubRelease=${Boolean(config.release?.create_github_release !== false)}`,
      `max_auto_bump=${sanitizeGitHubOutputValue(config.release?.max_auto_bump || 'minor')}`,
      `maxAutoBump=${sanitizeGitHubOutputValue(config.release?.max_auto_bump || 'minor')}`,
      `upstream_repo=${sanitizeGitHubOutputValue(config.upstream?.repo ?? 'auto')}`,
      `upstreamRepo=${sanitizeGitHubOutputValue(config.upstream?.repo ?? 'auto')}`,
      `upstream_sync_issues=${Boolean(config.upstream?.sync_issues !== false)}`,
      `upstreamSyncIssues=${Boolean(config.upstream?.sync_issues !== false)}`,
      `upstream_sync_prs=${Boolean(config.upstream?.sync_prs)}`,
      `upstreamSyncPrs=${Boolean(config.upstream?.sync_prs)}`,
      `upstream_sync_threat_model_context=${Boolean(config.upstream?.sync_threat_model_context !== false)}`,
      `upstreamSyncThreatModelContext=${Boolean(config.upstream?.sync_threat_model_context !== false)}`,
      `upstream_max_items_per_run=${Number(config.upstream?.max_items_per_run ?? 3)}`,
      `upstreamMaxItemsPerRun=${Number(config.upstream?.max_items_per_run ?? 3)}`
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }

  if (args.includes('--json') || !args.includes('--github-output')) {
    console.log(
      JSON.stringify(
        {
          config,
          resolved: {
            default: defaultResolution,
            reasoning: reasoningResolution
          }
        },
        null,
        2
      )
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli();
}
