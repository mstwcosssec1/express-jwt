import { execFileSync } from './github-io.mjs';
import { loadConfig } from './load-config.mjs';

const SELF_CHECK = '4-Gate Review & Auto-Merge Verification';

export function evaluateCi({ checks, statuses, sha, requiredChecks = [] }) {
  if (!/^[a-f0-9]{40}$/i.test(sha || '') || !Array.isArray(checks) ||
      !Array.isArray(statuses) || !Array.isArray(requiredChecks)) return 'pending';
  const latest = new Map();
  for (const check of checks) {
    if (check.name === SELF_CHECK && check.app?.slug === 'github-actions') continue;
    if (check.head_sha !== sha || !Number.isSafeInteger(check.id) ||
        !check.name || !Number.isSafeInteger(check.app?.id)) return 'pending';
    const key = `check:${check.app.id}:${check.name}`;
    if (!latest.has(key) || latest.get(key).id < check.id) {
      latest.set(key, { id: check.id, name: check.name, appId: check.app.id,
        state: check.status !== 'completed' ? 'pending' : check.conclusion === 'success' ? 'success' : 'failure' });
    }
  }
  for (const status of statuses) {
    if (!Number.isSafeInteger(status.id) || !status.context) return 'pending';
    const key = `status:${status.context}`;
    if (!latest.has(key) || latest.get(key).id < status.id) {
      latest.set(key, { id: status.id, name: status.context, appId: null,
        state: status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure' });
    }
  }
  const entries = [...latest.values()];
  if (entries.some((entry) => entry.state === 'failure')) return 'failure';
  if (!entries.length || entries.some((entry) => entry.state !== 'success')) return 'pending';
  // A trusted required set prevents a single early or attacker-created success from qualifying.
  if (!requiredChecks.length) return 'pending';
  for (const required of requiredChecks) {
    if (!required || typeof required.context !== 'string' || !required.context ||
        !(required.app_id === null || (Number.isSafeInteger(required.app_id) && required.app_id > 0))) return 'pending';
    if (!entries.some((entry) => entry.name === required.context &&
        required.app_id === entry.appId && entry.state === 'success')) return 'pending';
  }
  return 'success';
}

export function fetchCiStatus({ repo, sha, requiredChecks = [], execFileImpl = execFileSync }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/i.test(sha || '')) {
    throw new Error('Invalid CI repository or head SHA.');
  }
  const api = (endpoint) => JSON.parse(execFileImpl('gh', ['api', '--paginate', '--slurp', endpoint],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
  const pages = api(`repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
  const statusPages = api(`repos/${repo}/commits/${sha}/statuses?per_page=100`);
  if (!Array.isArray(pages) || !pages.every((p) => Array.isArray(p.check_runs)) ||
      !Array.isArray(statusPages) || !statusPages.every(Array.isArray)) throw new Error('Invalid CI API response.');
  return evaluateCi({ checks: pages.flatMap((p) => p.check_runs), statuses: statusPages.flat(), sha, requiredChecks });
}

export function configuredCiStatus(repo, sha) {
  const requiredChecks = loadConfig().autonomy.required_checks;
  if (!Array.isArray(requiredChecks) || !requiredChecks.length) {
    console.warn('Lights On auto-merge is blocked: configure autonomy.required_checks with trusted CI contexts and App IDs.');
  }
  return fetchCiStatus({ repo, sha, requiredChecks });
}
