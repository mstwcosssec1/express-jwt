import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export function safeReportText(value, env = process.env, maxLength = 2000) {
  let text = stripVTControlCharacters(String(value ?? ''));
  const secrets = Object.entries(env)
    .filter(([key, secret]) => /token|secret|password|api_?key|credential|authorization/i.test(key) &&
      typeof secret === 'string' && secret.length > 0)
    .flatMap(([, secret]) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  return text.length > maxLength ? `${text.slice(0, maxLength)} [truncated]` : text;
}

const commandData = (value) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const markdown = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_[\]{}()#!|])/g, '\\$1').replace(/\r?\n/g, '<br>');

export function githubItemUrl(repo, kind, number, env = process.env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') ||
      !['pull', 'issues'].includes(kind) || !/^[1-9]\d*$/.test(String(number || ''))) {
    throw new Error('Invalid GitHub item identity for workflow reporting.');
  }
  const server = new URL(env.GITHUB_SERVER_URL || 'https://github.com');
  if (server.protocol !== 'https:' || server.username || server.password) throw new Error('Invalid GitHub server URL.');
  return `${server.origin}/${repo}/${kind}/${number}`;
}

// Write annotations to stderr, keeping JSON stdout usable by subsequent workflow steps.
export function reportWorkflowEvent({ level = 'notice', title, message, url, details = {} },
  { env = process.env, write = (line) => console.error(line) } = {}) {
  if (!['notice', 'warning', 'error'].includes(level)) throw new Error('Invalid workflow annotation level.');
  const heading = safeReportText(title, env, 160).replace(/[\r\n]+/g, ' ');
  const body = safeReportText(message, env);
  const fields = Object.entries(details).slice(0, 12).map(([key, value]) =>
    [safeReportText(key, env, 100), safeReportText(value, env, 500)]);
  let link = '';
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.search || /[\r\n]/.test(url) || safeReportText(parsed.href, env, 4000) !== parsed.href) {
      throw new Error('Unsafe URL in workflow report.');
    }
    link = parsed.href;
  }
  const annotation = `${body}${link ? ` ${link}` : ''}`;
  if (env.GITHUB_ACTIONS === 'true') {
    write(`::${level} title=${commandData(heading).replace(/,/g, '%2C').replace(/:/g, '%3A')}::${commandData(annotation)}`);
  } else {
    write(`[${level}] ${heading}: ${annotation.replace(/[\r\n]+/g, ' ')}`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const linkTarget = link.replace(/[()<>"\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const summary = `\n### ${markdown(heading)}\n\n${markdown(body)}\n\n` +
      (link ? `[Open in GitHub](${linkTarget})\n\n` : '') +
      fields.map(([key, value]) => `- **${markdown(key)}:** ${markdown(value)}`).join('\n') + '\n';
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
}

export function reportMergeDecision(decision, { env = process.env } = {}) {
  const allowed = decision?.allowAutoMerge === true;
  const reasons = Array.isArray(decision?.reasons) ? decision.reasons.join(', ') : '';
  reportWorkflowEvent({
    level: allowed ? 'notice' : 'warning',
    title: allowed ? 'PR eligible for auto-merge' : 'PR auto-merge blocked',
    message: allowed
      ? `PR #${env.PR_NUMBER} passed the merge gate. This is eligibility, not confirmation of a merge.`
      : `PR #${env.PR_NUMBER} was not authorized to merge: ${reasons || 'missing gate decision'}.`,
    url: githubItemUrl(env.GITHUB_REPOSITORY, 'pull', env.PR_NUMBER, env),
    details: { 'Head SHA': env.HEAD_SHA || '', 'CI status': env.CI_STATUS || 'unknown' }
  }, { env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const key = { '--title': 'title', '--message': 'message', '--level': 'level', '--url': 'url',
        '--merge-decision': 'mergeDecision' }[process.argv[i]];
      if (!key || process.argv[i + 1] === undefined) throw new Error('Invalid workflow-report arguments.');
      options[key] = process.argv[++i];
    }
    if (options.mergeDecision) reportMergeDecision(JSON.parse(fs.readFileSync(options.mergeDecision, 'utf8')));
    else reportWorkflowEvent(options);
  } catch (err) {
    console.error(`Workflow reporting failed: ${safeReportText(err.message)}`);
    process.exitCode = 1;
  }
}
