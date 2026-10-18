import { isMaintainerAssociation, isTrustedStateAuthor } from './state-store.mjs';

export function allowAgentEvent({ eventName, event = {}, config }) {
  if (config.events?.allow_external_triggers === true) return { allowed: true, reason: 'external-triggers-enabled' };
  if (eventName === 'workflow_dispatch' || eventName === 'schedule' || !eventName) {
    return { allowed: true, reason: 'operator-or-scheduled-run' };
  }
  const item = event.pull_request || event.issue;
  if (eventName === 'issue_comment') {
    return isMaintainerAssociation(event.comment?.author_association)
      ? { allowed: true, reason: 'maintainer-comment' }
      : { allowed: false, reason: 'external-comment-requires-maintainer' };
  }
  if (isTrustedStateAuthor(item?.user, item?.author_association)) return { allowed: true, reason: 'trusted-item-author' };
  const labels = (item?.labels || []).map((label) => typeof label === 'string' ? label : label.name);
  const approved = item?.pull_request || event.pull_request
    ? labels.includes('lights-on:re-review')
    : labels.includes('lights-on:actionable') || labels.includes('lights-on:migrate-dep');
  return approved ? { allowed: true, reason: 'maintainer-label' }
    : { allowed: false, reason: 'external-item-requires-maintainer-label' };
}
