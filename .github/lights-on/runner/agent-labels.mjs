import { execFileSync } from './github-io.mjs';
import { assertWriteTargetIsInstalledRepo } from './sync-upstream.mjs';
import { ensureLabels, STANDARD_LABELS } from './ensure-labels.mjs';
import { sanitizeAgentLabelChanges } from './state-store.mjs';
import { reportWorkflowEvent } from './workflow-report.mjs';

export function prepareAgentLabelChanges({
  repo = process.env.GITHUB_REPOSITORY, installedRepo = process.env.GITHUB_REPOSITORY,
  labelsToAdd = [], labelsToRemove = [], readOnly = false,
  execFileImpl = execFileSync, env = process.env
} = {}) {
  const target = assertWriteTargetIsInstalledRepo(repo, installedRepo);
  const safe = sanitizeAgentLabelChanges(labelsToAdd, labelsToRemove, { readOnly });
  if (!safe.labelsToAdd.length && !safe.labelsToRemove.length) return safe;
  const pages = JSON.parse(execFileImpl('gh', ['api', '--paginate', '--slurp',
    `repos/${target}/labels?per_page=100`], { env, encoding: 'utf8' }));
  if (!Array.isArray(pages) || !pages.length || !pages.every((page) => Array.isArray(page) &&
      page.every((label) => typeof label?.name === 'string' && label.name.trim()))) {
    throw new Error('Invalid repository label inventory; refusing label changes.');
  }
  const existing = new Map(pages.flat().map((label) => [label.name.toLowerCase(), label.name]));
  const standard = new Map(STANDARD_LABELS.map((label) => [label.name.toLowerCase(), label.name]));
  const missingStandard = [...new Set(safe.labelsToAdd.map((name) => name.toLowerCase()))]
    .filter((name) => !existing.has(name) && standard.has(name)).map((name) => standard.get(name));
  if (missingStandard.length) {
    ensureLabels({ repo: target, installedRepo, labels: missingStandard, execFileImpl, env });
    for (const name of missingStandard) existing.set(name.toLowerCase(), name);
  }
  const resolve = (labels, operation) => [...new Set(labels.map((name) => name.toLowerCase()))].flatMap((name) => {
    if (existing.has(name)) return [existing.get(name)];
    reportWorkflowEvent({
      level: operation === 'add' ? 'warning' : 'notice', title: 'Agent label skipped',
      message: `Cannot ${operation} undefined repository label "${name}". ${operation === 'add'
        ? 'Custom labels are not created automatically; the response can still be published.'
        : 'Nothing needs to be removed.'}`
    }, { env });
    return [];
  });
  return { labelsToAdd: resolve(safe.labelsToAdd, 'add'), labelsToRemove: resolve(safe.labelsToRemove, 'remove') };
}
