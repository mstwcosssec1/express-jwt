import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertWriteTargetIsInstalledRepo } from './sync-upstream.mjs';
import { ensureLabels } from './ensure-labels.mjs';

export function publishPr({ repo = process.env.GITHUB_REPOSITORY,
  installedRepo = process.env.GITHUB_REPOSITORY, head, base, title, body, bodyFile,
  labels = [], execFileImpl = execFileSync, env = process.env } = {}) {
  const target = assertWriteTargetIsInstalledRepo(repo, installedRepo);
  if (!head || !base || !title || (typeof body !== 'string' && !bodyFile)) {
    throw new Error('PR publication requires head, base, title, and body or bodyFile.');
  }
  ensureLabels({ repo: target, installedRepo, labels, execFileImpl, env });
  const findExisting = () => {
    const items = JSON.parse(execFileImpl('gh', ['pr', 'list', '--repo', target,
      '--head', head, '--base', base, '--state', 'open', '--json', 'number,url,headRefName,baseRefName,headRepositoryOwner,isCrossRepository'],
    { env, encoding: 'utf8' }));
    if (!Array.isArray(items)) throw new Error('Invalid PR lookup response.');
    return items.find((item) => item.headRefName === head && item.baseRefName === base &&
      item.isCrossRepository === false &&
      item.headRepositoryOwner?.login?.toLowerCase() === target.split('/')[0].toLowerCase());
  };
  const existing = findExisting();
  if (existing) {
    console.log(`Using existing PR: ${existing.url}`);
    return { created: false, url: existing.url };
  }
  const args = ['pr', 'create', '--repo', target, '--head', head, '--base', base, '--title', title,
    ...(bodyFile ? ['--body-file', bodyFile] : ['--body', body]),
    ...(labels.length ? ['--label', labels.join(',')] : [])];
  try {
    const url = String(execFileImpl('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })).trim();
    console.log(url);
    return { created: true, url };
  } catch (err) {
    // A concurrent publisher may have opened the same PR; all other errors must fail the step.
    if (findExisting()) {
      console.log('A concurrent run opened the PR for this head/base.');
      return { created: false };
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const keys = { '--head': 'head', '--base': 'base', '--title': 'title', '--body': 'body', '--body-file': 'bodyFile', '--label': 'labels' };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const key = keys[process.argv[i]];
      if (!key || process.argv[i + 1] === undefined) throw new Error('Invalid PR publisher arguments.');
      const value = process.argv[++i];
      options[key] = key === 'labels' ? value.split(',') : value;
    }
    publishPr(options);
  } catch (err) {
    console.error(`Lights On PR publication failed: ${err.message}`);
    process.exitCode = 1;
  }
}
