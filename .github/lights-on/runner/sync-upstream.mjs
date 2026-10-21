#!/usr/bin/env node
/**
 * Lights On — Upstream Repository Discovery, Read-Only Context Mining & Issue Mirroring
 *
 * Supports the "fork / stewardship takeover" scenario where an upstream project
 * (e.g. `github.com/foo/bar`) is unmaintained and Lights On is installed in a fork
 * or successor repository (e.g. `github.com/baz/bar`).
 *
 * SECURITY INVARIANT:
 * Lights On MUST NEVER write to any repository other than the one it is installed in
 * (`installedRepo` / `GITHUB_REPOSITORY`), including `upstreamRepo`. All interactions
 * with `upstreamRepo` are strictly read-only (`GET`) requests, and upstream issue/PR
 * externally sourced comments/bodies are published as safely fenced literal text
 * rather than parsed Markdown links, including entity-encoded references.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from './github-io.mjs';
import { literalPublicationBody } from './publication-text.mjs';
import { fileURLToPath } from 'node:url';

import { loadConfig, sanitizeGitHubOutputValue } from './load-config.mjs';
import { reportWorkflowEvent, githubItemUrl } from './workflow-report.mjs';
import {
  LABELS,
  isMaintainerAssociation,
  isTrustedStateAuthor,
  formatStateComment,
  parseStateFromText,
  loadState,
  saveState
} from './state-store.mjs';

export const SAFE_REPO_FULL_NAME_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Validate and normalize an `owner/repo` string. Returns null if invalid.
 */
export function normalizeRepoFullName(repo) {
  if (!repo || typeof repo !== 'string') return null;
  let cleaned = repo.trim();
  cleaned = cleaned
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!SAFE_REPO_FULL_NAME_REGEX.test(cleaned)) {
    return null;
  }
  const [owner, name] = cleaned.split('/');
  if (!owner || !name || owner === '.' || owner === '..' || name === '.' || name === '..') {
    return null;
  }
  return `${owner}/${name}`;
}

/**
 * Extract `owner/repo` from a git remote URL if it points to GitHub.
 */
export function parseGitHubRepoFromRemoteUrl(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (httpsMatch && httpsMatch[1]) {
    return normalizeRepoFullName(httpsMatch[1]);
  }
  return null;
}

/**
 * Guard that throws an error if a write operation targets any repository other than
 * the repository where Lights On is installed (`installedRepo`), or if it targets `upstreamRepo`.
 */
export function assertWriteTargetIsInstalledRepo(targetRepo, installedRepo, upstreamRepo = null) {
  const normInstalled = normalizeRepoFullName(installedRepo);
  if (!normInstalled) {
    throw new Error(
      `REPO_WRITE_VIOLATION: Installed repository "${installedRepo ?? ''}" is not a valid owner/repo identifier.`
    );
  }
  const normTarget = normalizeRepoFullName(targetRepo);
  if (!normTarget) {
    throw new Error(
      `REPO_WRITE_VIOLATION: Write target repository "${targetRepo ?? ''}" is not a valid owner/repo identifier.`
    );
  }
  if (normTarget.toLowerCase() !== normInstalled.toLowerCase()) {
    throw new Error(
      `REPO_WRITE_VIOLATION: Refusing to write to external/upstream repository "${normTarget}". Writes are strictly restricted to installed repository "${normInstalled}".`
    );
  }
  const normUpstream = normalizeRepoFullName(upstreamRepo);
  if (normUpstream && normTarget.toLowerCase() === normUpstream.toLowerCase()) {
    throw new Error(
      `REPO_WRITE_VIOLATION: Refusing to write to upstream repository "${normUpstream}".`
    );
  }
  return normInstalled;
}

/**
 * Guard that verifies a request to an upstream or external repository uses a read-only HTTP method.
 */
export function assertReadOnlyUpstreamRequest(methodOrTarget = 'GET', targetOrMethod, installedRepo) {
  let method = 'GET';
  let targetRepo = targetOrMethod;
  const firstUpper = String(methodOrTarget || '').trim().toUpperCase();
  if (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(firstUpper)) {
    method = firstUpper;
    targetRepo = targetOrMethod;
  } else {
    targetRepo = methodOrTarget;
    method = String(targetOrMethod || 'GET').trim().toUpperCase();
  }

  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error(
      `REPO_WRITE_VIOLATION: Upstream read-only violation — refusing non-read-only HTTP method "${method}" against repository "${targetRepo ?? 'unknown'}" (installed repository: "${installedRepo ?? 'unknown'}").`
    );
  }
  const urlRepoMatch = String(targetRepo || '').match(/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  const normTarget = normalizeRepoFullName(urlRepoMatch ? urlRepoMatch[1] : targetRepo);
  if (!normTarget) {
    throw new Error(`Invalid upstream repository identifier: "${targetRepo ?? ''}"`);
  }
  return normTarget;
}

/**
 * Inspect a shell command string (e.g. from an LLM tool call) and block any attempt to
 * push git commits or execute mutating GitHub CLI / API calls against any repository
 * other than `installedRepo`.
 */
export function validateCommandRepoIsolation(
  command,
  { installedRepo = process.env.GITHUB_REPOSITORY || '', upstreamRepo = process.env.LIGHTS_ON_UPSTREAM_REPO || '' } = {}
) {
  const raw = String(command || '');
  const normInstalled = normalizeRepoFullName(installedRepo);
  const normUpstream = normalizeRepoFullName(upstreamRepo);

  // 0. Block tampering with git hooks/config, git remotes, GH_REPO env override, or GitHub Actions control files
  if (/(?:^|[\s;&|])GH_REPO\s*=/i.test(raw)) {
    return {
      allowed: false,
      reason: 'REPO_WRITE_VIOLATION: Overriding GH_REPO in shell commands is forbidden.'
    };
  }
  if (/\bgit\s+remote\s+(?:add|set-url)\b/i.test(raw)) {
    return {
      allowed: false,
      reason: 'REPO_WRITE_VIOLATION: Modifying git remotes (git remote add / set-url) is forbidden.'
    };
  }
  if (/(?:^|[\s"'/\\])\.git[\/\\](?:hooks|config)\b/i.test(raw) || /\bgit\s+config\b/i.test(raw)) {
    return {
      allowed: false,
      reason: 'REPO_WRITE_VIOLATION: Modifying .git/hooks or .git/config is forbidden.'
    };
  }
  if (/\bGITHUB_(?:ENV|PATH|OUTPUT|STEP_SUMMARY)\b/.test(raw)) {
    return {
      allowed: false,
      reason: 'REPO_WRITE_VIOLATION: Accessing GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, or GITHUB_STEP_SUMMARY is forbidden.'
    };
  }

  // 1. Block git push to upstream remote or any explicit GitHub URL not matching installedRepo
  if (/\bgit\s+push\b/i.test(raw)) {
    if (/\bgit\s+push\s+(?:-[A-Za-z0-9-]+\s+)*upstream\b/i.test(raw)) {
      return {
        allowed: false,
        reason: 'REPO_WRITE_VIOLATION: git push to "upstream" remote is forbidden.'
      };
    }
    const urlMatches = raw.match(/(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=\s|$|["'])/gi) || [];
    for (const m of urlMatches) {
      const repoInUrl = parseGitHubRepoFromRemoteUrl(m);
      if (repoInUrl && normInstalled && repoInUrl.toLowerCase() !== normInstalled.toLowerCase()) {
        return {
          allowed: false,
          reason: `REPO_WRITE_VIOLATION: git push to external repository "${repoInUrl}" is forbidden (installed repo: "${normInstalled}").`
        };
      }
      if (repoInUrl && normUpstream && repoInUrl.toLowerCase() === normUpstream.toLowerCase()) {
        return {
          allowed: false,
          reason: `REPO_WRITE_VIOLATION: git push to upstream repository "${repoInUrl}" is forbidden.`
        };
      }
    }
  }

  // 2. Block mutating `gh` CLI commands targeting another repository via any -R / --repo flag
  const ghMutatingSubcommands = /\bgh\s+(?:issue|pr|release|label|repo)\s+(?:create|edit|comment|close|reopen|merge|review|ready|delete|lock|unlock|transfer|pin|unpin|fork|archive|rename)\b/i;
  const repoFlagRegex = /(?:^|\s)(?:-R|--repo)(?:=|\s*)["']?(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)["']?(?=\s|$|;|&&|\|\|)/gi;
  for (const match of raw.matchAll(repoFlagRegex)) {
    const flaggedRepo = normalizeRepoFullName(match[1]);
    if (flaggedRepo && ghMutatingSubcommands.test(raw)) {
      if ((normInstalled && flaggedRepo.toLowerCase() !== normInstalled.toLowerCase()) ||
          (normUpstream && flaggedRepo.toLowerCase() === normUpstream.toLowerCase())) {
        return {
          allowed: false,
          reason: `REPO_WRITE_VIOLATION: Mutating gh command targeting "${flaggedRepo}" is forbidden (installed repo: "${normInstalled || 'local'}").`
        };
      }
    }
  }

  // 3. Block `gh api graphql` mutations and mutating `gh api` / `curl` calls against repos/<other>/...
  if (/\bgh\s+api\s+graphql\b/i.test(raw) && /\bmutation\b/i.test(raw)) {
    return {
      allowed: false,
      reason: 'REPO_WRITE_VIOLATION: GraphQL mutations via gh api graphql are forbidden in agent commands.'
    };
  }

  const apiRepoMatches = raw.match(/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi) || [];
  if (apiRepoMatches.length > 0) {
    const hasMutatingFlag =
      /(?:^|\s)(?:-X|--method|--request)(?:=|\s*)["']?(?:POST|PUT|PATCH|DELETE)\b/i.test(raw) ||
      /(?:^|\s)(?:-f|-F|--field|--raw-field|--input|-d|--data|--data-raw|--data-binary)(?:=|\S|\s)/.test(raw);
    if (hasMutatingFlag) {
      for (const apiMatch of apiRepoMatches) {
        const targetRepo = normalizeRepoFullName(apiMatch.replace(/^repos\//i, ''));
        if (targetRepo) {
          if ((normInstalled && targetRepo.toLowerCase() !== normInstalled.toLowerCase()) ||
              (normUpstream && targetRepo.toLowerCase() === normUpstream.toLowerCase())) {
            return {
              allowed: false,
              reason: `REPO_WRITE_VIOLATION: Mutating API request targeting "repos/${targetRepo}" is forbidden (installed repo: "${normInstalled || 'local'}").`
            };
          }
        }
      }
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Format a reference for display. The final publisher must still render the
 * complete body as literal text to prevent cross-repository backlinks.
 */
export function formatSafeUpstreamRef(upstreamRepo, number) {
  const norm = normalizeRepoFullName(upstreamRepo) || String(upstreamRepo || '').trim();
  return `\`${norm}#${Number(number)}\``;
}

/** Legacy helper name: preserve external content as literal Markdown, not parsed links. */
export function neutralizeCrossRepoAutoLinks(
  text,
  upstreamRepo,
  { installedRepo = process.env.GITHUB_REPOSITORY || '' } = {}
) {
  if (!text || typeof text !== 'string') return '';
  return literalPublicationBody(text);
}

async function fetchGitHubApiGet(endpointPath, { token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Upstream discovery requires a fetch implementation.');
  }
  const cleanPath = String(endpointPath || '').replace(/^\/+/, '');
  const url = cleanPath.startsWith('https://') ? cleanPath : `https://api.github.com/${cleanPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lights-on-maintenance-agent/1.0'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Upstream request failed (HTTP ${res.status}): ${cleanPath}`);
  return res.json();
}

/**
 * Resolve the installed repository and the upstream repository (if any).
 * Supports:
 * - Explicit `upstream.repo: "owner/repo"` or `LIGHTS_ON_UPSTREAM_REPO="owner/repo"`
 * - Auto-detection (`upstream.repo: "auto"`) via event payload `.repository.parent.full_name`,
 *   GitHub REST API (`GET /repos/{installedRepo}` -> `.parent.full_name`), or git `upstream` remote.
 */
export async function resolveUpstreamRepo({
  config,
  env = process.env,
  repoRoot = process.cwd(),
  eventPayload = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot, env });

  // 1. Determine eventPayload (explicit or from GITHUB_EVENT_PATH)
  let resolvedEventPayload = eventPayload;
  if (!resolvedEventPayload && env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      resolvedEventPayload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {}
  }

  // 2. Determine installedRepo
  let installedRepo = normalizeRepoFullName(env.GITHUB_REPOSITORY);
  if (!installedRepo && resolvedEventPayload?.repository?.full_name) {
    installedRepo = normalizeRepoFullName(resolvedEventPayload.repository.full_name);
  }
  if (!installedRepo) {
    try {
      const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      installedRepo = parseGitHubRepoFromRemoteUrl(originUrl);
    } catch {}
  }

  const rawSetting = String(
    env.LIGHTS_ON_UPSTREAM_REPO !== undefined
      ? env.LIGHTS_ON_UPSTREAM_REPO
      : resolvedConfig?.upstream?.repo ?? 'auto'
  ).trim();

  const lower = rawSetting.toLowerCase();
  if (!rawSetting || lower === 'none' || lower === 'false' || lower === 'off' || lower === 'disabled') {
    return {
      installedRepo,
      upstreamRepo: null,
      source: 'disabled'
    };
  }

  if (lower !== 'auto') {
    const explicitRepo = normalizeRepoFullName(rawSetting);
    if (!explicitRepo) {
      throw new Error('Invalid upstream.repo; use owner/repo, auto or none.');
    }
    if (installedRepo && explicitRepo.toLowerCase() === installedRepo.toLowerCase()) {
      return {
        installedRepo,
        upstreamRepo: null,
        source: 'same-as-installed'
      };
    }
    return {
      installedRepo,
      upstreamRepo: explicitRepo,
      source: 'config'
    };
  }

  // Auto-detect from eventPayload first
  const eventParent =
    normalizeRepoFullName(resolvedEventPayload?.repository?.parent?.full_name) ||
    normalizeRepoFullName(resolvedEventPayload?.repository?.source?.full_name);
  if (eventParent && (!installedRepo || eventParent.toLowerCase() !== installedRepo.toLowerCase())) {
    return {
      installedRepo,
      upstreamRepo: eventParent,
      source: 'github-event-fork-parent'
    };
  }

  // Auto-detect from git `upstream` remote if present
  try {
    const upstreamRemoteUrl = execFileSync('git', ['remote', 'get-url', 'upstream'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const gitUpstream = parseGitHubRepoFromRemoteUrl(upstreamRemoteUrl);
    if (gitUpstream && (!installedRepo || gitUpstream.toLowerCase() !== installedRepo.toLowerCase())) {
      return {
        installedRepo,
        upstreamRepo: gitUpstream,
        source: 'git-upstream-remote'
      };
    }
  } catch {}

  // Auto-detect from GitHub REST API (GET /repos/{installedRepo})
  if (installedRepo) {
    const repoMeta = await fetchGitHubApiGet(`repos/${installedRepo}`, {
      token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
      fetchImpl
    });
    const apiParent =
      normalizeRepoFullName(repoMeta?.parent?.full_name) ||
      normalizeRepoFullName(repoMeta?.source?.full_name);
    if (apiParent && apiParent.toLowerCase() !== installedRepo.toLowerCase()) {
      return {
        installedRepo,
        upstreamRepo: apiParent,
        source: 'api-fork-parent'
      };
    }
  }

  return {
    installedRepo,
    upstreamRepo: null,
    source: 'none'
  };
}

/**
 * Fetch a read-only snapshot of upstream repository context (maintainer issue rulings,
 * open issues, recent pull requests, and releases) for THREAT_MODEL.md bootstrapping
 * and documentation clarification.
 */
export async function fetchUpstreamContext({
  upstreamRepo,
  installedRepo,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
  fetchImpl = globalThis.fetch,
  maxIssues = 30,
  maxPrs = 15
} = {}) {
  const validUpstream = assertReadOnlyUpstreamRequest('GET', upstreamRepo, installedRepo);
  if (installedRepo && validUpstream.toLowerCase() === normalizeRepoFullName(installedRepo)?.toLowerCase()) {
    throw new Error(`Upstream repository "${validUpstream}" cannot be identical to installed repository "${installedRepo}".`);
  }

  const [repoMeta, rawIssues, rawClosedIssues, rawPrs, rawReleases] = await Promise.all([
    fetchGitHubApiGet(`repos/${validUpstream}`, { token, fetchImpl }),
    fetchGitHubApiGet(`repos/${validUpstream}/issues?state=open&per_page=${Math.min(100, Math.max(1, maxIssues))}&sort=updated&direction=desc`, { token, fetchImpl }),
    fetchGitHubApiGet(`repos/${validUpstream}/issues?state=closed&per_page=20&sort=updated&direction=desc`, { token, fetchImpl }),
    fetchGitHubApiGet(`repos/${validUpstream}/pulls?state=open&per_page=${Math.min(50, Math.max(1, maxPrs))}&sort=updated&direction=desc`, { token, fetchImpl }),
    fetchGitHubApiGet(`repos/${validUpstream}/releases?per_page=5`, { token, fetchImpl })
  ]);
  if (!repoMeta || repoMeta.full_name?.toLowerCase() !== validUpstream.toLowerCase() ||
      ![rawIssues, rawClosedIssues, rawPrs, rawReleases].every(Array.isArray)) {
    throw new Error('Incomplete upstream snapshot; refusing to report empty issue/PR lists.');
  }

  const openIssues = (Array.isArray(rawIssues) ? rawIssues : [])
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: String(item.title || ''),
      body: String(item.body || '').slice(0, 4000),
      state: item.state || 'open',
      author: item.user?.login || 'unknown',
      author_association: item.author_association || 'NONE',
      labels: Array.isArray(item.labels) ? item.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
      created_at: item.created_at || null,
      updated_at: item.updated_at || null,
      comments_count: item.comments || 0,
      upstream_ref: `${validUpstream}#${item.number}`
    }));

  const maintainerRulings = (Array.isArray(rawClosedIssues) ? rawClosedIssues : [])
    .filter(
      (item) =>
        !item.pull_request &&
        isMaintainerAssociation(item.author_association || item.authorAssociation)
    )
    .map((item) => ({
      number: item.number,
      title: String(item.title || ''),
      author: item.user?.login || 'unknown',
      author_association: item.author_association || item.authorAssociation || 'NONE',
      state_reason: item.state_reason || null,
      labels: Array.isArray(item.labels) ? item.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
      body_excerpt: String(item.body || '').slice(0, 1000),
      closed_at: item.closed_at || null,
      upstream_ref: `${validUpstream}#${item.number}`
    }));

  const openPullRequests = (Array.isArray(rawPrs) ? rawPrs : []).map((pr) => ({
    number: pr.number,
    title: String(pr.title || ''),
    body: String(pr.body || '').slice(0, 3000),
    author: pr.user?.login || 'unknown',
    head_sha: pr.head?.sha || null,
    created_at: pr.created_at || null,
    updated_at: pr.updated_at || null,
    upstream_ref: `${validUpstream}#${pr.number}`
  }));

  const recentReleases = (Array.isArray(rawReleases) ? rawReleases : []).map((rel) => ({
    tag_name: rel.tag_name || '',
    name: rel.name || '',
    published_at: rel.published_at || null,
    body_excerpt: String(rel.body || '').slice(0, 1500)
  }));

  return {
    installedRepo: normalizeRepoFullName(installedRepo) || null,
    upstreamRepo: validUpstream,
    fetchedAt: new Date().toISOString(),
    readOnlyGuarantee: `Strictly read-only GET from upstream (${validUpstream}); all writes restricted to installed repository (${installedRepo || 'local'})`,
    repository: repoMeta
      ? {
          full_name: repoMeta.full_name || validUpstream,
          description: repoMeta.description || '',
          default_branch: repoMeta.default_branch || 'main',
          archived: Boolean(repoMeta.archived),
          pushed_at: repoMeta.pushed_at || null,
          topics: Array.isArray(repoMeta.topics) ? repoMeta.topics : []
        }
      : { full_name: validUpstream },
    openIssues,
    maintainerRulings,
    openPullRequests,
    recentReleases
  };
}

/**
 * Filter upstream open issues (and optionally PRs) to identify items that have not yet
 * been mirrored or addressed in `installedRepo`.
 */
export function selectUnsyncedUpstreamItems({
  upstreamContext,
  state,
  existingLocalItems = [],
  maxItems = 3,
  syncIssues = true,
  syncPrs = false
} = {}) {
  if (!upstreamContext || !upstreamContext.upstreamRepo) {
    return [];
  }
  const upstreamRepo = upstreamContext.upstreamRepo;
  const processedMap = state?.processed_items || {};

  // Build set of upstream_refs already present in local issues/PRs via <!-- lights-on-state: ... -->
  const knownUpstreamRefs = new Set();
  for (const [key, entry] of Object.entries(processedMap)) {
    if (key.startsWith(`upstream:${upstreamRepo}#`) && entry) {
      knownUpstreamRefs.add(key.slice('upstream:'.length).toLowerCase());
    }
    if (entry?.upstream_ref) {
      knownUpstreamRefs.add(String(entry.upstream_ref).toLowerCase());
    }
  }

  for (const localItem of Array.isArray(existingLocalItems) ? existingLocalItems : []) {
    if (
      isTrustedStateAuthor(
        localItem?.user || localItem?.author,
        localItem?.author_association || localItem?.authorAssociation
      )
    ) {
      const parsedBodyState = parseStateFromText(localItem?.body || '');
      if (parsedBodyState?.upstream_ref) {
        knownUpstreamRefs.add(String(parsedBodyState.upstream_ref).toLowerCase());
      }
    }
    const comments = Array.isArray(localItem?.comments) ? localItem.comments : [];
    for (const c of comments) {
      if (
        isTrustedStateAuthor(
          c?.user || c?.author,
          c?.author_association || c?.authorAssociation
        )
      ) {
        const parsedCommentState = parseStateFromText(c?.body || '');
        if (parsedCommentState?.upstream_ref) {
          knownUpstreamRefs.add(String(parsedCommentState.upstream_ref).toLowerCase());
        }
      }
    }
  }

  const candidates = [];
  if (syncIssues && Array.isArray(upstreamContext.openIssues)) {
    for (const issue of upstreamContext.openIssues) {
      const ref = `${upstreamRepo}#${issue.number}`;
      if (!knownUpstreamRefs.has(ref.toLowerCase())) {
        candidates.push({ kind: 'issue', ...issue, upstream_ref: ref });
      }
    }
  }

  if (syncPrs && Array.isArray(upstreamContext.openPullRequests)) {
    for (const pr of upstreamContext.openPullRequests) {
      const ref = `${upstreamRepo}#${pr.number}`;
      if (!knownUpstreamRefs.has(ref.toLowerCase())) {
        candidates.push({ kind: 'pull_request', ...pr, upstream_ref: ref });
      }
    }
  }

  const cap = Number(maxItems);
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('upstream.max_items_per_run must be a nonnegative integer.');
  return candidates.slice(0, cap);
}

/**
 * Build a local tracking issue title and body to be created ONLY in `installedRepo`
 * for an upstream issue/PR. Final reference isolation belongs to the publisher.
 */
export function buildLocalUpstreamTrackingIssue(item, { upstreamRepo, installedRepo }) {
  assertWriteTargetIsInstalledRepo(installedRepo, installedRepo, upstreamRepo);
  const safeRef = formatSafeUpstreamRef(upstreamRepo, item.number);
  const kindLabel = item.kind === 'pull_request' ? 'PR' : 'Issue';
  const cleanTitle = String(item.title || `Upstream ${kindLabel} #${item.number}`)
    .replace(/[\r\n]+/g, ' ')
    .trim();

  const title = `[Upstream ${upstreamRepo}#${item.number}] ${cleanTitle}`.slice(0, 240);
  const sanitizedBody = neutralizeCrossRepoAutoLinks(String(item.body || '(No description provided.)'), upstreamRepo);

  const upstreamPath = item.kind === 'pull_request' ? 'pull' : 'issues';
  const markdownBody = [
    `### Mirrored Upstream ${kindLabel}: ${safeRef}`,
    '',
    `- **Upstream Repository:** \`${upstreamRepo}\``,
    `- **Upstream ${kindLabel} Number:** \`#${item.number}\``,
    `- **Upstream URL:** \`https://github.com/${upstreamRepo}/${upstreamPath}/${item.number}\``,
    `- **Original Author:** \`@${String(item.author || 'unknown')}\``,
    `- **Synced To Installed Repository:** \`${installedRepo}\` *(all triage, comments, and fixes occur strictly in \`${installedRepo}\`)*`,
    '',
    '---',
    '',
    '#### Original Description (Untrusted Upstream Input)',
    '',
    sanitizedBody
  ].join('\n');

  const body = formatStateComment(markdownBody, {
    upstream_ref: `${upstreamRepo}#${item.number}`,
    upstream_repo: upstreamRepo,
    upstream_number: Number(item.number),
    upstream_kind: item.kind || 'issue',
    upstream_updated_at: item.updated_at || new Date().toISOString(),
    installed_repo: installedRepo
  });

  return {
    targetRepo: installedRepo,
    title,
    body,
    labels: ['lights-on:upstream', LABELS.ACTIONABLE]
  };
}

/**
 * Record in state-store that an upstream item has been synced to `installedRepo`.
 */
export function markUpstreamItemSynced(state, { upstreamRepo, number, localIssueNumber = null, updatedAt = null }) {
  if (!state.processed_items || typeof state.processed_items !== 'object') {
    state.processed_items = {};
  }
  const ref = `${upstreamRepo}#${number}`;
  const key = `upstream:${ref}`;
  state.processed_items[key] = {
    attempts: 1,
    last_attempt_at: new Date().toISOString(),
    last_Result: 'mirrored',
    upstream_ref: ref,
    local_issue_number: localIssueNumber,
    upstream_updated_at: updatedAt || new Date().toISOString()
  };
  return state.processed_items[key];
}

/**
 * High-level orchestrator that resolves upstream, fetches read-only upstream context,
 * identifies unsynced upstream issues/PRs, and optionally creates local tracking issues
 * in `installedRepo` (never in `upstreamRepo`).
 */
export async function syncUpstream({
  repoRoot = process.cwd(),
  config,
  stateFile,
  contextOutput = '/tmp/lights-on-upstream-context.json',
  itemsOutput = '/tmp/lights-on-upstream-items.json',
  localItemsPath = '',
  createLocalIssues = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFileSync
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot, env });
  const resolution = await resolveUpstreamRepo({
    config: resolvedConfig,
    env,
    repoRoot,
    fetchImpl
  });

  if (!resolution.upstreamRepo) {
    return {
      enabled: false,
      hasUpstream: false,
      installedRepo: resolution.installedRepo,
      upstreamRepo: null,
      source: resolution.source,
      unsyncedCount: 0,
      mirroredIssues: [],
      createdLocalIssues: []
    };
  }

  const upstreamContext = await fetchUpstreamContext({
    upstreamRepo: resolution.upstreamRepo,
    installedRepo: resolution.installedRepo,
    token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    fetchImpl
  });

  if (contextOutput) {
    fs.mkdirSync(path.dirname(path.resolve(contextOutput)), { recursive: true });
    fs.writeFileSync(path.resolve(contextOutput), JSON.stringify(upstreamContext, null, 2), 'utf8');
  }

  let existingLocalItems = [];
  if (localItemsPath && fs.existsSync(localItemsPath)) {
    existingLocalItems = JSON.parse(fs.readFileSync(localItemsPath, 'utf8'));
  } else if (createLocalIssues && resolution.installedRepo) {
    const safeInstalled = assertWriteTargetIsInstalledRepo(
      resolution.installedRepo, resolution.installedRepo, resolution.upstreamRepo
    );
    const rawList = execFileImpl('gh', [
      'issue', 'list', '--repo', safeInstalled, '--state', 'all',
      '--label', 'lights-on:upstream', '--limit', '50',
      '--json', 'number,author,body,labels,comments'
    ], { encoding: 'utf8', env: { ...process.env, ...env } });
    existingLocalItems = JSON.parse(rawList);
  }
  if (!Array.isArray(existingLocalItems)) throw new Error('Invalid upstream tracking-issue inventory; refusing duplicate publication.');

  const state = loadState(stateFile ? { stateFile } : {});
  const unsynced = selectUnsyncedUpstreamItems({
    upstreamContext,
    state,
    existingLocalItems,
    maxItems: resolvedConfig.upstream?.max_items_per_run ?? 3,
    syncIssues: resolvedConfig.upstream?.sync_issues !== false,
    syncPrs: Boolean(resolvedConfig.upstream?.sync_prs)
  });

  const mirroredIssues = resolution.installedRepo
    ? unsynced.map((item) => {
        const built = buildLocalUpstreamTrackingIssue(item, {
          upstreamRepo: resolution.upstreamRepo,
          installedRepo: resolution.installedRepo
        });
        return {
          ...item,
          ...built,
          localTrackingIssue: built
        };
      })
    : unsynced;

  if (itemsOutput) {
    fs.mkdirSync(path.dirname(path.resolve(itemsOutput)), { recursive: true });
    fs.writeFileSync(path.resolve(itemsOutput), JSON.stringify(mirroredIssues, null, 2), 'utf8');
  }

  const createdLocalIssues = [];
  const failures = [];
  if (createLocalIssues && resolution.installedRepo && mirroredIssues.length > 0) {
    const safeInstalled = assertWriteTargetIsInstalledRepo(
      resolution.installedRepo,
      resolution.installedRepo,
      resolution.upstreamRepo
    );
    const { ensureLabels } = await import('./ensure-labels.mjs');
    ensureLabels({ repo: safeInstalled, installedRepo: resolution.installedRepo,
      labels: mirroredIssues.flatMap((item) => item.labels), execFileImpl, env: { ...process.env, ...env } });

    for (const item of mirroredIssues) {
      const tmpBodyFile = path.join(
        path.dirname(path.resolve(itemsOutput || '/tmp/lights-on-upstream-items.json')),
        `lights-on-upstream-issue-${item.number}.md`
      );
      fs.writeFileSync(tmpBodyFile, item.body, 'utf8');
      try {
        const out = String(
          execFileImpl(
            'gh',
            [
              'issue',
              'create',
              '--repo',
              safeInstalled,
              '--title',
              item.title,
              '--body-file',
              tmpBodyFile,
              '--label',
              item.labels.join(',')
            ],
            { encoding: 'utf8', env: { ...process.env, ...env } }
          ) || ''
        ).trim();
        const numMatch = out.match(/\/issues\/([1-9]\d*)$/);
        const localNumber = numMatch ? Number(numMatch[1]) : null;
        if (!localNumber || out !== githubItemUrl(safeInstalled, 'issues', localNumber, env)) {
          throw new Error('Could not confirm tracking issue URL.');
        }
        markUpstreamItemSynced(state, {
          upstreamRepo: resolution.upstreamRepo,
          number: item.number,
          localIssueNumber: localNumber,
          updatedAt: item.updated_at
        });
        createdLocalIssues.push({
          upstreamRef: `${resolution.upstreamRepo}#${item.number}`,
          localIssueNumber: localNumber,
          url: out
        });
        saveState(state, stateFile ? { stateFile } : {});
        reportWorkflowEvent({ title: 'Upstream tracking issue created',
          message: `Created local tracking issue for ${resolution.upstreamRepo}#${item.number}.`,
          url: out, details: { Repository: safeInstalled, 'Issue title': item.title } }, { env });
      } catch (err) {
        failures.push(item.number);
        reportWorkflowEvent({ level: 'error', title: 'Upstream issue mirroring failed',
          message: `Could not mirror upstream item #${item.number}: ${err.message}` }, { env });
      } finally {
        fs.unlinkSync(tmpBodyFile);
      }
    }
  }

  saveState(state, stateFile ? { stateFile } : {});
  if (failures.length) throw new Error(`Upstream mirroring failed for ${failures.length} item(s); confirmed successes remain recorded.`);

  return {
    enabled: true,
    hasUpstream: true,
    installedRepo: resolution.installedRepo,
    upstreamRepo: resolution.upstreamRepo,
    source: resolution.source,
    upstreamContext,
    unsyncedCount: mirroredIssues.length,
    mirroredIssues,
    createdLocalIssues
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  let contextOutPath = '/tmp/lights-on-upstream-context.json';
  let unsyncedOutPath = '/tmp/lights-on-upstream-items.json';
  let localItemsPath = '';
  const createLocalIssues = args.includes('--create-local-issues');
  const emitGitHubOutput = args.includes('--github-output');

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--output' || args[i] === '--context-output') && args[i + 1]) {
      contextOutPath = args[++i];
    } else if ((args[i] === '--unsynced-output' || args[i] === '--items-output') && args[i + 1]) {
      unsyncedOutPath = args[++i];
    } else if (args[i] === '--local-items' && args[i + 1]) {
      localItemsPath = args[++i];
    }
  }

  const res = await syncUpstream({
    contextOutput: contextOutPath,
    itemsOutput: unsyncedOutPath,
    localItemsPath,
    createLocalIssues,
    env: process.env
  });

  if (!res.hasUpstream) {
    reportWorkflowEvent({ title: 'Upstream sync skipped', message: `No upstream selected (${res.source}); no tracking issues created.` });
    if (emitGitHubOutput && process.env.GITHUB_OUTPUT) {
      const out = [
        'has_upstream=false',
        `installed_repo=${sanitizeGitHubOutputValue(res.installedRepo || '')}`,
        'upstream_repo=',
        'unsynced_count=0'
      ];
      fs.appendFileSync(process.env.GITHUB_OUTPUT, out.join('\n') + '\n', 'utf8');
    }

    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (emitGitHubOutput && process.env.GITHUB_OUTPUT) {
    const out = [
      'has_upstream=true',
      `installed_repo=${sanitizeGitHubOutputValue(res.installedRepo || '')}`,
      `upstream_repo=${sanitizeGitHubOutputValue(res.upstreamRepo)}`,
      `unsynced_count=${res.unsyncedCount}`,
      `created_local_count=${res.createdLocalIssues.length}`,
      `context_file=${sanitizeGitHubOutputValue(contextOutPath)}`,
      `unsynced_file=${sanitizeGitHubOutputValue(unsyncedOutPath)}`
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out.join('\n') + '\n', 'utf8');
  }

  if (res.createdLocalIssues.length === 0) {
    reportWorkflowEvent({ title: 'Upstream sync completed', message: 'No local tracking issues were created.',
      details: { 'Upstream repository': res.upstreamRepo, 'Unsynced candidates': res.unsyncedCount } });
  }
  console.log(
    JSON.stringify(
      {
        hasUpstream: true,
        installedRepo: res.installedRepo,
        upstreamRepo: res.upstreamRepo,
        source: res.source,
        openIssuesCount: res.upstreamContext.openIssues.length,
        maintainerRulingsCount: res.upstreamContext.maintainerRulings.length,
        unsyncedCount: res.unsyncedCount,
        createdLocalCount: res.createdLocalIssues.length
      },
      null,
      2
    )
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli().catch((err) => {
    console.error('Fatal error in sync-upstream:', err);
    process.exit(1);
  });
}
