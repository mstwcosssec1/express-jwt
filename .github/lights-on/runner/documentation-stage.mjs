import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './github-io.mjs';
import { assertWriteTargetIsInstalledRepo } from './sync-upstream.mjs';
import { describeChange, describeCommit } from './describe-change.mjs';
import { plainPublicationText } from './publication-text.mjs';
import { publishPr } from './publish-pr.mjs';
import { reportWorkflowEvent, githubItemUrl } from './workflow-report.mjs';

const PREFIX = 'lights-on/docs-clarification-';
const SHA = /^[a-f0-9]{40}$/;

function controller({ repoRoot = process.cwd(), base, env = process.env, execFileImpl = execFileSync }) {
  const repo = assertWriteTargetIsInstalledRepo(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY);
  if (typeof base !== 'string' || !base || base.startsWith('-')) {
    throw new Error('Documentation work requires a valid target branch.');
  }
  const run = (cmd, args) => execFileImpl(cmd, args, { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  run('git', ['check-ref-format', `refs/heads/${base}`]);
  const sourceSha = run('git', ['rev-parse', '--verify', 'HEAD']).trim();
  const sourceTree = run('git', ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
  if (!SHA.test(sourceSha) || !SHA.test(sourceTree)) throw new Error('Invalid documentation source identity.');
  const workId = createHash('sha256').update(JSON.stringify({
    version: 1, task: 'docs-clarifier', repo: repo.toLowerCase(), base, sourceTree
  })).digest('hex');
  const identity = { repo, base, source_sha: sourceSha, source_tree: sourceTree,
    work_id: workId, branch: `${PREFIX}${workId}` };
  const api = (endpoint, paginate = false) => {
    const data = JSON.parse(run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), `repos/${repo}/${endpoint}`]));
    if (!paginate) return data;
    if (!Array.isArray(data) || !data.length || !data.every(Array.isArray)) {
      throw new Error('Invalid documentation PR history response.');
    }
    return data.flat();
  };
  const pulls = (query, paginate = true) => {
    const items = api(`pulls?base=${encodeURIComponent(base)}&per_page=100&${query}`, paginate);
    if (!Array.isArray(items) || !items.every((pr) => pr &&
      Number.isSafeInteger(pr.number) && pr.number > 0 &&
      ['open', 'closed'].includes(pr.state) && typeof pr.title === 'string' &&
      (pr.body === null || typeof pr.body === 'string') &&
      (pr.merged_at === null || typeof pr.merged_at === 'string') &&
      pr.base?.ref === base && pr.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase() &&
      typeof pr.head?.ref === 'string' && SHA.test(pr.head.sha) &&
      (pr.head.repo === null || typeof pr.head.repo?.full_name === 'string'))) {
      throw new Error('Invalid documentation PR inventory; refusing to assume there is no previous work.');
    }
    return items.filter((pr) => pr.head.repo?.full_name.toLowerCase() === repo.toLowerCase() &&
      pr.head.ref.startsWith(PREFIX));
  };
  const check = () => {
    const ref = api(`git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`);
    if (ref?.ref !== `refs/heads/${base}` || ref.object?.type !== 'commit' || !SHA.test(ref.object.sha)) {
      throw new Error('Invalid documentation target-branch response.');
    }
    if (ref.object.sha !== sourceSha) {
      return { ...identity, status: 'skipped', reason: 'target-branch-changed' };
    }
    const open = pulls('state=open');
    if (open.some((pr) => pr.state !== 'open')) throw new Error('Open documentation PR lookup returned closed work.');
    if (open.length) {
      return { ...identity, status: 'skipped', reason: 'open-documentation-pr-exists', pr_number: open[0].number };
    }
    const previous = pulls(`state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${identity.branch}`)}`)
      .find((pr) => pr.head.ref === identity.branch);
    if (previous) {
      return { ...identity, status: 'skipped', pr_number: previous.number,
        reason: previous.state === 'open' ? 'open-documentation-pr-exists' :
          previous.merged_at ? 'documentation-work-already-merged' : 'documentation-work-previously-closed' };
    }
    const refs = api(`git/matching-refs/heads/${identity.branch}`);
    const fullRef = `refs/heads/${identity.branch}`;
    if (!Array.isArray(refs) || !refs.every((ref) => typeof ref?.ref === 'string' &&
        ref.ref.startsWith(fullRef) && ref.object?.type === 'commit' && SHA.test(ref.object.sha))) {
      throw new Error('Invalid documentation branch inventory.');
    }
    if (refs.some((ref) => ref.ref === fullRef || ref.ref.startsWith(`${fullRef}/`))) {
      return { ...identity, status: 'skipped', reason: 'documentation-branch-already-exists' };
    }
    return { ...identity, status: 'ready' };
  };
  return { run, check, identity, pulls, repo };
}

function report(selection, env) {
  reportWorkflowEvent({ title: `Documentation selection ${selection.status}`,
    message: selection.reason || 'New documentation work selected; no PR has been published.',
    ...(selection.pr_number ? { url: githubItemUrl(selection.repo, 'pull', selection.pr_number, env) } : {}),
    details: { 'Source commit': selection.source_sha, 'Work ID': selection.work_id,
      'Target branch': selection.base } }, { env });
}

export function prepareDocumentationStage(options = {}) {
  const env = options.env || process.env;
  const { run, check, pulls } = controller(options);
  if (run('git', ['status', '--porcelain']).trim()) {
    throw new Error('Documentation selection requires a clean checkout; unrelated changes will not be published.');
  }
  const selection = check();
  let context;
  if (selection.status === 'ready') {
    const upstream = options.contextFile ? JSON.parse(fs.readFileSync(options.contextFile, 'utf8')) : {};
    if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) {
      throw new Error('Invalid upstream documentation context.');
    }
    // This bounded context is advisory. Exact work-ID history above is fully paginated.
    const recent = pulls('state=closed&sort=updated&direction=desc', false);
    context = { ...upstream, documentation_history: {
      work_id: selection.work_id, source_tree: selection.source_tree,
      scope: 'Up to 20 documentation PRs from the 100 most recently updated closed PRs for this base.',
      pull_requests: recent.slice(0, 20).map((pr) => ({
        number: pr.number, state: pr.merged_at ? 'merged' : 'closed',
        head_sha: pr.head.sha, title: pr.title, body: (pr.body || '').slice(0, 4000),
        body_truncated: (pr.body || '').length > 4000
      }))
    } };
  }
  report(selection, env);
  return { selection, context };
}

export function publishDocumentationStage({ selection, result, ...options }) {
  const env = options.env || process.env;
  const { run, check, identity, repo } = controller(options);
  if (!selection || selection.status !== 'ready' ||
      Object.keys(identity).some((key) => selection[key] !== identity[key])) {
    throw new Error('Documentation source or selection changed; refusing publication.');
  }
  if (result?.status !== 'completed') {
    throw new Error('Documentation publication requires its own completed agent result.');
  }
  const files = [...new Set([
    ...run('git', ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...run('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
  ].filter(Boolean))].sort();
  if (result.dry_run && files.length) throw new Error('Dry-run documentation result has source changes; refusing publication.');
  if (!files.length) {
    reportWorkflowEvent({ title: 'Documentation publication skipped',
      message: result.dry_run ? 'Dry run; no PR was published.' : 'No documentation changes were produced; no PR was published.' }, { env });
    return { published: false };
  }
  const current = check();
  if (current.status !== 'ready') {
    report(current, env);
    throw new Error(`Documentation publication blocked: ${current.reason}. The candidate was not published.`);
  }
  const title = plainPublicationText(result.pr_title || 'docs: clarify documentation');
  const body = describeChange({ result, files, env });
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  run('git', ['checkout', '-b', selection.branch]);
  run('git', ['add', '--', ...files]);
  run('git', ['commit', '-m', title, '-m', describeCommit({ result, files })]);
  run('git', ['push', '-u', 'origin', selection.branch]);
  const published = publishPr({ repo, installedRepo: repo, head: selection.branch, base: selection.base,
    title, body, labels: ['lights-on:docs'], env,
    execFileImpl: (cmd, args) => run(cmd, args) });
  run('git', ['checkout', selection.base]);
  return { published: true, ...published };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { base: process.env.DEFAULT_BRANCH, contextFile: process.env.UPSTREAM_CONTEXT };
    const selectionFile = '/tmp/lights-on-docs-selection.json';
    if (process.argv[2] === '--prepare') {
      const { selection, context } = prepareDocumentationStage(options);
      fs.writeFileSync(selectionFile, JSON.stringify(selection));
      if (context) fs.writeFileSync('/tmp/lights-on-docs-context.json', JSON.stringify(context));
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${selection.status === 'ready'}\n`);
    } else if (process.argv[2] === '--publish') {
      publishDocumentationStage({ ...options,
        selection: JSON.parse(fs.readFileSync(selectionFile, 'utf8')),
        result: JSON.parse(fs.readFileSync('/tmp/lights-on-docs-result.json', 'utf8')) });
    } else throw new Error('Expected --prepare or --publish.');
  } catch (error) {
    reportWorkflowEvent({ level: 'error', title: 'Documentation maintenance failed', message: error.message });
    process.exitCode = 1;
  }
}
