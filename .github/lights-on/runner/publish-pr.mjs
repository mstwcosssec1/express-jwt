import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './github-io.mjs';
import { literalPublicationBody, plainPublicationText } from './publication-text.mjs';
import fs from 'node:fs';
import { assertWriteTargetIsInstalledRepo } from './sync-upstream.mjs';
import { ensureLabels } from './ensure-labels.mjs';
import { reportWorkflowEvent, githubItemUrl } from './workflow-report.mjs';

function publishPrOperation({ repo = process.env.GITHUB_REPOSITORY,
  installedRepo = process.env.GITHUB_REPOSITORY, head, base, title, body, bodyFile,
  labels = [], closesIssue, execFileImpl = execFileSync, env = process.env } = {}) {
  const target = assertWriteTargetIsInstalledRepo(repo, installedRepo);
  if (!head || !base || !title || (typeof body !== 'string' && !bodyFile)) {
    throw new Error('PR publication requires head, base, title, and body or bodyFile.');
  }
  title = plainPublicationText(title);
  // Apply this even with an injected executor: no caller may bypass body handling.
  body = literalPublicationBody(bodyFile ? fs.readFileSync(bodyFile, 'utf8') : body);
  ensureLabels({ repo: target, installedRepo, labels, execFileImpl, env });
  const findExisting = () => {
    const items = JSON.parse(execFileImpl('gh', ['pr', 'list', '--repo', target,
      '--head', head, '--base', base, '--state', 'open', '--json', 'number,url,title,headRefName,baseRefName,headRepositoryOwner,isCrossRepository'],
    { env, encoding: 'utf8' }));
    if (!Array.isArray(items)) throw new Error('Invalid PR lookup response.');
    return items.find((item) => item.headRefName === head && item.baseRefName === base &&
      item.isCrossRepository === false &&
      item.headRepositoryOwner?.login?.toLowerCase() === target.split('/')[0].toLowerCase());
  };
  const existing = findExisting();
  if (existing) {
    return { created: false, url: existing.url, title: existing.title || title };
  }
  const args = ['pr', 'create', '--repo', target, '--head', head, '--base', base, '--title', title,
    '--body', body,
    ...(labels.length ? ['--label', labels.join(',')] : [])];
  try {
    const url = String(execFileImpl('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
      ...(closesIssue !== undefined ? { lightsOnClosesIssue: closesIssue } : {}) })).trim();
    return { created: true, url, title };
  } catch (err) {
    // A concurrent publisher may have opened the same PR; all other errors must fail the step.
    const concurrent = findExisting();
    if (concurrent) {
      return { created: false, url: concurrent.url, title: concurrent.title || title };
    }
    throw err;
  }
}

export function publishPr(options = {}) {
  const env = options.env || process.env;
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  const details = { Repository: repo, 'PR title': options.title, 'Head branch': options.head,
    'Base branch': options.base, Labels: (options.labels || []).join(', ') };
  let result;
  let number;
  try {
    result = publishPrOperation(options);
    number = result.url?.match(/\/pull\/([1-9]\d*)$/)?.[1];
    if (!number || result.url !== githubItemUrl(repo, 'pull', number, env)) {
      throw new Error('Could not verify the published PR URL for the installed repository.');
    }
  } catch (err) {
    reportWorkflowEvent({ level: 'error', title: 'PR publication failed',
      message: `Could not confirm PR publication for ${options.head || 'the candidate branch'}: ${err.message}`,
      details }, { env });
    throw err;
  }
  reportWorkflowEvent({ title: result.created ? 'Pull request created' : 'Existing pull request reused',
    message: `${result.created ? 'Created' : 'Reused'} PR #${number}: ${result.title}.`,
    url: result.url, details: { ...details, 'PR title': result.title } }, { env });
  return result;
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
