import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from './github-io.mjs';
import { fileURLToPath } from 'node:url';
import { loadConfig, sanitizeGitHubOutputValue } from './load-config.mjs';
import { loadState, saveState, recordCooldown, formatStateComment, parseStateFromText, isTrustedStateAuthor } from './state-store.mjs';
import { assertWriteTargetIsInstalledRepo, neutralizeCrossRepoAutoLinks } from './sync-upstream.mjs';
import { ensureLabels } from './ensure-labels.mjs';
import { publishPr } from './publish-pr.mjs';
import { selectDependencyWork, dependencyFileHash } from './dependency-work.mjs';
import { reportWorkflowEvent, githubItemUrl } from './workflow-report.mjs';

function githubSnapshot(repo, execFileImpl, env) {
  const api = (endpoint) => {
    const pages = JSON.parse(execFileImpl('gh', ['api', '--paginate', '--slurp', endpoint], { env, encoding: 'utf8' }));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Invalid dependency deduplication response.');
    return pages.flat();
  };
  return api(`repos/${repo}/pulls?state=open&per_page=100`).map((pr) => ({
    headRefName: pr.head?.ref, files: api(`repos/${repo}/pulls/${pr.number}/files?per_page=100`).map((file) => file.filename)
  }));
}

export function prepareDependencyStage({ report, repoRoot = process.cwd(), config = loadConfig({ repoRoot }),
  env = process.env, execFileImpl = execFileSync, state = loadState(), mode = 'updates', planId = '' }) {
  const repo = assertWriteTargetIsInstalledRepo(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY);
  let openPlans = [];
  if (mode === 'migration-plan') {
    const issues = JSON.parse(execFileImpl('gh', ['issue', 'list', '--repo', repo, '--state', 'open',
      '--limit', '1000', '--json', 'number,author,body'], { env, encoding: 'utf8' }));
    if (!Array.isArray(issues)) throw new Error('Invalid migration plan lookup response.');
    openPlans = issues.filter((item) => isTrustedStateAuthor(item.author))
      .map((item) => parseStateFromText(item.body))
      .filter((item) => item?.task === 'dependency-migration-planner').map((item) => item.dependency_key);
  }
  return selectDependencyWork({ report, repoRoot, config, state, mode, planId,
    openPlans, openPrs: githubSnapshot(repo, execFileImpl, env) });
}

export function publishDependencyStage({ selection, result, repoRoot = process.cwd(), base, stateFile,
  env = process.env, execFileImpl = execFileSync }) {
  if (result.status === 'failed') throw new Error('Dependency agent execution failed; refusing publication.');
  const repo = assertWriteTargetIsInstalledRepo(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY);
  if (typeof base !== 'string' || !base || base.startsWith('-')) throw new Error('Dependency publication requires a valid base branch.');
  const run = (cmd, args, extra = {}) => execFileImpl(cmd, args, { cwd: repoRoot, env, encoding: 'utf8', ...extra });
  if (selection.status !== 'ready' || result.status === 'skipped' || result.dry_run) {
    reportWorkflowEvent({ title: 'Dependency publication skipped',
      message: selection.reason || result.summary || 'No work item selected; no PR was published.' }, { env });
    return { published: false };
  }
  const evidence = result.dependency_validation;
  const planning = selection.task === 'dependency-migration-planner';
  if (!planning && result.status === 'completed' && evidence?.status === 'passed' && evidence.key === selection.key) {
    const changed = [...new Set([
      ...run('git', ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
      ...run('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
    ].filter(Boolean))].sort();
    if (!evidence.files?.length || JSON.stringify(changed) !== JSON.stringify(evidence.files.map((item) => item.path).sort())) {
      throw new Error('Working changes do not match the validated dependency candidate.');
    }
    for (const file of evidence.files) {
      if (file.sha256 === null ? fs.existsSync(path.join(repoRoot, file.path)) :
        dependencyFileHash(repoRoot, file.path) !== file.sha256) throw new Error('Dependency candidate changed after validation.');
    }
    const body = formatStateComment(
      neutralizeCrossRepoAutoLinks(result.pr_body || result.summary || '', '', { installedRepo: repo }) +
      `\n\nController verification: ${evidence.checks.length} command(s) passed in a fresh offline worker. ` +
      'Independent PR review and CI are still required.\n\n' +
      `Selected dependency: \`${selection.dependency.name}\`; manifest: \`${selection.dependency.manifest}\`.`,
      { task: selection.task, dependency_key: selection.key });
    run('git', ['config', 'user.name', 'github-actions[bot]']);
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    run('git', ['checkout', '-B', selection.branch]);
    run('git', ['add', '--', ...changed]);
    const title = `chore(deps): ${selection.task === 'dependency-updater' ? 'update' : 'migrate'} ${selection.dependency.name}`;
    run('git', ['commit', '-m', title]);
    run('git', ['push', '-u', 'origin', selection.branch, '--force']);
    const published = publishPr({ repo, installedRepo: repo, head: selection.branch, base, title, body,
      labels: ['lights-on:dependencies'], execFileImpl: (cmd, args, opts) => run(cmd, args, opts), env });
    run('git', ['checkout', base]);
    return { published: true, ...published };
  }
  const reason = planning ? result.comment_body || result.summary : evidence?.reason || 'Missing controller validation evidence.';
  if (!reason) throw new Error('Dependency plan/blocker response is empty.');
  const state = loadState(stateFile ? { stateFile } : {});
  recordCooldown(state, selection.stateKey || selection.key, planning ? 'migration-plan-published' : String(reason), 48);
  const issues = JSON.parse(run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,author,body']));
  if (!Array.isArray(issues)) throw new Error('Invalid dependency issue lookup response.');
  const existing = issues.find((issue) => isTrustedStateAuthor(issue.author) &&
    parseStateFromText(issue.body)?.dependency_key === selection.key &&
    parseStateFromText(issue.body)?.task === selection.task);
  let issueUrl = existing ? githubItemUrl(repo, 'issues', existing.number, env) : '';
  if (!existing) {
    ensureLabels({ repo, installedRepo: repo, labels: ['lights-on:dependencies', 'lights-on:needs-human'], execFileImpl, env });
    const title = `${planning ? 'Dependency migration plan' : 'Dependency update blocked'}: ${selection.dependency.name}`;
    const body = formatStateComment(neutralizeCrossRepoAutoLinks(String(reason), '', { installedRepo: repo }) +
      '\n\nNo dependency code was published. Migration execution requires a reviewed approved_migrations configuration entry and a separate manual migration run.',
      { task: selection.task, dependency_key: selection.key });
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-dependency-issue-'));
    try {
      const bodyFile = path.join(temp, 'body.md');
      fs.writeFileSync(bodyFile, body);
      const output = String(run('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile,
        '--label', 'lights-on:dependencies,lights-on:needs-human'])).trim();
      const number = output.match(/\/issues\/([1-9]\d*)$/)?.[1];
      if (!number || output !== githubItemUrl(repo, 'issues', number, env)) {
        throw new Error('Could not verify dependency tracking issue URL.');
      }
      issueUrl = output;
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  saveState(state, stateFile ? { stateFile } : {});
  reportWorkflowEvent({ level: planning ? 'notice' : 'warning',
    title: planning ? 'Dependency migration plan tracked' : 'Dependency update blocked',
    message: `${existing ? 'Reused' : 'Created'} a tracking issue; no code PR was published.`,
    url: issueUrl, details: { Dependency: selection.dependency.name, Reason: reason } }, { env });
  return { published: false, tracked: true, url: issueUrl };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    if (process.argv.includes('--select')) {
      const selection = prepareDependencyStage({ report: read(process.env.DEPENDENCY_REPORT),
        mode: process.env.DEPENDENCY_MODE || 'updates', planId: process.env.MIGRATION_PLAN_ID || '' });
      fs.writeFileSync(process.env.DEPENDENCY_SELECTION, JSON.stringify(selection, null, 2));
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
        `ready=${selection.status === 'ready'}\ntask=${sanitizeGitHubOutputValue(selection.task || '')}\ntier=${selection.tier || 'default'}\n`);
      console.log(JSON.stringify(selection, null, 2));
      reportWorkflowEvent({ title: `Dependency selection ${selection.status}`,
        level: selection.status === 'blocked' ? 'warning' : 'notice',
        message: selection.reason || `${selection.task} selected; no PR has been published yet.`,
        details: { Dependency: selection.dependency?.name || 'none',
          Deferred: selection.deferred?.length || 0,
          Blockers: (selection.blockers || []).map((item) => `${item.key}: ${item.reason}`).join('; ') || 'none',
          Skipped: (selection.skipped || []).map((item) => `${item.key}: ${item.reason}`).join('; ') || 'none' } });
    } else if (process.argv.includes('--publish')) {
      publishDependencyStage({ selection: read(process.env.DEPENDENCY_SELECTION), result: read(process.env.DEPENDENCY_RESULT),
        base: process.env.DEFAULT_BRANCH });
    } else throw new Error('Specify --select or --publish.');
  } catch (err) {
    reportWorkflowEvent({ level: 'error', title: 'Dependency stage failed', message: err.message });
    console.error(`Dependency stage failed: ${err.message}`);
    process.exitCode = 1;
  }
}
