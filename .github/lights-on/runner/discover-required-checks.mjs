import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGitHub } from './github-io.mjs';
import { parseSimpleYaml } from './load-config.mjs';

const SELF_CHECK = '4-Gate Review & Auto-Merge Verification';
const ACTIONS_APP = 15368;
const CONFIG = '.github/lights-on.yml';
const WORKFLOW = '.github/workflows/lights-on-pr.yml';
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
const sha = (value) => /^[a-f0-9]{40}$/i.test(value || '');
const appId = (value) => Number.isSafeInteger(value) && value > 0;
const identity = (check) => JSON.stringify([check.context, check.app_id]);
const unique = (checks) => [...new Map(checks.map((check) => [identity(check), check])).values()]
  .sort((a, b) => identity(a).localeCompare(identity(b)));

export function discoveryApi(repo, env = process.env, execFileImpl = execFileSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      repo.split('/').some((part) => part === '.' || part === '..') ||
      (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY.toLowerCase() !== repo.toLowerCase())) {
    throw new Error('Discovery requires the explicit installed repository, matching GITHUB_REPOSITORY when set.');
  }
  return (suffix, { paginate = false, field, allowUnprotected = false } = {}) => {
    let value;
    const projection = paginate && ({
      check_runs: '{total_count,check_runs:[.check_runs[]|{name,head_sha,app:{id:.app.id},check_suite:{id:.check_suite.id}}]}|tojson',
      workflow_runs: '{total_count,workflow_runs:[.workflow_runs[]|{name,head_sha,head_branch,head_repository:{full_name:.head_repository.full_name},event,check_suite_id}]}|tojson'
    })[field];
    try {
      // Project before buffering: repeated check runs can contain megabytes of annotations.
      const output = runGitHub(['api', '--method', 'GET',
        ...(projection ? ['--paginate', '--jq', projection] : paginate ? ['--paginate', '--slurp'] : []), `repos/${repo}${suffix}`],
      { env: { ...env, GITHUB_REPOSITORY: repo }, encoding: 'utf8', timeout: 120000,
        maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }, execFileImpl);
      value = projection ? output.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : JSON.parse(output);
    } catch (error) {
      let response;
      try { response = JSON.parse(String(error.stdout || '')); } catch { /* Not a GitHub JSON error. */ }
      if (allowUnprotected && response?.message === 'Branch not protected' &&
          (response.status === '404' || response.status === 404 || /\b404\b/.test(String(error.stderr)))) return null;
      const status = response?.status || error.code || error.status || 'invalid response';
      throw new Error(`Cannot read GitHub discovery data at ${suffix} (${status}). Check authentication, read permissions and API availability.`, { cause: error });
    }
    if (!paginate) return value;
    if (!Array.isArray(value) || !value.length ||
        !value.every((page) => Array.isArray(field ? page?.[field] : page))) {
      throw new Error(`Incomplete discovery response at ${suffix}.`);
    }
    const items = value.flatMap((page) => field ? page[field] : page);
    if (field && value.some((page) => !Number.isSafeInteger(page.total_count) || page.total_count !== items.length)) {
      throw new Error(`Incomplete or changing discovery inventory at ${suffix}.`);
    }
    return items;
  };
}

export function discoverRequiredChecks({ repo, branch, api = discoveryApi(repo) }) {
  const metadata = api('');
  if (metadata.full_name?.toLowerCase() !== repo.toLowerCase() || !text(metadata.default_branch)) {
    throw new Error('Repository metadata does not match the installed repository.');
  }
  branch ||= metadata.default_branch;
  if (!text(branch)) throw new Error('Invalid merge-target branch.');
  const ref = encodeURIComponent(branch);
  const base = api(`/branches/${ref}`);
  if (base.name !== branch || !sha(base.commit?.sha)) throw new Error('Invalid target branch identity.');
  const rules = api(`/rules/branches/${ref}?per_page=100`, { paginate: true });
  const protection = api(`/branches/${ref}/protection`, { allowUnprotected: true });
  if (!Array.isArray(rules) || (protection !== null && (!protection ||
      (!Object.hasOwn(protection, 'required_status_checks') && typeof protection.enforce_admins?.enabled !== 'boolean')))) {
    throw new Error('Incomplete branch protection evidence.');
  }
  const requirements = [];
  const warnings = [];
  const add = (context, publisher, source) => {
    if (!text(context) || !(publisher == null || publisher === -1 || appId(publisher))) {
      throw new Error('Malformed required check in GitHub branch policy.');
    }
    if (context === SELF_CHECK) throw new Error('Branch policy requires Lights On itself; remove this circular merge dependency.');
    requirements.push({ context, app_id: appId(publisher) ? publisher : undefined, source });
  };
  for (const rule of rules) {
    if (!text(rule?.type)) throw new Error('Invalid branch rule.');
    if (rule.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) throw new Error('Required-check ruleset has no check inventory.');
      for (const check of checks) add(check.context, check.integration_id, `ruleset:${rule.ruleset_id ?? 'active'}`);
    } else if (['workflows', 'required_deployments', 'merge_queue'].includes(rule.type)) {
      warnings.push(`GitHub's ${rule.type} rule is not represented by required_checks; server-side enforcement remains necessary.`);
    }
  }
  const classic = protection?.required_status_checks;
  if (classic) {
    if (!Array.isArray(classic.checks) || !Array.isArray(classic.contexts)) throw new Error('Incomplete classic required checks.');
    for (const check of classic.checks) add(check.context, check.app_id, 'branch-protection');
    for (const context of classic.contexts) {
      if (!classic.checks.some((check) => check.context === context)) add(context, undefined, 'branch-protection');
    }
  }

  // Only commits already on the target branch supply identity evidence. Never learn from an open PR.
  const commits = api(`/commits?sha=${ref}&per_page=5`);
  if (!Array.isArray(commits) || !commits.length || commits[0].sha !== base.commit.sha ||
      !commits.every((commit) => sha(commit.sha))) throw new Error('Target branch moved or commit history is incomplete; rerun discovery.');
  const observed = [];
  for (const commit of commits.slice(0, 5)) {
    const checks = api(`/commits/${commit.sha}/check-runs?filter=latest&per_page=100`, { paginate: true, field: 'check_runs' });
    const statuses = api(`/commits/${commit.sha}/statuses?per_page=100`, { paginate: true });
    const runs = api(`/actions/runs?head_sha=${commit.sha}&event=push&branch=${ref}&per_page=100`,
      { paginate: true, field: 'workflow_runs' });
    if (![checks, statuses, runs].every(Array.isArray)) throw new Error('Incomplete CI identity evidence.');
    const workflowsBySuite = new Map();
    for (const run of runs) {
      if (run.head_sha !== commit.sha || run.head_branch !== branch || run.event !== 'push' ||
          run.head_repository?.full_name?.toLowerCase() !== repo.toLowerCase() || !Number.isSafeInteger(run.check_suite_id)) continue;
      if (!text(run.name)) throw new Error('Invalid workflow name.');
      if (!workflowsBySuite.has(run.check_suite_id)) workflowsBySuite.set(run.check_suite_id, []);
      workflowsBySuite.get(run.check_suite_id).push(run.name);
    }
    for (const check of checks) {
      if (!text(check.name) || !appId(check.app?.id) || check.head_sha !== commit.sha) throw new Error('Invalid check identity.');
      if (check.name === SELF_CHECK && check.app.id === ACTIONS_APP) continue;
      observed.push({ context: check.name, app_id: check.app.id, sha: commit.sha,
        workflows: workflowsBySuite.get(check.check_suite?.id) || [] });
    }
    for (const status of statuses) {
      if (!text(status.context) || !Number.isSafeInteger(status.id)) throw new Error('Invalid legacy status identity.');
      observed.push({ context: status.context, app_id: null, sha: commit.sha, workflows: [] });
    }
  }
  const unresolved = [];
  const resolved = requirements.flatMap((required) => {
    if (required.app_id !== undefined) return [required];
    const matches = unique(observed.filter((check) => check.context === required.context));
    if (matches.length !== 1) {
      unresolved.push({ context: required.context, reason: matches.length ? 'Multiple publishing identities' : 'No trusted publishing identity' });
      return [];
    }
    return [{ ...required, app_id: matches[0].app_id }];
  });
  const requiredChecks = unique(resolved.map(({ context, app_id }) => ({ context, app_id })));
  const workflowNames = [...new Set(observed.filter((check) =>
    requiredChecks.some((required) => identity(required) === identity(check))).flatMap((check) => check.workflows))].sort();
  for (const required of requiredChecks.filter((check) => check.app_id === ACTIONS_APP)) {
    if (!observed.some((check) => identity(check) === identity(required) && check.workflows.length)) {
      warnings.push(`No trusted workflow mapping for ${JSON.stringify(required.context)}; configure workflow_run.workflows manually.`);
    }
  }
  if (requiredChecks.some((check) => check.app_id !== ACTIONS_APP)) {
    warnings.push('Non-Actions check/status completion does not trigger workflow_run; manual PR re-evaluation may be needed.');
  }
  return {
    status: unresolved.length ? 'blocked' : requirements.length ? 'ready' : 'needs-selection',
    repository: repo, branch, source_sha: base.commit.sha, required_checks: requiredChecks,
    provenance: resolved, unresolved, workflow_names: workflowNames, warnings,
    candidates: requirements.length ? [] : unique(observed.map(({ context, app_id }) => ({ context, app_id })))
  };
}

function readLocal(root, relative) {
  const parts = relative.split('/');
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() :
      !stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)) throw new Error(`Unsafe setup file: ${relative}`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}

function replaceValue(source, keys, value) {
  const lines = source.split(/\r?\n/);
  let start = 0, end = lines.length;
  for (const [depth, key] of keys.entries()) {
    const prefix = ' '.repeat(depth * 2);
    const matches = [];
    for (let i = start; i < end; i++) if (lines[i].startsWith(`${prefix}${key}:`)) matches.push(i);
    if (matches.length !== 1) throw new Error(`Expected one literal ${keys.slice(0, depth + 1).join('.')} YAML setting.`);
    start = matches[0];
    let next = start + 1;
    while (next < end && (!lines[next].trim() || lines[next].match(/^ */)[0].length > depth * 2)) next++;
    end = next;
    if (depth === keys.length - 1) {
      lines.splice(start, end - start, `${prefix}${key}: ${JSON.stringify(value)}`);
      return lines.join(source.includes('\r\n') ? '\r\n' : '\n');
    }
    if (lines[start].slice(prefix.length + key.length + 1).replace(/#.*/, '').trim()) {
      throw new Error('Discovery updates require block-style YAML parent sections.');
    }
    start++;
  }
}

export function planDiscoveryEdits({ root, discovery, updateWorkflows = false }) {
  if (discovery.status !== 'ready' || !discovery.required_checks.length) {
    throw new Error('Discovery is not authoritative and complete; review the diagnostics/candidates before configuring checks manually.');
  }
  const before = readLocal(root, CONFIG);
  const existing = parseSimpleYaml(before).autonomy?.required_checks;
  if (!Array.isArray(existing)) throw new Error('Existing required_checks must be an explicit YAML array.');
  if (existing.length && JSON.stringify(unique(existing)) !== JSON.stringify(unique(discovery.required_checks))) {
    throw new Error('Existing required_checks differ from discovery; refusing to overwrite an explicit policy.');
  }
  const after = replaceValue(before, ['autonomy', 'required_checks'], discovery.required_checks);
  if (JSON.stringify(parseSimpleYaml(after).autonomy.required_checks) !== JSON.stringify(discovery.required_checks)) {
    throw new Error('Check names cannot round-trip through the supported YAML subset.');
  }
  const edits = existing.length ? [] : [{ file: CONFIG, before, after }];
  if (updateWorkflows && discovery.workflow_names.length) {
    const before = readLocal(root, WORKFLOW);
    const existing = parseSimpleYaml(before).on?.workflow_run?.workflows;
    if (!Array.isArray(existing) || !existing.every(text)) throw new Error('Expected a literal workflow_run.workflows array.');
    const names = [...new Set([...existing, ...discovery.workflow_names])];
    const after = replaceValue(before, ['on', 'workflow_run', 'workflows'], names);
    if (JSON.stringify(parseSimpleYaml(after).on.workflow_run.workflows) !== JSON.stringify(names)) {
      throw new Error('Workflow names cannot round-trip through the supported YAML subset.');
    }
    if (JSON.stringify(existing) !== JSON.stringify(names)) edits.push({ file: WORKFLOW, before, after });
  }
  return edits;
}

export function applyDiscoveryEdits(root, edits) {
  for (const edit of edits) {
    if (![CONFIG, WORKFLOW].includes(edit.file) || readLocal(root, edit.file) !== edit.before) {
      throw new Error('Setup file changed during discovery; no stale edits may be applied.');
    }
  }
  for (const edit of edits) {
    const destination = path.join(root, ...edit.file.split('/'));
    const temp = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, edit.after, { flag: 'wx', mode: fs.statSync(destination).mode & 0o777 });
      if (readLocal(root, edit.file) !== edit.before) throw new Error('Setup file changed before replacement.');
      fs.renameSync(temp, destination);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
}

export function previewDiscoveryEdits(edits) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-ci-preview-'));
  try {
    for (const edit of edits) {
      fs.writeFileSync(path.join(directory, 'before'), edit.before);
      fs.writeFileSync(path.join(directory, 'after'), edit.after);
      let diff;
      try {
        diff = execFileSync('git', ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
          '--no-color', '--', 'before', 'after'], { cwd: directory, encoding: 'utf8', maxBuffer: 3 * 1024 * 1024 });
      } catch (error) {
        if (error.status !== 1) throw error;
        diff = String(error.stdout);
      }
      console.log(`Proposed ${edit.file}:\n${diff}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (['--write', '--update-workflows'].includes(args[i])) options[args[i].slice(2)] = true;
      else if (['--repo', '--branch', '--root'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        options[args[i].slice(2)] = args[++i];
      } else throw new Error(`Unknown or incomplete discovery argument: ${args[i]}`);
    }
    const repo = options.repo || process.env.GITHUB_REPOSITORY;
    const discovery = discoverRequiredChecks({ repo, branch: options.branch });
    console.log(JSON.stringify(discovery, null, 2));
    if (discovery.status !== 'ready') throw new Error('Required checks need explicit selection or identity resolution; no files changed.');
    const root = path.resolve(options.root || '.');
    const edits = planDiscoveryEdits({ root, discovery, updateWorkflows: options['update-workflows'] });
    previewDiscoveryEdits(edits);
    if (options.write) applyDiscoveryEdits(root, edits);
    console.log(options.write ? `Applied ${edits.length} setup file change(s); review and commit them explicitly.` : 'Preview only. Use --write to apply.');
  } catch (error) {
    console.error(`Required-check discovery failed: ${error.message}`);
    process.exitCode = 1;
  }
}
