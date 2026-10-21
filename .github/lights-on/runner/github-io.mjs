import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync as nativeExecFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markdownPublicationBody, plainPublicationText, commitPublicationText, conciseCommitText } from './publication-text.mjs';

export function githubEnvironment(env = process.env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_SERVER_URL.replace(/\/$/, '') !== 'https://github.com') {
    throw new Error('REPO_WRITE_VIOLATION: Only github.com installations are supported.');
  }
  const result = { ...env, GH_HOST: 'github.com' };
  delete result.GH_REPO;
  delete result.GH_ENTERPRISE_TOKEN;
  delete result.GITHUB_ENTERPRISE_TOKEN;
  return result;
}

function installedRepository(env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('REPO_WRITE_VIOLATION: Set GITHUB_REPOSITORY to the installed owner/repo before using GitHub publication helpers.');
  }
  return repo;
}

export function prepareGitHubArgs(args, env = process.env) {
  const repo = installedRepository(env);
  const prepared = [...args];
  if (prepared[0] === 'api') {
    if (prepared.includes('--hostname')) {
      const index = prepared.indexOf('--hostname');
      if (prepared[index + 1] !== 'github.com') throw new Error('REPO_WRITE_VIOLATION: External GitHub host.');
      prepared.splice(index, 2);
    }
    if (prepared.some((arg) => arg.startsWith('--hostname='))) throw new Error('Use a separate --hostname argument.');
    const endpoints = prepared.filter((arg) => /^\/?repos\//.test(arg));
    if (endpoints.length !== 1 || !endpoints[0].replace(/^\//, '').toLowerCase().startsWith(`repos/${repo.toLowerCase()}/`)) {
      // Repository metadata requests have no suffix.
      if (endpoints.length !== 1 || endpoints[0].replace(/^\//, '').toLowerCase() !== `repos/${repo.toLowerCase()}`) {
        throw new Error('REPO_WRITE_VIOLATION: GitHub API endpoint must target the installed repository.');
      }
    }
    if (prepared.some((arg) => /^https?:\/\//i.test(arg))) {
      // Absolute URLs as API endpoints bypass --hostname. None of our API calls need them.
      throw new Error('REPO_WRITE_VIOLATION: Absolute API URLs are not allowed.');
    }
    const methodIndex = prepared.findIndex((arg) => arg === '-X' || arg === '--method');
    const attachedMethod = prepared.find((arg) => /^-X[A-Z]+$|^--method=/i.test(arg));
    const method = methodIndex >= 0 ? prepared[methodIndex + 1] :
      attachedMethod ? attachedMethod.replace(/^-X|^--method=/i, '') : null;
    const hasBody = prepared.some((arg) => /^-[fF]|^--(?:raw-field|field|input)(?:=|$)/.test(arg));
    const mutation = method ? !['GET', 'HEAD'].includes(method.toUpperCase()) : hasBody;
    if (mutation && endpoints[0] !== `repos/${repo}/releases/generate-notes`) {
      throw new Error('REPO_WRITE_VIOLATION: Direct API mutations bypass literal body handling; use the scoped publication commands.');
    }
    return [...prepared, '--hostname', 'github.com'];
  }
  const repoFlags = prepared.flatMap((arg, index) => arg === '--repo' ? [index] : []);
  if (repoFlags.length !== 1 || prepared.some((arg) => arg === '-R' || arg.startsWith('-R') || arg.startsWith('--repo='))) {
    throw new Error('REPO_WRITE_VIOLATION: GitHub commands require exactly one explicit --repo.');
  }
  const index = repoFlags[0];
  const value = prepared[index + 1];
  if (typeof value !== 'string' || value.replace(/^github\.com\//, '').toLowerCase() !== repo.toLowerCase()) {
    throw new Error('REPO_WRITE_VIOLATION: GitHub command targets another repository.');
  }
  prepared[index + 1] = `github.com/${repo}`;
  // gh can use a positional PR/issue URL instead of --repo. Our callers use IDs.
  if (['pr', 'issue'].includes(prepared[0]) && ['comment', 'review', 'edit', 'merge', 'ready', 'view'].includes(prepared[1]) &&
      prepared[2] && !prepared[2].startsWith('-') && !/^[1-9]\d*$/.test(prepared[2])) {
    throw new Error('REPO_WRITE_VIOLATION: PR/issue operations must use a numeric installed-repository item ID.');
  }
  if (prepared.includes('--generate-notes')) {
    throw new Error('Generate release notes separately so they can be rendered literally before publication.');
  }
  if (prepared[0] === 'pr' && prepared[1] === 'review') {
    throw new Error('Use submitCommitReview to bind a review to the exact reviewed commit.');
  }
  if (prepared[0] === 'pr' && prepared[1] === 'merge') {
    if (prepared.includes('--rebase')) throw new Error('Rebase merging cannot sanitize rewritten commit messages; use squash or a reviewed manual merge.');
    if (!prepared.includes('--subject')) prepared.push('--subject', `Merge PR ${prepared[2]}`);
    if (!prepared.includes('--body') && !prepared.includes('--body-file')) prepared.push('--body', 'Merged by Lights On after review and CI verification.');
  }
  return prepared;
}

export function runGitHub(args, options = {}, execFileImpl = nativeExecFileSync) {
  const env = githubEnvironment(options.env || process.env);
  const prepared = prepareGitHubArgs(args, env);
  const directories = [];
  const execOptions = { ...options, env };
  const closesIssue = execOptions.lightsOnClosesIssue;
  delete execOptions.lightsOnClosesIssue;
  try {
    if (prepared[0] === 'pr' && prepared[1] === 'merge' &&
        (!args.includes('--subject') || !args.includes('--body') && !args.includes('--body-file'))) {
      const current = JSON.parse(runGitHub(['api', `repos/${installedRepository(env)}/pulls/${prepared[2]}`],
        { env, encoding: 'utf8' }, execFileImpl));
      const expectedIndex = prepared.indexOf('--match-head-commit');
      if (current.state !== 'open' || current.merged || !/^[a-f0-9]{40}$/i.test(current.head?.sha || '') ||
          expectedIndex < 0 || current.head.sha !== prepared[expectedIndex + 1] ||
          typeof current.title !== 'string' || !current.title.trim() ||
          current.body !== null && typeof current.body !== 'string') {
        throw new Error('Cannot preserve merge description: PR identity, content or reviewed head changed.');
      }
      if (!args.includes('--subject')) prepared[prepared.indexOf('--subject') + 1] = current.title;
      if (!args.includes('--body') && !args.includes('--body-file')) {
        prepared[prepared.indexOf('--body') + 1] =
          `${conciseCommitText(current.body || 'No PR description was supplied.')}\n\nFull details: PR ${prepared[2]}.\nReviewed head: ${current.head.sha}`;
      }
    }
    for (let i = 0; i < prepared.length; i++) {
      if (['--title', '--subject'].includes(prepared[i])) {
        prepared[i + 1] = plainPublicationText(prepared[i + 1]); i++;
      } else if (['--body', '--notes', '--body-file', '--notes-file'].includes(prepared[i])) {
        const fromFile = prepared[i].endsWith('-file');
        if (prepared[i + 1] === undefined || (fromFile && prepared[i + 1] === '-')) throw new Error('A publication body must be supplied explicitly.');
        const text = fromFile ? fs.readFileSync(path.resolve(options.cwd || process.cwd(), prepared[i + 1]), 'utf8') : prepared[i + 1];
        let rendered = prepared[0] === 'pr' && prepared[1] === 'merge' ? commitPublicationText(text) : markdownPublicationBody(text);
        if (closesIssue !== undefined) {
          if (prepared[0] !== 'pr' || prepared[1] !== 'create' || !Number.isSafeInteger(closesIssue) || closesIssue <= 0) {
            throw new Error('Invalid trusted local issue-closing request.');
          }
          rendered += `\n\nCloses #${closesIssue}`;
        }
        if (fromFile) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-publication-'));
          directories.push(dir);
          const file = path.join(dir, 'body.md');
          fs.writeFileSync(file, rendered, { mode: 0o600 });
          prepared[i + 1] = file;
        } else prepared[i + 1] = rendered;
        i++;
      }
    }
    return execFileImpl('gh', prepared, execOptions);
  } finally {
    for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function execFileSync(command, args, options = {}) {
  if (command === 'gh') return runGitHub(args, options);
  if (command === 'git' && args[0] === 'push') return pushGit(args.slice(1), options);
  if (command === 'git' && args.includes('commit')) {
    const safe = [...args];
    let messages = 0;
    const render = (value) => messages++ === 0 ? plainPublicationText(value) : commitPublicationText(value);
    for (let i = 0; i < safe.length; i++) {
      if (safe[i] === '-m' || safe[i] === '--message') safe[++i] = render(safe[i]);
      else if (safe[i].startsWith('--message=')) safe[i] = `--message=${render(safe[i].slice(10))}`;
    }
    return nativeExecFileSync(command, safe, options);
  }
  return nativeExecFileSync(command, args, options);
}

export function pushGit(args, options = {}, execFileImpl = nativeExecFileSync) {
  const env = githubEnvironment(options.env || process.env);
  const repo = installedRepository(env);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Git publication requires a valid GH_TOKEN or GITHUB_TOKEN for this step.');
  }
  const flags = new Set(['-u', '--set-upstream', '--force', '--force-with-lease']);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' ||
      (arg.startsWith('-') && !flags.has(arg)))) throw new Error('Unsupported Git publication arguments.');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const ref = positional[1] || '';
  const branch = /^(?:refs\/heads\/)?lights-on\/[A-Za-z0-9._/-]+$/.test(ref);
  const tag = /^refs\/tags\/v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ref);
  if (positional.length !== 2 || positional[0] !== 'origin' || (!branch && !tag) ||
      ref.includes('..') || ref.endsWith('.lock') ||
      (tag && args.some((arg) => arg === '--force' || arg === '--force-with-lease'))) {
    throw new Error('Git publication is limited to automation branches and non-forced release tags on origin.');
  }
  const urls = String(execFileImpl('git', ['remote', 'get-url', '--push', '--all', 'origin'],
    { ...options, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim().split(/\r?\n/);
  const allowed = [`https://github.com/${repo}`, `https://github.com/${repo}.git`].map((url) => url.toLowerCase());
  if (urls.length !== 1 || !allowed.includes(urls[0].replace(/\/$/, '').toLowerCase())) {
    throw new Error('REPO_WRITE_VIOLATION: Git push origin must be the installed HTTPS GitHub repository.');
  }
  // Credentials come from this step's environment; token/helper settings are not written to Git config.
  return execFileImpl('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false', 'push', ...args],
  { ...options, env: { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
}

export function submitCommitReview({ prNumber, headSha, verdict, body, env = process.env,
  execFileImpl = nativeExecFileSync }) {
  const boundEnv = githubEnvironment(env);
  const repo = installedRepository(boundEnv);
  if (!/^[1-9]\d*$/.test(String(prNumber)) || !/^[a-f0-9]{40}$/i.test(headSha || '')) {
    throw new Error('Review requires a numeric PR and a valid reviewed commit SHA.');
  }
  const current = JSON.parse(runGitHub(['api', `repos/${repo}/pulls/${prNumber}`],
    { env: boundEnv, encoding: 'utf8' }, execFileImpl));
  if (current.state !== 'open' || current.merged || current.head?.sha !== headSha ||
      current.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error('PR changed or closed during review; refusing to publish a stale review.');
  }
  let event = { APPROVE: 'APPROVE', APPROVED: 'APPROVE', REQUEST_CHANGES: 'REQUEST_CHANGES',
    CHANGES_REQUESTED: 'REQUEST_CHANGES' }[String(verdict).toUpperCase()] || 'COMMENT';
  // GitHub disallows approving one's own PR. A comment records the SHA-bound
  // assessment without pretending GitHub accepted a formal approval.
  if (current.user?.login === 'github-actions[bot]') event = 'COMMENT';
  const payload = { commit_id: headSha, event, body: markdownPublicationBody(body) };
  const result = JSON.parse(execFileImpl('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews`,
    '--hostname', 'github.com', '--method', 'POST', '--input', '-'],
  { env: boundEnv, encoding: 'utf8', input: JSON.stringify(payload) }));
  if (result.commit_id !== headSha) throw new Error('GitHub did not confirm the reviewed commit identity.');
  return { event, commit_id: result.commit_id, url: result.html_url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'git-push') pushGit(process.argv.slice(3), { stdio: 'inherit' });
    else runGitHub(process.argv.slice(2), { stdio: 'inherit' });
  } catch {
    console.error('Lights On GitHub operation failed; no external host/repository fallback is permitted.');
    process.exitCode = 1;
  }
}
