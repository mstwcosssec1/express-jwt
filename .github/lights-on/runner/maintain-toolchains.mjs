import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './github-io.mjs';
import { loadConfig } from './load-config.mjs';
import { publishPr } from './publish-pr.mjs';
import { assertWriteTargetIsInstalledRepo, neutralizeCrossRepoAutoLinks } from './sync-upstream.mjs';
import { reportWorkflowEvent } from './workflow-report.mjs';
import { describeCommit } from './describe-change.mjs';

export const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const date = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
};

export function nodeReleaseStatus(release, now = Date.now()) {
  if (!release || !Number.isFinite(date(release.start)) || !Number.isFinite(date(release.end)) ||
      date(release.end) <= date(release.start)) throw new Error('Invalid Node release schedule.');
  if (release.lts && !Number.isFinite(date(release.lts))) throw new Error('Invalid Node LTS date.');
  if (release.maintenance && !Number.isFinite(date(release.maintenance))) throw new Error('Invalid Node maintenance date.');
  if ((release.lts && (date(release.lts) < date(release.start) || date(release.lts) >= date(release.end))) ||
      (release.maintenance && (date(release.maintenance) < date(release.start) || date(release.maintenance) > date(release.end))) ||
      (release.lts && release.maintenance && date(release.lts) > date(release.maintenance))) {
    throw new Error('Inconsistent Node release dates.');
  }
  if (now < date(release.start)) return 'future';
  if (now >= date(release.end)) return 'end-of-life';
  if (release.maintenance && now >= date(release.maintenance)) return 'maintenance';
  return release.lts && now >= date(release.lts) ? 'active-lts' : 'current';
}

function lifecycle(schedule, policy, now) {
  if (!['supported', 'active-lts'].includes(policy)) throw new Error('Node support_policy must be supported or active-lts.');
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) throw new Error('Missing Node release schedule.');
  const statuses = new Map(Object.entries(schedule).filter(([key]) => /^v[1-9]\d*$/.test(key))
    .map(([key, release]) => [Number(key.slice(1)), nodeReleaseStatus(release, now)]));
  const supported = (major) => policy === 'active-lts'
    ? statuses.get(major) === 'active-lts' : ['current', 'active-lts', 'maintenance'].includes(statuses.get(major));
  const targets = [...statuses.keys()].filter((major) => supported(major) && schedule[`v${major}`].lts &&
    now >= date(schedule[`v${major}`].lts)).sort((a, b) => b - a);
  if (!targets.length) throw new Error('No released LTS version satisfies the configured Node support policy.');
  return { statuses, supported, target: targets[0] };
}

function valueParts(raw) {
  const match = raw.trim().match(/^(["']?)(v?)(\d+)(\.x)?\1$/);
  return match ? { quote: match[1], prefix: match[2], major: Number(match[3]), suffix: match[4] || '' } : null;
}

function scalarMask(lines) {
  let blockIndent = null;
  return lines.map((line) => {
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent !== null && (!line.trim() || indent > blockIndent)) return true;
    blockIndent = null;
    if (/^\s*(?:-\s*)?[\w-]+:\s*[|>][-+1-9]*\s*(?:#.*)?$/.test(line)) {
      blockIndent = indent;
      return true;
    }
    return false;
  });
}

function workflowJobs(lines, masked) {
  let inJobs = false;
  let jobIndent;
  let job = null;
  return lines.map((line, index) => {
    if (masked[index] || !line.trim() || /^\s*#/.test(line)) return job;
    if (/^jobs:\s*(?:#.*)?$/.test(line)) { inJobs = true; return null; }
    if (!inJobs) return null;
    const indent = line.match(/^\s*/)[0].length;
    if (!indent) { inJobs = false; job = null; return null; }
    if (jobIndent === undefined) jobIndent = indent;
    if (indent === jobIndent) job = /^\s*[\w-]+:\s*(?:#.*)?$/.test(line) ? index : null;
    return job;
  });
}

export function updateNodeWorkflow(text, policy) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const masked = scalarMask(lines);
  const jobs = workflowJobs(lines, masked);
  const changes = [];
  const notes = [];
  const retire = (major) => policy.statuses.has(major) && policy.statuses.get(major) !== 'future' && !policy.supported(major);
  for (let index = 0; index < lines.length; index++) {
    if (masked[index] || jobs[index] === null || !/^\s*matrix:\s*(?:#.*)?$/.test(lines[index])) continue;
    const indent = lines[index].match(/^\s*/)[0].length;
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s*#/.test(lines[end]) ||
      lines[end].match(/^\s*/)[0].length > indent)) end++;
    const section = lines.slice(index + 1, end);
    if (section.some((line) => /^\s*(?:include|exclude):/.test(line))) {
      notes.push('Matrix include/exclude requires manual review; no matrix entries were changed.');
      index = end - 1;
      continue;
    }
    for (let i = index + 1; i < end; i++) {
      if (masked[i] || lines[i] === null) continue;
      const inline = lines[i].match(/^(\s*)(node|node-version|node_version):\s*\[([^\]]*)\](\s*(?:#.*)?)$/);
      const block = lines[i].match(/^(\s*)(node|node-version|node_version):\s*(?:#.*)?$/);
      const axis = inline || block;
      if (!axis) continue;
      // Only edit axes actually consumed by setup-node-style node-version inputs.
      const referenced = new RegExp(`node-version:\\s*['"]?\\$\\{\\{\\s*matrix\\.${axis[2]}\\s*\\}\\}`);
      if (!lines.some((line, n) => jobs[n] === jobs[index] && !masked[n] && referenced.test(line)) ||
          !lines.some((line, n) => jobs[n] === jobs[index] && !masked[n] && /^\s*(?:-\s*)?uses:\s*actions\/setup-node@/.test(line))) continue;
      let values;
      const itemLines = [];
      let stop = i + 1;
      if (inline) values = inline[3].split(',').map((value) => value.trim());
      else {
        values = [];
        const axisIndent = axis[1].length;
        let valid = true;
        while (stop < end && (!lines[stop].trim() || /^\s*#/.test(lines[stop]) ||
          lines[stop].match(/^\s*/)[0].length > axisIndent)) {
          if (!lines[stop].trim() || /^\s*#/.test(lines[stop])) { stop++; continue; }
          const item = lines[stop].match(/^\s*-\s+([^#]+?)(?:\s+#.*)?$/);
          if (!item || masked[stop]) { valid = false; break; }
          values.push(item[1].trim());
          itemLines.push(stop);
          stop++;
        }
        if (!valid || !values.length) { notes.push(`Node matrix ${axis[2]} has a complex block list; left unchanged.`); continue; }
      }
      if (values.some((value) => !valueParts(value))) {
        notes.push(`Node matrix ${axis[2]} contains aliases, expressions, or patch pins; left unchanged.`);
        continue;
      }
      if (values.some((value) => !policy.statuses.has(valueParts(value).major))) {
        notes.push(`Node matrix ${axis[2]} has versions missing from the lifecycle schedule; those entries were preserved.`);
      }
      const removed = values.filter((value) => retire(valueParts(value).major));
      if (!removed.length) continue;
      let kept = values.filter((value) => !retire(valueParts(value).major));
      const replaceAll = kept.length === 0;
      if (replaceAll) kept = [String(policy.target)];
      if (inline || replaceAll) lines[i] = `${axis[1]}${axis[2]}: [${kept.join(', ')}]${inline ? inline[4] : ''}`;
      for (let j = 0; j < itemLines.length; j++) {
        if (retire(valueParts(values[j]).major)) lines[itemLines[j]] = null;
      }
      changes.push(`Node matrix ${axis[2]}: removed ${removed.join(', ')}; retained ${kept.join(', ')}.`);
    }
    index = end - 1;
  }
  let setupNode = false;
  let setupJob;
  let setupIndent;
  let inWith = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null || masked[i]) continue;
    if (jobs[i] !== setupJob || /^\s*-\s+(?:name|uses|id):/.test(line)) { setupNode = false; inWith = false; }
    const uses = line.match(/^(\s*)(- )?uses:\s*actions\/setup-node@/);
    if (uses) {
      setupNode = true; setupJob = jobs[i]; setupIndent = uses[1].length + (uses[2] ? 2 : 0);
    }
    if (!setupNode || setupJob === null) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent === setupIndent && /^\s*with:\s*$/.test(line)) { inWith = true; continue; }
    if (indent <= setupIndent) inWith = false;
    if (!inWith || indent !== setupIndent + 2) continue;
    const match = line.match(/^(\s*node-version:\s*)([^#]+?)(\s*(?:#.*)?)$/);
    if (!match) continue;
    const parts = valueParts(match[2]);
    if (!parts && /^['"]?v?\d+\.\d+/.test(match[2])) notes.push('Exact setup-node version pin requires manual review.');
    if (!parts || !retire(parts.major)) continue;
    const value = `${parts.quote}${parts.prefix}${policy.target}${parts.suffix}${parts.quote}`;
    lines[i] = `${match[1]}${value}${match[3]}`;
    changes.push(`setup-node runtime: ${parts.major} -> ${policy.target}.`);
  }
  return { content: lines.filter((line) => line !== null).join(newline), changes, notes };
}

function updateRuntimeFile(name, text, policy) {
  const changes = [];
  if (/\.(?:sh|ps1)$|Dockerfile|\.dockerfile$/i.test(name) &&
      (/<<-?\s*['"]?\w/.test(text) || /@['"]\s*$/m.test(text))) {
    return { content: text, changes, notes: ['Build file contains a heredoc/here-string; review runtime declarations manually.'] };
  }
  const update = (full, prefix, raw, suffix) => {
    const parts = valueParts(raw);
    if (!parts || !policy.statuses.has(parts.major) || policy.statuses.get(parts.major) === 'future' || policy.supported(parts.major)) return full;
    changes.push(`Declared Node runtime: ${parts.major} -> ${policy.target}.`);
    return `${prefix}${parts.quote}${parts.prefix}${policy.target}${parts.suffix}${parts.quote}${suffix}`;
  };
  let content = text;
  if (['.nvmrc', '.node-version'].includes(name)) {
    content = text.replace(/^(\s*)(v?\d+(?:\.x)?)(\s*(?:#.*)?)$/, update);
  } else if (name === '.tool-versions') {
    content = text.replace(/^(\s*nodejs\s+)(v?\d+(?:\.x)?)([ \t]*(?:#.*)?)$/gm, update);
  } else if (/(?:^|\/)Dockerfile(?:\.[\w-]+)?$|\.dockerfile$/i.test(name)) {
    content = text.replace(/^(\s*FROM\s+node:)(\d+)((?:-[a-z][a-z0-9.-]*)?(?:\s+AS\s+[\w-]+)?[ \t]*(?:#.*)?)$/gmi, update);
  } else if (/\.sh$/i.test(name)) {
    content = text.replace(/^([ \t]*(?:export\s+)?NODE_VERSION=)(["']?v?\d+(?:\.x)?["']?)([ \t]*(?:#.*)?)$/gm, update);
  } else if (/\.ps1$/i.test(name)) {
    content = text.replace(/^([ \t]*\$(?:env:)?NODE_?VERSION\s*=\s*)(["']?v?\d+(?:\.x)?["']?)([ \t]*(?:#.*)?)$/gmi, update);
  } else throw new Error(`Unsupported configured Node build file: ${name}`);
  return { content, changes, notes: content === text && /\d+\.\d+\.\d+/.test(text)
    ? ['Exact patch-version pins are not rewritten automatically.'] : [] };
}

function safePath(root, name) {
  if (!name || typeof name !== 'string' || name.includes('\\') || path.isAbsolute(name) ||
      /[:\x00-\x1f]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^\.git(?:\/|$)|^\.github\/(?:actions|lights-on|skills)(?:\/|$)|^\.github\/lights-on\.ya?ml$|^\.github\/workflows\/lights-on-/i.test(name)) {
    throw new Error('Unsafe toolchain maintenance path.');
  }
  const target = path.join(root, ...name.split('/'));
  let current = target;
  while (current !== path.resolve(root)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink in toolchain maintenance path.');
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Toolchain path is outside the repository.');
    current = parent;
  }
  return target;
}

export function planToolchainMaintenance({ repoRoot, schedule, config, now = Date.now() }) {
  if (config.enabled === false || config.toolchains?.enabled !== true) return { status: 'skipped', reason: 'Toolchain maintenance is disabled.', changes: [] };
  const node = config.toolchains.node || {};
  const policyName = node.support_policy || 'supported';
  const policy = lifecycle(schedule, policyName, now);
  const files = new Set();
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  if (node.update_ci !== false && fs.existsSync(workflowDir)) {
    for (const name of fs.readdirSync(workflowDir)) {
      if (/\.ya?ml$/.test(name) && !name.startsWith('lights-on-')) files.add(`.github/workflows/${name}`);
    }
  }
  if (node.update_runtime_files !== false) for (const name of ['.nvmrc', '.node-version', '.tool-versions']) {
    if (fs.existsSync(path.join(repoRoot, name))) files.add(name);
  }
  if (!Array.isArray(node.build_files || [])) throw new Error('toolchains.node.build_files must be a list of explicit file paths.');
  for (const name of node.build_files || []) {
    if (typeof name !== 'string' || !/(?:^|\/)Dockerfile(?:\.[\w-]+)?$|\.dockerfile$|\.(?:sh|ps1)$/i.test(name)) {
      throw new Error('Node build_files must name .sh/.ps1 scripts or Dockerfiles.');
    }
    files.add(name);
  }
  const changes = [];
  const notes = [];
  for (const file of files) {
    const filename = safePath(path.resolve(repoRoot), file);
    if (!fs.existsSync(filename)) { notes.push(`${file}: configured file is missing.`); continue; }
    if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > 1024 * 1024) throw new Error(`Invalid or oversized toolchain file: ${file}`);
    const before = fs.readFileSync(filename, 'utf8');
    const result = file.startsWith('.github/workflows/') ? updateNodeWorkflow(before, policy) : updateRuntimeFile(file, before, policy);
    notes.push(...result.notes.map((note) => `${file}: ${note}`));
    if (result.content !== before) changes.push({ file, before_sha256: hash(before), content: result.content, reasons: result.changes });
  }
  return { status: changes.length ? 'ready' : 'skipped', reason: changes.length ? 'Node lifecycle changes proposed.' : 'No supported automatic edits were needed.',
    policy: policyName, target: policy.target, evaluated_at: new Date(now).toISOString(),
    source: NODE_SCHEDULE_URL, changes, notes };
}

export async function maintainToolchains({ repoRoot = process.cwd(), config = loadConfig({ repoRoot }), publish = false,
  env = process.env, fetchImpl = globalThis.fetch, execFileImpl = execFileSync, now = Date.now() } = {}) {
  if (config.enabled === false || config.toolchains?.enabled !== true) {
    reportWorkflowEvent({ title: 'Toolchain maintenance skipped', message: 'Opt-in toolchain maintenance is disabled.' }, { env });
    return { status: 'skipped', changes: [] };
  }
  const response = await fetchImpl(NODE_SCHEDULE_URL, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Could not fetch official Node lifecycle data; no toolchain edits made.');
  const plan = planToolchainMaintenance({ repoRoot, config, schedule: await response.json(), now });
  reportWorkflowEvent({ title: `Toolchain maintenance ${plan.status}`, message: plan.reason,
    details: { Policy: plan.policy, 'Target Node major': plan.target,
      'Changed files': plan.changes.map((item) => item.file).join(', ') || 'none', Notes: plan.notes.join('; ') || 'none' } }, { env });
  if (!publish || !plan.changes.length) return plan;
  const repo = assertWriteTargetIsInstalledRepo(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY);
  const base = env.DEFAULT_BRANCH;
  if (!base || base.startsWith('-')) throw new Error('Toolchain publication requires the default branch.');
  const run = (cmd, args, options = {}) => execFileImpl(cmd, args, { cwd: repoRoot, env, encoding: 'utf8', ...options });
  if (run('git', ['status', '--porcelain']).trim()) throw new Error('Toolchain maintenance requires a clean checkout; unrelated changes will not be published.');
  const branch = `lights-on/toolchain-node-${hash(JSON.stringify(plan.changes)).slice(0, 16)}`;
  const title = `chore(ci): maintain Node runtimes (${plan.policy})`;
  const body = neutralizeCrossRepoAutoLinks([
    `Node lifecycle policy: **${plan.policy}**. Evaluated at ${plan.evaluated_at}.`,
    `Official schedule: ${NODE_SCHEDULE_URL}`,
    ...plan.changes.flatMap((change) => change.reasons.map((reason) => `- ${change.file}: ${reason}`)),
    '',
    '**Maintainer review required:** this changes build/test coverage, not package.json engines or the public runtime-support contract.',
    'No build scripts were executed by this updater. Run candidate CI and review any removed test coverage.',
    'Update branch protection and autonomy.required_checks separately if they still name removed matrix checks.',
    'The lights-on:hold label prevents automatic merging. Protected workflow changes also require the normal approved-override or manual merge.',
    ...plan.notes
  ].join('\n'), '', { installedRepo: repo });
  const existing = JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--base', base,
    '--state', 'open', '--json', 'headRefName,isCrossRepository']));
  if (!Array.isArray(existing)) throw new Error('Invalid existing toolchain PR response.');
  if (!existing.some((pr) => pr.headRefName === branch && pr.isCrossRepository === false)) {
    for (const change of plan.changes) {
      if (hash(fs.readFileSync(safePath(path.resolve(repoRoot), change.file), 'utf8')) !== change.before_sha256) {
        throw new Error('Toolchain source changed during planning.');
      }
    }
    run('git', ['checkout', '-B', branch]);
    for (const change of plan.changes) fs.writeFileSync(safePath(path.resolve(repoRoot), change.file), change.content);
    run('git', ['add', '--', ...plan.changes.map((change) => change.file)]);
    run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', title, '-m', describeCommit({
        result: { summary: `Maintain Node runtimes using the ${plan.policy} lifecycle policy.`,
          details: { rationale: plan.changes.flatMap((change) => change.reasons).join(' ') }, hold: true },
        files: plan.changes.map((change) => change.file)
      })]);
    run('git', ['push', '-u', 'origin', branch, '--force']);
  }
  const pr = publishPr({ repo, installedRepo: repo, head: branch, base, title, body,
    labels: ['lights-on:dependencies', 'lights-on:hold'], env, execFileImpl: (cmd, args, options) => run(cmd, args, options) });
  run('git', ['checkout', base]);
  return { ...plan, pr };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await maintainToolchains({ publish: process.argv.includes('--publish') });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    reportWorkflowEvent({ level: 'error', title: 'Toolchain maintenance failed', message: err.message });
    process.exitCode = 1;
  }
}
