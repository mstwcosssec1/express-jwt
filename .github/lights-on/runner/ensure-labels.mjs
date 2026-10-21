import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './github-io.mjs';
import { assertWriteTargetIsInstalledRepo } from './sync-upstream.mjs';

export const STANDARD_LABELS = [
  ['lights-on:ignore', 'CFD3D7', 'Opt out of Lights On review and maintenance'],
  ['lights-on:actionable', '0E8A16', 'Queue an issue for an autonomous fix attempt'],
  ['lights-on:migrate-dep', '5319E7', 'Request read-only dependency migration planning'],
  ['lights-on:hold', 'D93F0B', 'Block automatic merging until removed'],
  ['lights-on:automerge', '0E8A16', 'Opt into auto-merge when the remaining gates pass'],
  ['lights-on:re-review', '1D76DB', 'Request a fresh independent review'],
  ['lights-on:needs-human', 'B60205', 'Requires maintainer attention'],
  ['lights-on:approved-override', 'FBCA04', 'Maintainer override for protected paths or breaking changes'],
  ['lights-on:approved', '0E8A16', 'Independent review gates passed'],
  ['lights-on:changes-requested', 'E99695', 'Independent review requested changes'],
  ['lights-on:automerge-disabled-external', 'FEF2C0', 'External PR auto-merge disabled by policy'],
  ['lights-on:triaged', 'C5DEF5', 'Issue classified by Lights On'],
  ['lights-on:in-progress', 'BFDADC', 'Maintenance work in progress'],
  ['lights-on:reviewed', 'D4C5F9', 'Reviewed by Lights On'],
  ['lights-on:automation', '0052CC', 'Lights On automated maintenance'],
  ['lights-on:release', '0E8A16', 'Automated release pull request'],
  ['lights-on:agent-pr', '1D76DB', 'Pull request created by Lights On'],
  ['lights-on:pause', 'B60205', 'Pause PR review and auto-merge'],
  ['lights-on:upstream', '5319E7', 'Mirrored from the read-only upstream repository'],
  ['lights-on:dependencies', '0366D6', 'Dependency update or migration'],
  ['lights-on:security', 'B60205', 'Security vulnerability remediation'],
  ['lights-on:docs', '0075CA', 'Documentation clarification'],
  ['lights-on:needs-info', 'FBCA04', 'Awaiting reproduction details or clarification'],
  ['lights-on:wontfix-by-design', '5319E7', 'Behavior is intentional per project scope']
].map(([name, color, description]) => ({ name, color, description }));

export function ensureLabels({ repo = process.env.GITHUB_REPOSITORY,
  installedRepo = process.env.GITHUB_REPOSITORY,
  labels = STANDARD_LABELS.map((label) => label.name),
  execFileImpl = execFileSync, env = process.env } = {}) {
  const target = assertWriteTargetIsInstalledRepo(repo, installedRepo);
  const selected = [...new Set(labels)].map((name) => {
    const definition = STANDARD_LABELS.find((label) => label.name === name);
    if (!definition) throw new Error(`Unknown standard Lights On label: ${name}`);
    return definition;
  });
  for (const label of selected) {
    // --force makes setup idempotent, including when concurrent runs create the same label.
    execFileImpl('gh', ['label', 'create', label.name, '--repo', target,
      '--color', label.color, '--description', label.description, '--force'],
    { env, stdio: 'inherit' });
  }
  return selected.map((label) => label.name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const labels = ensureLabels();
    console.log(`Configured ${labels.length} Lights On labels on ${process.env.GITHUB_REPOSITORY}.`);
  } catch (err) {
    console.error(`Lights On label setup failed: ${err.message}`);
    process.exitCode = 1;
  }
}
