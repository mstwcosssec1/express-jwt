import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inventory, createAgentSandbox } from './agent-sandbox.mjs';
import { detectManifestsAndDeps } from './scan-dependencies.mjs';
import { isOnCooldown, getAttempts } from './state-store.mjs';
import { PROTECTED_PATH_PATTERNS } from './verify-pr-safety.mjs';
import { resolveSafePath } from './workspace-path.mjs';

export const DEPENDENCY_TASKS = ['dependency-updater', 'dependency-migration-planner', 'dependency-migrator'];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const dependencyKey = (dep) => `dependency:${dep.ecosystem}:${dep.manifest}:${dep.name}`;
export const dependencyBranch = (dep) => `lights-on/dependency-${digest(dependencyKey(dep)).slice(0, 16)}`;
export const dependencyFileHash = (root, name) => digest(fs.readFileSync(safeFile(root, name)));

function safeFile(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\') ||
      name.split('/').some((part) => !part || part === '..' || part === '.') || /[:\x00-\x1f]/.test(name)) {
    throw new Error('Invalid dependency work path.');
  }
  return resolveSafePath(name, root);
}

function readJson(root, name) {
  return JSON.parse(fs.readFileSync(safeFile(root, name), 'utf8'));
}

export function approvedMigration(config, id) {
  const plans = config.dependencies?.approved_migrations || [];
  const plan = plans.find((item) => item.id === id);
  if (!plan || plans.filter((item) => item.id === id).length !== 1 || !plan.name ||
      !plan.manifest || !plan.ecosystem || !Array.isArray(plan.allowed_files) ||
      !plan.allowed_files.length || !Array.isArray(plan.validation_commands) || !plan.validation_commands.length ||
      !plan.validation_commands.every((cmd) => typeof cmd === 'string' && cmd.trim()) ||
      typeof plan.plan !== 'string' || !plan.plan.trim() ||
      !plan.replacement || typeof plan.replacement.name !== 'string' ||
      (plan.replacement.name !== 'stdlib' && !semver.test(plan.replacement.version || ''))) {
    throw new Error('Migration requires a unique approved_migrations entry with a plan, replacement, allowed_files, and validation_commands.');
  }
  for (const name of plan.allowed_files) {
    safeFile('.', name);
    if (PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(name))) {
      throw new Error('Approved migration cannot modify protected files; use a separate maintainer change.');
    }
  }
  return structuredClone(plan);
}

export function selectDependencyWork({ report, repoRoot, openPrs = [], openPlans = [], state = {}, config = {},
  mode = 'updates', planId = '', now = Date.now() }) {
  if (!['updates', 'migration-plan', 'migration'].includes(mode)) throw new Error('Invalid dependency selection mode.');
  if (!Array.isArray(report?.dependencies) || !Number.isFinite(Date.parse(report.scannedAt)) ||
      now - Date.parse(report.scannedAt) > 24 * 3600000 || Date.parse(report.scannedAt) > now + 60000) {
    return { status: 'blocked', reason: 'Missing or stale dependency scan; run Step B again.' };
  }
  let plan;
  if (mode === 'migration') plan = approvedMigration(config, planId);
  const candidates = report.dependencies.filter((dep) =>
    mode === 'migration' ? dep.name === plan.name && dep.manifest === plan.manifest && dep.ecosystem === plan.ecosystem :
      mode === 'migration-plan' ? dep.recommendedAction === 'migrate' :
        ['bump-minor-or-patch', 'bump-patch', 'bump-minor'].includes(dep.recommendedAction));
  const deferred = report.dependencies.filter((dep) =>
    ['security-bump', 'migrate', 'evaluate-major-bump'].includes(dep.recommendedAction))
    .map((dep) => ({ key: dependencyKey(dep), action: dep.recommendedAction,
      route: dep.recommendedAction === 'security-bump' ? 'Step C' : 'migration-plan' }));
  const blockers = [];
  const skipped = [];
  const unique = [...new Map(candidates.map((dep) => [dependencyKey(dep), dep])).values()]
    .sort((a, b) => dependencyKey(a).localeCompare(dependencyKey(b)));
  const currentByKey = new Map();
  for (const dep of unique.length ? detectManifestsAndDeps(repoRoot).dependencies : []) {
    const key = dependencyKey(dep);
    if (!currentByKey.has(key)) currentByKey.set(key, []);
    currentByKey.get(key).push(dep);
  }
  for (const dep of unique) {
    const key = dependencyKey(dep);
    const stateKey = mode === 'updates' ? key : `${key}:${mode}:${planId}`;
    if (mode === 'migration-plan' && openPlans.includes(key)) {
      skipped.push({ key, reason: 'open-migration-plan-exists' });
      continue;
    }
    if (isOnCooldown(state, stateKey, now) || getAttempts(state, stateKey) >= (config.limits?.max_attempts_per_issue ?? 2)) {
      skipped.push({ key, reason: 'cooldown-or-attempt-limit' });
      continue;
    }
    if (openPrs.some((pr) => pr.headRefName === dependencyBranch(dep) || pr.files?.includes(dep.manifest))) {
      skipped.push({ key, reason: 'open-pr-already-modifies-manifest' });
      continue;
    }
    if (!currentByKey.get(key)?.some((current) =>
      current.versionSpec === dep.versionSpec && current.resolvedVersion === dep.resolvedVersion)) {
      blockers.push({ key, reason: 'manifest-changed-since-scan' });
      continue;
    }
    if (mode === 'updates' && (dep.flags?.vulnerable || dep.cves?.length)) {
      deferred.push({ key, action: 'security-bump', route: 'Step C' });
      continue;
    }
    if (mode === 'updates' && (!dep.evidence?.metadata_available || !dep.evidence?.advisory_checked)) {
      blockers.push({ key, reason: 'missing-registry-or-advisory-evidence' });
      continue;
    }
    if (mode === 'updates') {
      const old = semver.exec(dep.resolvedVersion || '');
      const next = semver.exec(dep.latestVersion || '');
      if (!old || !next || old[1] !== next[1] ||
          (+next[2] < +old[2] || (+next[2] === +old[2] && +next[3] <= +old[3])) ||
          (old[1] === '0' && old[2] !== next[2])) {
        blockers.push({ key, reason: 'not-a-stable-compatible-patch-or-minor-update' });
        continue;
      }
      if (dep.ecosystem !== 'npm' || path.posix.basename(dep.manifest) !== 'package.json') {
        blockers.push({ key, reason: 'routine-verifier-not-supported-for-this-ecosystem' });
        continue;
      }
      if (!/^[~^]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(dep.versionSpec || '')) {
        blockers.push({ key, reason: 'unsupported-dependency-range' });
        continue;
      }
      const lock = path.posix.join(path.posix.dirname(dep.manifest), 'package-lock.json');
      if (!fs.existsSync(safeFile(repoRoot, lock))) {
        blockers.push({ key, reason: 'routine-update-requires-package-lock-v2-or-v3' });
        continue;
      }
      const parsed = readJson(repoRoot, lock);
      const pkg = readJson(repoRoot, dep.manifest);
      const packageDir = path.posix.dirname(dep.manifest);
      const conflictingLock = ['npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].some((name) =>
        fs.existsSync(safeFile(repoRoot, path.posix.join(packageDir, name))));
      if (conflictingLock || ![2, 3].includes(parsed.lockfileVersion) || !parsed.packages?.[''] ||
          !parsed.packages?.[`node_modules/${dep.name}`] || pkg.workspaces ||
          pkg.scripts?.test === undefined || !String(pkg.scripts.test).trim()) {
        blockers.push({ key, reason: 'unsupported-lockfile-layout-or-missing-test-command' });
        continue;
      }
    }
    const task = mode === 'updates' ? 'dependency-updater' :
      mode === 'migration-plan' ? 'dependency-migration-planner' : 'dependency-migrator';
    return { status: 'ready', task, tier: mode === 'updates' ? 'default' : 'reasoning',
      key, stateKey, branch: dependencyBranch(dep), dependency: dep,
      manifest_sha256: dependencyFileHash(repoRoot, dep.manifest), plan,
      downstreamDependents: report.downstreamDependents, deferred, skipped, blockers };
  }
  return { status: blockers.length || mode === 'migration' ? 'blocked' : 'skipped',
    reason: blockers.length ? 'No verifiable candidate; see blockers.' : 'No eligible unhandled dependency for this lane.',
    deferred, skipped, blockers };
}

function sourceChanges(source, candidate) {
  const before = inventory(source, { omitLocal: true });
  const after = inventory(candidate, { omitLocal: true });
  return [...new Set([...before.keys(), ...after.keys()])].filter((name) =>
    before.get(name)?.hash !== after.get(name)?.hash || before.get(name)?.mode !== after.get(name)?.mode);
}

export function verifyDependencyScope({ selection, repoRoot, candidateRoot, config }) {
  const dep = selection.dependency;
  if (selection.status !== 'ready' || dependencyKey(dep) !== selection.key ||
      dependencyFileHash(repoRoot, dep.manifest) !== selection.manifest_sha256) {
    throw new Error('Dependency selection no longer matches the trusted checkout.');
  }
  const changes = sourceChanges(repoRoot, candidateRoot);
  if (!changes.length) throw new Error('No dependency candidate changes were produced.');
  if (selection.task === 'dependency-migrator') {
    const plan = approvedMigration(config, selection.plan?.id);
    if (!isDeepStrictEqual(plan, selection.plan)) throw new Error('Approved migration plan changed.');
    if (changes.some((name) => !plan.allowed_files.includes(name))) throw new Error('Migration changed files outside its approved plan.');
    const manifests = { npm: 'package-lock.json', cargo: 'Cargo.lock', go: 'go.sum', rubygems: 'Gemfile.lock', nuget: 'packages.lock.json' };
    const lockName = manifests[dep.ecosystem] && path.posix.join(path.posix.dirname(dep.manifest), manifests[dep.ecosystem]);
    if (lockName && fs.existsSync(safeFile(repoRoot, lockName)) && !changes.includes(lockName)) {
      throw new Error('Migration must update the existing lockfile.');
    }
    const deps = detectManifestsAndDeps(candidateRoot).dependencies;
    if (deps.some((item) => item.manifest === dep.manifest && item.name === dep.name)) throw new Error('Migration did not remove the retired dependency.');
    if (plan.replacement.name !== 'stdlib' && !deps.some((item) =>
      item.manifest === dep.manifest && item.ecosystem === plan.ecosystem &&
      item.name === plan.replacement.name && item.resolvedVersion === plan.replacement.version)) {
      throw new Error('Migration manifest/lock does not identify the approved replacement version.');
    }
    return { changes, expected: plan.replacement.name === 'stdlib' ? [] :
      [{ ecosystem: plan.ecosystem, name: plan.replacement.name, version: plan.replacement.version }],
    commands: plan.validation_commands };
  }
  if (selection.task !== 'dependency-updater' || dep.ecosystem !== 'npm') throw new Error('Invalid routine dependency task.');
  const lockName = path.posix.join(path.posix.dirname(dep.manifest), 'package-lock.json');
  if (changes.some((name) => name !== dep.manifest && name !== lockName) ||
      !changes.includes(lockName)) throw new Error('Routine update must change only the selected manifest and its lockfile.');
  const before = readJson(repoRoot, dep.manifest);
  const after = readJson(candidateRoot, dep.manifest);
  const reverted = structuredClone(after);
  let updated = false;
  for (const section of sections) {
    const prev = before[section]?.[dep.name];
    if (prev !== undefined) {
      const value = after[section]?.[dep.name];
      const prefix = String(prev).match(/^[~^]/)?.[0] || '';
      if (typeof value !== 'string' || value !== `${prefix}${dep.latestVersion}`) {
        throw new Error('Selected dependency does not target the planned version.');
      }
      reverted[section][dep.name] = prev;
      updated = true;
    }
  }
  if (!updated || !isDeepStrictEqual(before, reverted)) throw new Error('Routine update changed unrelated manifest fields.');
  const lock = readJson(candidateRoot, lockName);
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.[''] ||
      lock.packages?.[`node_modules/${dep.name}`]?.version !== dep.latestVersion) {
    throw new Error('Lockfile does not resolve the selected dependency to the planned version.');
  }
  for (const section of sections) {
    if (!isDeepStrictEqual(after[section] || {}, lock.packages[''][section] || {})) {
      throw new Error('Manifest and root lockfile requirements disagree.');
    }
  }
  const pkgDir = path.posix.dirname(dep.manifest);
  const shellDir = `'${pkgDir.replace(/'/g, "'\\''")}'`;
  const expected = [{ ecosystem: 'npm', name: dep.name, version: dep.latestVersion }];
  // The fresh validation worker installs from its offline cache and tests this exact lock.
  const verify = `const fs=require("fs"); const name=${JSON.stringify(dep.name)}; const v=JSON.parse(fs.readFileSync("node_modules/"+name+"/package.json")).version; if(v!==${JSON.stringify(dep.latestVersion)})process.exit(1);`;
  const scripts = ['build', 'lint', 'test'].filter((name) => before.scripts?.[name]);
  if (!scripts.includes('test')) throw new Error('Missing test command.');
  const command = `cd ${shellDir} && npm ci --offline --ignore-scripts --no-audit --no-fund && node -e '${verify.replace(/'/g, "'\\''")}' && ` +
    scripts.map((name) => `npm run ${name}`).join(' && ');
  const extra = config.dependencies?.validation_commands || [];
  if (!Array.isArray(extra)) throw new Error('dependencies.validation_commands must be an array.');
  return { changes, expected, commands: [command, ...extra] };
}

export async function validateDependencyCandidate({ selection, repoRoot, candidateRoot, config = {},
  image, sandboxFactory = createAgentSandbox, fetchImpl = globalThis.fetch }) {
  const scope = verifyDependencyScope({ selection, repoRoot, candidateRoot, config });
  // Registry/advisory lookups happen in the controller, never in a credentialed build.
  const advisory = [];
  for (const pkg of scope.expected) {
    const response = await fetchImpl('https://api.osv.dev/v1/query', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ package: { name: pkg.name, ecosystem: { npm: 'npm', cargo: 'crates.io',
        pypi: 'PyPI', go: 'Go', nuget: 'NuGet', rubygems: 'RubyGems' }[pkg.ecosystem] || pkg.ecosystem }, version: pkg.version }) });
    if (!response.ok) throw new Error('Candidate advisory lookup failed.');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error ||
        (data.vulns !== undefined && !Array.isArray(data.vulns))) throw new Error('Invalid candidate advisory response.');
    if (data.vulns?.length) throw new Error('Selected target version has known vulnerabilities; route remediation to Step C.');
    advisory.push(pkg);
  }
  const worker = sandboxFactory({ repoRoot: candidateRoot, image });
  try {
    const checks = [];
    for (const command of scope.commands) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid trusted validation command.');
      const result = worker.run(command);
      checks.push({ command, exit_code: result.exit_code });
      if (result.exit_code !== 0) throw new Error(`Dependency validation command failed (exit ${result.exit_code}); offline dependencies/toolchains may be missing.`);
    }
    // Commands may create build artifacts, but cannot alter the candidate source under test.
    const expectedFiles = inventory(candidateRoot, { omitLocal: true });
    for (const [name, expected] of expectedFiles) {
      if (!fs.existsSync(safeFile(worker.workspace, name)) ||
          dependencyFileHash(worker.workspace, name) !== expected.hash ||
          (fs.statSync(safeFile(worker.workspace, name)).mode & 0o111) !== (expected.mode & 0o111)) {
        throw new Error(`Validation modified candidate source: ${name}`);
      }
    }
    if (selection.task === 'dependency-migrator') {
      const resolution = readJson(worker.workspace, 'dependency-validation.json');
      if (!Array.isArray(resolution.resolved) ||
          !scope.expected.every((pkg) => resolution.resolved.some((item) => isDeepStrictEqual(item, pkg)))) {
        throw new Error('Migration validation did not confirm exact replacement resolution.');
      }
    }
    return { status: 'passed', key: selection.key, task: selection.task, advisory, checks,
      files: scope.changes.map((name) => ({ path: name,
        sha256: fs.existsSync(safeFile(candidateRoot, name)) ? dependencyFileHash(candidateRoot, name) : null })) };
  } finally { worker.dispose(); }
}
