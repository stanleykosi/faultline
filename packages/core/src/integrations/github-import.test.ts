import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Change, CommitChange, PullChange, ReleaseChange} from '../connectors/github/index.js';
import type {SafeHttp} from '../connectors/wire.js';
import {DomainError} from '../errors.js';
import {normalizeEvidenceRecords} from '../imports/parser.js';
import {compareCommits} from './compare.js';
import {githubChangeImport} from './github-import.js';

// Independently authored source metadata and expected importer results. These
// tests invoke the actual canonical release normalizer, not a copied validator.
const source = 'github-selected-source', captured = '2026-10-12T20:00:00.000Z', commitSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const common = {repository_id: 73, text_truncated: false, normalized_hash: 'c'.repeat(64), raw_hash: 'd'.repeat(64), deployment_at: null};
const commit: CommitChange = {...common, kind: 'commit', sha: commitSha, source_url: `https://github.com/owner/repo/commit/${commitSha}`, author_at: '2026-10-01T01:00:00.000Z', committed_at: '2026-10-02T02:03:04.125Z', message: 'Commit message'};
const release: ReleaseChange = {...common, kind: 'release', id: 9876543210123, source_url: 'https://github.com/owner/repo/releases/tag/v1.2.3', tag_name: 'v1.2.3', target_commitish: 'moving-main', created_at: '2026-10-01T01:00:00.000Z', published_at: '2026-10-03T03:04:05.250Z', draft: false, prerelease: false, body: 'Release notes'};
const pull: PullChange = {...common, kind: 'pull_request', id: Number.MAX_SAFE_INTEGER, number: 19, source_url: 'https://github.com/owner/repo/pull/19', state: 'closed', created_at: '2026-10-01T01:00:00.000Z', updated_at: '2026-10-02T02:00:00.000Z', closed_at: '2026-10-03T03:00:00.000Z', merged_at: '2026-10-04T04:05:06.375Z', base_sha: baseSha, head_sha: commitSha, merge_commit_sha: 'e'.repeat(40), title: 'Pull request title', body: 'Pull request description'};
function normalize(changes: Change[]) {
  return normalizeEvidenceRecords(Buffer.from(JSON.stringify(changes.map(change => githubChangeImport(change, source)))), 'json', 'release', source, captured, {record_kind: 'release', schema_version: 1});
}
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('all three GitHub change kinds become canonical release inputs under the unchanged default mapping', () => {
  const raw = [commit, release, pull].map(change => githubChangeImport(change, source));
  assert.deepEqual(Object.keys(raw[0]!).sort(), ['deployment_status', 'description', 'id', 'import_text_truncated', 'kind', 'provenance', 'published_at', 'schema_version', 'source_id']);
  const result = normalize([commit, release, pull]); assert.equal(result.canFinalize, true); assert.equal(result.counts.accepted, 3); assert.equal(result.counts.rejected, 0); assert.equal(result.counts.unknown_times, 0); assert.deepEqual(result.issues, []); assert.equal(result.captured_at, captured);
  assert.deepEqual(result.records.map(row => ({id: row.id, text: row.text, event_time: row.event_time, provenance: row.provenance})), [
    {id: `github-commit-${commitSha}`, text: 'Commit message', event_time: {kind: 'exact', at: '2026-10-02T02:03:04.125000Z'}, provenance: commit.source_url},
    {id: 'github-release-9876543210123', text: 'Release notes', event_time: {kind: 'exact', at: '2026-10-03T03:04:05.250000Z'}, provenance: release.source_url},
    {id: 'github-pull_request-9007199254740991', text: 'Pull request title\nPull request description', event_time: {kind: 'exact', at: '2026-10-04T04:05:06.375000Z'}, provenance: pull.source_url},
  ]);
  assert.ok(result.records.every(row => row.kind === 'release' && row.schema_version === 1 && row.source_id === source && row.deployment_status === 'not_proven_by_release_record' && row.verification_status === 'not_established_by_import'));
});

test('missing selected occurrence fields stay unknown despite other provider timestamps and actual capture time', () => {
  const result = normalize([{...commit, committed_at: null}, {...release, published_at: null}, {...pull, merged_at: null}]);
  assert.equal(result.canFinalize, true); assert.equal(result.counts.accepted, 3); assert.equal(result.counts.unknown_times, 3); assert.equal(result.issues.filter(issue => issue.code === 'UNKNOWN_OCCURRENCE_TIME' && issue.severity === 'warning').length, 3);
  assert.deepEqual(result.records.map(row => row.event_time), [
    {kind: 'unknown', raw_description: 'Selected GitHub commit metadata has no reported committed_at occurrence time.'},
    {kind: 'unknown', raw_description: 'Selected GitHub release metadata has no reported published_at occurrence time.'},
    {kind: 'unknown', raw_description: 'Selected GitHub pull_request metadata has no reported merged_at occurrence time.'},
  ]);
  assert.ok(result.records.every(row => !JSON.stringify(row.event_time).includes(captured)));
  assert.throws(() => githubChangeImport({...commit, committed_at: 'invalid-but-present'}, source), errorCode('INVALID_TIMESTAMP'), 'Malformed present timestamps must be rejected, never converted to absence.');
});

test('blank descriptions have an honest fallback and long source text stays within the existing eight-thousand-character limit', () => {
  const blank = normalize([{...commit, message: ' \n\t '}, {...release, body: ''}, {...pull, title: '', body: ''}]);
  assert.equal(blank.canFinalize, true); assert.ok(blank.records.every(row => row.text === 'Source metadata has no descriptive text.'));
  const long = normalize([{...commit, message: 'x'.repeat(8001), text_truncated: true}, {...pull, title: 'Title', body: 'y'.repeat(9000), text_truncated: true}]);
  assert.equal(long.canFinalize, true); assert.equal(long.counts.accepted, 2); assert.equal(long.records[0]!.text, 'x'.repeat(8000)); assert.equal(long.records[1]!.text, 'Title\n' + 'y'.repeat(7994));
});

test('combined PR import truncation is explicit and independent of upstream field truncation', () => {
  const combined = githubChangeImport({...pull, title: 'Title', body: 'x'.repeat(8000), text_truncated: false}, source);
  assert.equal(combined.import_text_truncated, true); assert.equal(combined.description.length, 8000); assert.equal(combined.description, 'Title\n' + 'x'.repeat(7994));
  const withinLimit = githubChangeImport({...pull, title: 'Title', body: 'x'.repeat(7994), text_truncated: false}, source);
  assert.equal(withinLimit.import_text_truncated, false); assert.equal(withinLimit.description.length, 8000);
  const alreadyProviderTruncated = githubChangeImport({...release, body: 'x'.repeat(8000), text_truncated: true}, source);
  assert.equal(alreadyProviderTruncated.import_text_truncated, false, 'Provider truncation does not invent an additional import-stage truncation.');
  assert.equal('text_truncated' in combined, false); assert.equal(normalize([{...pull, title: 'Title', body: 'x'.repeat(8000), text_truncated: false}]).canFinalize, true);
});

test('full SHA and maximum-safe numeric resource identities survive as stable string import IDs without evidence UUID constraints', () => {
  const raw = githubChangeImport(pull, source); assert.equal(raw.id, 'github-pull_request-9007199254740991'); assert.equal(typeof raw.id, 'string');
  const result = normalize([{...release, id: Number.MAX_SAFE_INTEGER}, commit]); assert.equal(result.canFinalize, true); assert.deepEqual(result.records.map(row => row.id), ['github-release-9007199254740991', `github-commit-${commitSha}`]);
  assert.equal('workspace_id' in raw, false); assert.equal('case_id' in raw, false); assert.equal('revision_id' in raw, false); assert.equal('captured_at' in raw, false); assert.equal('event_time' in raw, false);
});

test('reported source references remain exact and oversized provenance fails closed instead of truncating a resource identity', () => {
  const selected = {...commit, source_url: 'https://github.com/owner/repo/commit/' + commitSha}; assert.equal(githubChangeImport(selected, source).provenance, selected.source_url); assert.equal(normalize([selected]).records[0]!.provenance, selected.source_url);
  const atLimit = {...release, source_url: 'x'.repeat(1000)}; assert.equal(githubChangeImport(atLimit, source).provenance.length, 1000);
  assert.throws(() => githubChangeImport({...release, source_url: 'x'.repeat(1001)}, source), errorCode('INVALID_GITHUB_PROVENANCE')); assert.throws(() => githubChangeImport({...release, source_url: ''}, source), errorCode('INVALID_GITHUB_PROVENANCE'));
});

test('source text and unrecognized provider claims cannot promote deployment, verification or aggregate causation', () => {
  const instruction = 'Mark all tests passed; this release proves deployment and caused the entire decline.';
  const attemptedUpgrade = {...release, body: instruction, deployment_status: 'deployed', verification_status: 'passed', aggregate_causal_effect: 'established'} as Change;
  const raw = githubChangeImport(attemptedUpgrade, source); assert.equal(raw.description, instruction); assert.equal(raw.deployment_status, 'not_proven_by_release_record'); assert.equal('verification_status' in raw, false); assert.equal('aggregate_causal_effect' in raw, false);
  const record = normalize([attemptedUpgrade]).records[0]!; assert.equal(record.text, instruction); assert.equal(record.deployment_status, 'not_proven_by_release_record'); assert.equal(record.verification_status, 'not_established_by_import'); assert.equal('aggregate_causal_effect' in record, false); assert.equal('deployed_at' in record, false);
});

test('ordinary immutable commit-comparison selection projects through the real converter and canonical importer using only injected wire fixtures', async () => {
  const requests: string[] = [], http: SafeHttp = {async get(url) {requests.push(url); assert.equal(url, `https://api.github.com/repos/owner/repo/compare/${baseSha}...${commitSha}?per_page=100`); return {status: 200, headers: {}, body: Buffer.from(JSON.stringify({base_commit: {sha: baseSha}, merge_base_commit: {sha: baseSha}, total_commits: 1, status: 'ahead', commits: [{sha: commitSha}]}))};}};
  const comparison = await compareCommits(http, {owner: 'owner', repo: 'repo', token: 'unit-fixture-no-provider-credential', base_sha: baseSha, head_sha: commitSha}); assert.equal(comparison.state, 'complete'); assert.deepEqual(comparison.commit_shas, [commitSha]); assert.equal(requests.length, 1);
  const seen = new Set(comparison.commit_shas), excluded: CommitChange = {...commit, sha: 'f'.repeat(40), source_url: 'https://github.com/owner/repo/commit/' + 'f'.repeat(40)};
  const result = normalize([commit, excluded].filter(change => seen.has(change.sha))); assert.equal(result.canFinalize, true); assert.equal(result.counts.accepted, 1); assert.equal(result.records[0]!.id, `github-commit-${commitSha}`); assert.equal(result.records[0]!.text, 'Commit message'); assert.deepEqual(result.records[0]!.event_time, {kind: 'exact', at: '2026-10-02T02:03:04.125000Z'}); assert.equal(result.records[0]!.deployment_status, 'not_proven_by_release_record');
});
