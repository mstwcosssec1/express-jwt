import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRUSTED_DEFAULT_WRITERS = new Set([
  'push', 'workflow_dispatch', 'repository_dispatch', 'delete', 'registry_package', 'page_build', 'schedule'
]);

export function cacheAccess(env = process.env) {
  const configured = String(env.ACTIONS_CACHE_MODE || '').trim().toLowerCase();
  if (configured && !['read', 'write', 'write-only', 'none'].includes(configured)) {
    throw new Error('Unrecognized ACTIONS_CACHE_MODE; refusing to assume cache access.');
  }
  const mode = configured || (TRUSTED_DEFAULT_WRITERS.has(env.GITHUB_EVENT_NAME) ? 'write' : 'read');
  return { mode, readable: mode === 'read' || mode === 'write', writable: mode === 'write' || mode === 'write-only',
    source: configured ? 'runner' : 'conservative trigger default' };
}

export function reportCacheAccess(env = process.env) {
  const access = cacheAccess(env);
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required to report cache access.');
  fs.appendFileSync(env.GITHUB_OUTPUT,
    `mode=${access.mode}\nreadable=${access.readable}\nwritable=${access.writable}\n`, 'utf8');
  const message = `Cache access: ${access.mode} (${access.source}). Restore: ${access.readable}; save: ${access.writable}.`;
  console.log(message);
  const limitation = !access.writable
    ? 'This run cannot save shared state to the Actions cache. New usage and reservations are not durable across runs through that cache. Keep provider-side spending limits enabled.'
    : !access.readable
      ? 'This run cannot restore shared state. Previous cached usage is unavailable; do not rely on the cache for cross-run spending limits.'
      : '';
  if (limitation) console.log(`::notice title=State cache limitation::${limitation}`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    `### Lights On state cache\n\n${message}\n\n${limitation || 'Cache availability and eviction still limit accounting durability.'}\n\n`, 'utf8');
  return access;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { reportCacheAccess(); }
  catch {
    console.error('::error title=Cache access check failed::Unable to determine or report cache access; no cache operation was authorized.');
    process.exitCode = 1;
  }
}
