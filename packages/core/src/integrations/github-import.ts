import type {FaultlineEvidence} from '../../../contracts/src/generated.js';
import type {Change} from '../connectors/github/index.js';
import {demand} from '../errors.js';
import {normalizeEventTime} from '../imports/time.js';

export interface GitHubReleaseImport {
  kind: 'release';
  schema_version: 1;
  source_id: string;
  id: string;
  description: string;
  import_text_truncated: boolean;
  published_at: FaultlineEvidence['event_time'];
  provenance: string;
  deployment_status: 'not_proven_by_release_record';
}

/** Raw canonical release input; ordinary import review creates scoped evidence later. */
export function githubChangeImport(change: Change, sourceId: string): GitHubReleaseImport {
  // This is the exact provider resource link, not a constructed deployment URL.
  // Reject an overlong reference rather than silently changing its meaning.
  demand(typeof change.source_url === 'string' && change.source_url.length > 0 && change.source_url.length <= 1000,
    'INVALID_GITHUB_PROVENANCE', 'The reported GitHub resource reference exceeds the release import limit.');
  const occurredAt = change.kind === 'commit' ? change.committed_at : change.kind === 'release' ? change.published_at : change.merged_at;
  const timeField = change.kind === 'commit' ? 'committed_at' : change.kind === 'release' ? 'published_at' : 'merged_at';
  const fullDescription = change.kind === 'commit' ? change.message : change.kind === 'release' ? change.body : change.title + '\n' + change.body;
  const description = fullDescription.slice(0, 8000);
  return {
    kind: 'release', schema_version: 1, source_id: sourceId,
    id: `github-${change.kind}-${change.kind === 'commit' ? change.sha : change.id}`,
    description: description.trim() ? description : 'Source metadata has no descriptive text.',
    import_text_truncated: fullDescription.length > 8000,
    published_at: occurredAt === null
      ? {kind: 'unknown', raw_description: `Selected GitHub ${change.kind} metadata has no reported ${timeField} occurrence time.`}
      : {kind: 'exact', at: normalizeEventTime(occurredAt)},
    provenance: change.source_url,
    deployment_status: 'not_proven_by_release_record',
  };
}
