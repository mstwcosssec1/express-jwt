import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { commitPublicationText, conciseCommitText, markdownPublicationBody, plainPublicationText } from './publication-text.mjs';

export function describeChange({ result, files = result?.files_changed || [], validation,
  notes = [], env = process.env } = {}) {
  const summary = result?.summary || result?.prTitle || result?.reason;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new Error('A change description requires a nonempty result summary.');
  }
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string' && file.trim())) {
    throw new Error('A change description requires a valid changed-file list.');
  }
  const sections = ['## Summary', summary.trim()];
  const details = result.pr_body || result.prBody;
  if (typeof details === 'string' && details.trim() && details.trim() !== summary.trim()) {
    sections.push('## Change details (agent-reported)', details.trim());
  }
  if (typeof result.details?.rationale === 'string' && result.details.rationale.trim()) {
    sections.push('## Rationale (agent-reported)', result.details.rationale.trim());
  }
  if (Array.isArray(result.details?.citations) && result.details.citations.every((item) => typeof item === 'string') &&
      result.details.citations.length) {
    sections.push('## Evidence cited by the agent', result.details.citations.map((item) => `- ${item}`).join('\n'));
  }
  sections.push('## Changed files', [...new Set(files)].map((file) => `- ${file}`).join('\n') || 'No changed-file inventory supplied.');
  const verification = [];
  if (validation) {
    verification.push(`Local validation: ${validation.status}.`);
    for (const entry of validation.cases || []) {
      verification.push(`- ${entry.profile}: ${entry.status} (${entry.platform}; image ${entry.image})`);
      for (const check of entry.commands || []) {
        verification.push(`  Command: ${check.command}\n  Exit code: ${check.exitCode ?? 'unknown'}${check.timedOut ? ' (timed out)' : ''}`);
      }
      if (entry.reason) verification.push(`  Reason: ${entry.reason}`);
    }
  }
  if (result.dependency_validation) {
    const evidence = result.dependency_validation;
    verification.push(`Dependency candidate validation: ${evidence.status}.`);
    if (evidence.lockfile?.mode === 'temporary') {
      verification.push('The npm lockfile was generated only for offline validation and is not published; only the manifest is published.',
        `Validation lock SHA-256: ${evidence.lockfile.sha256}.`,
        'Validation covers this resolved graph, not every future dependency version allowed by the manifest ranges.');
    }
    for (const check of evidence.checks || []) verification.push(`- ${check.command}\n  Exit code: ${check.exit_code ?? 'unknown'}`);
    if (evidence.reason) verification.push(`Reason: ${evidence.reason}`);
  }
  if (!verification.length) verification.push('No independent validation results were recorded by this publisher.');
  verification.push('Agent-reported checks above are not independent CI evidence. Required CI and review gates still apply.');
  sections.push('## Validation', verification.join('\n'));
  const assessment = [];
  if (result.risk_level) assessment.push(`Agent-assessed risk: ${result.risk_level}.`);
  if (typeof result.breaking_api_change === 'boolean') assessment.push(
    `Agent-reported breaking API change: ${result.breaking_api_change ? 'yes' : 'no'}; not a compatibility guarantee.`);
  if (assessment.length) sections.push('## Risk and compatibility', assessment.join('\n'));
  if (notes.length) sections.push('## Publication notes', notes.join('\n'));
  const provenance = [];
  if (result.task) provenance.push(`Task: ${result.task}`);
  if (result.provider) provenance.push(`Provider: ${result.provider}`);
  if (result.model) provenance.push(`Model: ${result.model}`);
  if (env.GITHUB_REPOSITORY) provenance.push(`Repository: ${env.GITHUB_REPOSITORY}`);
  if (env.GITHUB_RUN_ID) provenance.push(`Workflow run: ${env.GITHUB_RUN_ID}; attempt: ${env.GITHUB_RUN_ATTEMPT || '1'}`);
  if (provenance.length) sections.push('## Run details', provenance.join('\n'));
  const description = sections.join('\n\n');
  markdownPublicationBody(description); // Reject oversized output before a commit or remote mutation.
  return description;
}

export function describeCommit({ result, files = result?.files_changed || [], validation } = {}) {
  const summary = result?.summary || result?.prTitle || result?.reason;
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('A commit description requires a nonempty summary.');
  const paragraphs = [conciseCommitText(summary, 350)];
  if (typeof result.details?.rationale === 'string' && result.details.rationale.trim()) {
    paragraphs.push(conciseCommitText(result.details.rationale, 200));
  }
  if (files.length) {
    const names = [...new Set(files)];
    paragraphs.push(conciseCommitText(`Files: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` (+${names.length - 3} more)` : ''}`, 180));
  }
  const checks = [];
  if (validation) checks.push(`Local validation: ${validation.status}.`);
  if (result.dependency_validation) checks.push(`Dependency validation: ${result.dependency_validation.status}.`);
  paragraphs.push(checks.join(' ') || 'Independent validation was not recorded by the publisher.');
  if (result.hold) paragraphs.push('Maintainer review is required.');
  paragraphs.push('See the PR description for full details and evidence.');
  return commitPublicationText(paragraphs.join('\n\n'));
}

export function writeChangeDescription({ resultFile, output, commitOutput, title,
  repoRoot = process.cwd(), env = process.env, execFileImpl = execFileSync } = {}) {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (result.status !== 'completed' || result.dry_run) throw new Error('Only completed live results can describe a publication.');
  if (!output || !commitOutput || typeof title !== 'string' || !title.trim()) throw new Error('Specify description, commit message and title outputs.');
  const files = execFileImpl('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  if (!files.length) throw new Error('No staged changes to describe.');
  const body = describeChange({ result, files, env });
  fs.writeFileSync(output, body, 'utf8');
  fs.writeFileSync(commitOutput, `${plainPublicationText(title)}\n\n${describeCommit({ result, files })}\n`, 'utf8');
  return { body, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const keys = { '--result': 'resultFile', '--output': 'output', '--commit-output': 'commitOutput', '--title': 'title' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = keys[process.argv[i]];
      if (!key || process.argv[i + 1] === undefined || options[key] !== undefined) throw new Error('Invalid change-description arguments.');
      options[key] = process.argv[i + 1];
    }
    writeChangeDescription(options);
  } catch (error) {
    console.error(`Change description failed: ${error.message}`);
    process.exitCode = 1;
  }
}
