import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GITHUB_API_VERSION, GitHubChangesClient, githubNextLink, type GitHubConfig, type GitHubCaptureRequest, type Change, type CommitChange, type PullChange, type ReleaseChange} from './index.js';
import {ConnectorError, strictJson, type SafeHttp, type WireResponse} from '../wire.js';
import {hash} from '../../canonical.js';
import {compareCommits} from '../../integrations/compare.js';
import {DomainError} from '../../errors.js';
import {normalizeEvidenceRecords} from '../../imports/parser.js';
import {githubChangeImport} from '../../integrations/github-import.js';

// index
{
 // Injected unit HTTP fixtures. No credentials or live source acceptance are exercised here.
 const pinned = 'a'.repeat(40), candidate = 'b'.repeat(40), config: GitHubConfig = {owner: 'unit', repository: 'repo', repository_id: 101, token: 'unit-gh-secret', source_id: 'unit_github', workspace_id: 'unit_workspace'};
 const captureRequest: GitHubCaptureRequest = {ref: 'main', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', release_time_field: 'published_at'};
 function response(body: unknown, status = 200, headers: Record<string, string> = {}): WireResponse {return {status, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))};}
 const commit = (value = pinned) => ({sha: value, html_url: `https://github.com/unit/repo/commit/${value}`, commit: {author: {date: '2026-01-10T11:00:00Z'}, committer: {date: '2026-01-11T12:00:00Z'}, message: 'Unit change'}});
 const release = (id = 50) => ({id, html_url: `https://github.com/unit/repo/releases/tag/v${id}`, tag_name: `v${id}`, target_commitish: 'moving-main', created_at: '2025-12-20T10:00:00Z', published_at: '2026-01-15T10:00:00Z', draft: false, prerelease: false, body: 'Unit release text'});
 const pull = (title = 'Unit PR') => ({id: 80, number: 8, html_url: 'https://github.com/unit/repo/pull/8', state: 'closed', created_at: '2025-12-01T10:00:00Z', updated_at: '2026-01-20T10:00:00Z', closed_at: '2026-01-20T10:00:00Z', merged_at: '2026-01-20T10:00:00Z', merge_commit_sha: pinned, base: {sha: pinned}, head: {sha: candidate}, title, body: 'Unit change text'});
 function fake(handler?: (url: URL, count: number) => WireResponse | undefined) {
   const calls: {url: string; options?: Parameters<SafeHttp['get']>[1]}[] = []; const counts = new Map<string, number>();
   const http: SafeHttp = {get: async (url, options) => {calls.push({url, options}); const parsed = new URL(url); const count = (counts.get(parsed.pathname + parsed.search) ?? 0) + 1; counts.set(parsed.pathname + parsed.search, count); const override = handler?.(parsed, count); if (override) return override;
     if (parsed.pathname === '/repos/unit/repo') return response({id: 101, full_name: 'unit/repo', default_branch: 'main'});
     if (parsed.pathname === '/repos/unit/repo/commits/main') return response({sha: pinned});
     if (parsed.pathname.endsWith('/commits')) return response([commit()], 200, {'X-GitHub-Request-Id': 'unit_commit', ETag: 'unit-etag'});
     if (parsed.pathname.endsWith('/releases')) return response([release()]); if (parsed.pathname.endsWith('/pulls')) return response([pull()]);
     throw new Error('Unexpected unit fixture route');
   }}; return {http, calls};
 }
 const isCode = (code: string) => (error: unknown) => error instanceof ConnectorError && error.code === code;
 
 test('wire capture pins the ref once, reads real versioned endpoints and preserves distinct times without deployment claims', async () => {
   const fixture = fake(); const result = await new GitHubChangesClient(fixture.http, config).capture(captureRequest);
   assert.equal(result.state, 'complete'); assert.equal(result.resolved_sha, pinned); assert.equal(result.commits.records[0]!.author_at, '2026-01-10T11:00:00.000Z'); assert.equal(result.commits.records[0]!.committed_at, '2026-01-11T12:00:00.000Z');
   assert.equal(result.releases.records[0]!.created_at, '2025-12-20T10:00:00.000Z'); assert.equal(result.releases.records[0]!.published_at, '2026-01-15T10:00:00.000Z'); assert.equal(result.releases.records[0]!.deployment_at, null); assert.equal(result.deployment_evidence, 'not_established');
   assert.equal(fixture.calls.filter(call => call.url.endsWith('/commits/main')).length, 1); const history = fixture.calls.find(call => new URL(call.url).pathname.endsWith('/commits'))!; assert.equal(new URL(history.url).searchParams.get('sha'), pinned);
   assert.ok(fixture.calls.every(call => call.options?.headers?.['X-GitHub-Api-Version'] === GITHUB_API_VERSION && !call.url.includes(config.token))); assert.equal(result.pages[0]!.request_id, 'unit_commit'); assert.equal(result.pages[0]!.etag, 'unit-etag');
 });
 
 test('local release-time selection never substitutes publication, creation or a moving tag for deployment', async () => {
   const result = await new GitHubChangesClient(fake().http, config).capture({...captureRequest, release_time_field: 'created_at'}); assert.equal(result.releases.records.length, 0); assert.equal(result.releases.state, 'complete'); assert.equal(result.deployment_evidence, 'not_established');
 });
 
 test('valid Link paging retains the immutable SHA and labels a page cap as partial', async () => {
   const fixture = fake(url => {if (url.pathname.endsWith('/commits')) {const next = new URL(url); next.searchParams.set('page', '2'); return response([commit()], 200, {Link: `<${next.href}>; rel="next"`});} return undefined;});
   const result = await new GitHubChangesClient(fixture.http, config).capture({...captureRequest, max_pages: 1}); assert.equal(result.state, 'partial'); assert.equal(result.commits.state, 'partial'); assert.equal(result.commits.reason_code, 'GITHUB_PAGE_CAP');
   assert.equal(fixture.calls.filter(call => new URL(call.url).searchParams.has('page')).length, 0);
 });
 
 test('cross-origin, cross-repository, changed SHA and malformed Link headers fail before token forwarding', async () => {
   const endpoint = new URL(`https://api.github.com/repos/unit/repo/commits?sha=${pinned}&since=2026-01-01T00%3A00%3A00.000Z&until=2026-02-01T00%3A00%3A00.000Z&per_page=100`);
   const safe = new URL(endpoint); safe.searchParams.set('page', '2'); assert.equal(githubNextLink(`<${safe.href}>; rel="next"`, endpoint), safe.href);
   const changedSha = new URL(safe); changedSha.searchParams.set('sha', candidate);
   for (const link of ['<https://evil.example.com/page>; rel="next"', `<${safe.href.replace('/unit/repo/', '/unit/private/')}>; rel="next"`, `<${changedSha.href}>; rel="next"`, 'not-a-link', `<${safe.href}>; rel=next`]) assert.throws(() => githubNextLink(link, endpoint));
   const fixture = fake(url => url.pathname.endsWith('/commits') ? response([commit()], 200, {link: '<https://evil.example.com/private>; rel="next"'}) : undefined);
   await assert.rejects(new GitHubChangesClient(fixture.http, config).capture(captureRequest), isCode('UNAPPROVED_ORIGIN')); assert.ok(fixture.calls.every(call => new URL(call.url).origin === 'https://api.github.com'));
 });
 
 test('repeated next links or repeated page bodies cannot imply complete history', async () => {
   const fixture = fake(url => {if (url.pathname.endsWith('/commits')) {const next = new URL(url); next.searchParams.set('page', '2'); return response([commit()], 200, {Link: `<${next.href}>; rel="next"`});} return undefined;});
   await assert.rejects(new GitHubChangesClient(fixture.http, config).capture(captureRequest), isCode('GITHUB_PAGINATION_LOOP'));
 });
 
 test('canonical repository identity controls renamed metadata and rejects a different repository', async () => {
   const wrong = fake(url => url.pathname === '/repos/unit/repo' ? response({id: 999, full_name: 'unit/repo', default_branch: 'main'}) : undefined); await assert.rejects(new GitHubChangesClient(wrong.http, config).capture(captureRequest), isCode('GITHUB_REPOSITORY_MISMATCH'));
   const renamed = fake(url => {if (url.pathname === '/repos/unit/repo') return response({id: 101, full_name: 'renamed/newrepo', default_branch: 'main'}); if (url.pathname === '/repos/renamed/newrepo/commits/main') return response({sha: pinned}); if (url.pathname.startsWith('/repos/renamed/newrepo/')) return response([]); return undefined;});
   const result = await new GitHubChangesClient(renamed.http, config).capture(captureRequest); assert.equal(result.repository_id, 101); assert.equal(result.repository_full_name, 'renamed/newrepo'); assert.equal(result.state, 'complete');
 });
 
 test('valid empty history is complete while unavailable PR permission remains unavailable', async () => {
   const empty = fake(url => /\/(commits|releases|pulls)$/.test(url.pathname) ? response([]) : undefined); const result = await new GitHubChangesClient(empty.http, config).capture(captureRequest); assert.equal(result.state, 'complete'); assert.equal(result.commits.records.length, 0);
   const denied = fake(url => url.pathname.endsWith('/pulls') ? response({message: 'Resource not accessible by personal access token'}, 403) : undefined); const partial = await new GitHubChangesClient(denied.http, config).capture(captureRequest); assert.equal(partial.state, 'partial'); assert.equal(partial.pull_requests.state, 'unavailable'); assert.equal(partial.pull_requests.reason_code, 'PROVIDER_UNAUTHORIZED'); assert.equal(partial.commits.state, 'complete');
 });
 
 test('expired credentials, not-modified without an object, and transient upstream errors remain typed failures', async () => {
   for (const [status, code] of [[401, 'PROVIDER_UNAUTHORIZED'], [304, 'PROVIDER_CACHE_MISS'], [502, 'PROVIDER_UNAVAILABLE']] as const) {const fixture = fake(() => response({message: 'untrusted provider error with possible secrets'}, status)); await assert.rejects(new GitHubChangesClient(fixture.http, config).capture(captureRequest), isCode(code));}
   const probe = await new GitHubChangesClient(fake(() => response({}, 401)).http, config).probe(); assert.equal(probe.status, 'unauthorized');
 });
 
 test('primary and secondary rate limits defer through a typed retry time rather than treating reads as empty', async () => {
   for (const fixture of [fake(() => response({}, 403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120)})), fake(() => response({message: 'You have exceeded a secondary rate limit.'}, 403)), fake(() => response({}, 429, {'retry-after': '120'}))]) {
     await assert.rejects(new GitHubChangesClient(fixture.http, config).capture(captureRequest), (error: unknown) => error instanceof ConnectorError && error.code === 'PROVIDER_RATE_LIMITED' && !!error.details.retry_at && Date.parse(error.details.retry_at) >= Date.now() + 59_000);
   }
 });
 
 test('changed PR boundary pages are reread and explicitly labelled changed', async () => {
   const fixture = fake((url, count) => url.pathname.endsWith('/pulls') ? response([pull(count === 1 ? 'First revision' : 'Edited while scanning')]) : undefined); const result = await new GitHubChangesClient(fixture.http, config).capture(captureRequest);
   assert.equal(result.state, 'changed'); assert.equal(result.pull_requests.state, 'changed'); assert.equal(result.pull_requests.reason_code, 'GITHUB_RESOURCE_CHANGED'); assert.ok(result.pages.some(page => page.boundary_recheck));
 });
 
 test('duplicate keys and unsafe numeric identities cannot alter wire verification truth', () => {
   assert.throws(() => strictJson(Buffer.from('{"sha":"a","sha":"b"}')), isCode('DUPLICATE_PROVIDER_KEY'));
   assert.throws(() => strictJson(Buffer.from('{"id":9007199254740993}')), isCode('UNSAFE_PROVIDER_NUMBER'));
   assert.throws(() => strictJson(Buffer.from('{"__proto__":{}}')), isCode('UNSAFE_PROVIDER_KEY'));
 });
 
 test('revocation checked before final publication prevents returning a successful capture', async () => {
   let checks = 0; await assert.rejects(new GitHubChangesClient(fake().http, config).capture(captureRequest, {assertActive: async () => {if (++checks === 13) throw new ConnectorError('CAPTURE_REVOKED', 'Unit permission changed.');}}), isCode('CAPTURE_REVOKED')); assert.equal(checks, 13);
 });
 
 test('private page checkpoints preserve prior captured pages when a later resource is inaccessible', async () => {
   const checkpointHashes: string[] = []; const fixture = fake(url => url.pathname.endsWith('/releases') ? response({}, 404) : undefined);
   await assert.rejects(new GitHubChangesClient(fixture.http, config).capture(captureRequest, {onPage: async page => {checkpointHashes.push(page.body_hash);}}), isCode('PROVIDER_NOT_FOUND')); assert.equal(checkpointHashes.length, 1); assert.match(checkpointHashes[0]!, /^[a-f0-9]{64}$/);
 });
}

// compare
{
 // Finite injected wire fixtures only; these are not live GitHub or deployment evidence.
 const base = 'a'.repeat(40), head = 'd'.repeat(40), merge = '9'.repeat(40);
 const first = 'b'.repeat(40), second = 'c'.repeat(40);
 const scope = {owner: 'compare_fixture', repo: 'selected_repo', token: 'fixture-only-token', base_sha: base, head_sha: head};
 const endpoint = `https://api.github.com/repos/${scope.owner}/${scope.repo}/compare/${base}...${head}?per_page=100`;
 function response(value: unknown, link?: string): WireResponse {
   return {status: 200, headers: link ? {Link: link} : {}, body: Buffer.from(JSON.stringify(value))};
 }
 function page(commits: string[], total = 3, overrides: Record<string, unknown> = {}) {
   return {base_commit: {sha: base}, merge_base_commit: {sha: merge}, status: 'ahead', total_commits: total, commits: commits.map(sha => ({sha})), ...overrides};
 }
 function next(number: number) {return `<${endpoint}&page=${number}>; rel="next"`;}
 function fixture(read: (url: URL, index: number) => WireResponse) {
   const calls: {url: string; options?: Parameters<SafeHttp['get']>[1]}[] = [];
   const http: SafeHttp = {get: async (url, options) => {calls.push({url, options}); return read(new URL(url), calls.length);}};
   return {http, calls};
 }
 const isCode = (code: string) => (error: unknown) => error instanceof ConnectorError && error.code === code;
 
 test('immutable base/head comparison exhausts two finite pages with exact commit and checkpoint bindings', async () => {
   const values = [page([first, second]), page([head])];
   const wire = fixture((url, index) => {
     assert.equal(url.pathname, `/repos/${scope.owner}/${scope.repo}/compare/${base}...${head}`);
     assert.equal(url.searchParams.get('per_page'), '100');
     assert.equal(url.searchParams.get('page'), index === 1 ? null : '2');
     return response(values[index - 1], index === 1 ? next(2) : undefined);
   });
   const checkpoints: {bytes: Buffer; metadata: unknown}[] = [];
   const result = await compareCommits(wire.http, scope, {onPage: async (bytes, metadata) => {checkpoints.push({bytes: Buffer.from(bytes), metadata});}});
   assert.deepEqual({base_sha: result.base_sha, head_sha: result.head_sha, status: result.status, total_commits: result.total_commits, received_commits: result.received_commits, commit_shas: result.commit_shas, pages: result.pages, state: result.state},
     {base_sha: base, head_sha: head, status: 'ahead', total_commits: 3, received_commits: 3, commit_shas: [first, second, head], pages: 2, state: 'complete'});
   assert.equal(wire.calls.length, 2);
   for (const call of wire.calls) {
     assert.equal(new URL(call.url).origin, 'https://api.github.com');
     assert.equal(call.url.includes(scope.token), false);
     assert.deepEqual(call.options?.allowedOrigins, ['https://api.github.com']);
     assert.equal(call.options?.maxBytes, 1_048_576);
     assert.equal(call.options?.headers?.Authorization, `Bearer ${scope.token}`);
     assert.equal(call.options?.headers?.Accept, 'application/vnd.github+json');
     assert.equal(call.options?.headers?.['X-GitHub-Api-Version'], GITHUB_API_VERSION);
   }
   assert.equal(checkpoints.length, 2);
   checkpoints.forEach((checkpoint, index) => {
     assert.deepEqual(JSON.parse(checkpoint.bytes.toString('utf8')), values[index]);
     assert.deepEqual(checkpoint.metadata, {page: index + 1, body_hash: hash(values[index]), base_sha: base, head_sha: head, total_commits: 3});
   });
   assert.ok(result.limitations.some(value => value.includes('does not establish deployment or aggregate causal effect')));
 });
 
 test('wrong base commit is rejected before comparison checkpoint publication', async () => {
   const wire = fixture(() => response(page([first], 1, {base_commit: {sha: head}})));
   let checkpoints = 0;
   await assert.rejects(compareCommits(wire.http, scope, {onPage: async () => {checkpoints++;}}), isCode('INVALID_GITHUB_COMPARISON'));
   assert.equal(wire.calls.length, 1); assert.equal(checkpoints, 0);
 });
 
 test('total, merge base, or comparison status changing on another page cannot become a complete comparison', async () => {
   for (const changed of [{total_commits: 4}, {merge_base_commit: {sha: '8'.repeat(40)}}, {status: 'diverged'}]) {
     const wire = fixture((_url, index) => index === 1 ? response(page([first, second]), next(2)) : response(page([head], 3, changed)));
     let checkpoints = 0;
     await assert.rejects(compareCommits(wire.http, scope, {onPage: async () => {checkpoints++;}}), isCode('GITHUB_COMPARISON_CHANGED'));
     assert.equal(wire.calls.length, 2); assert.equal(checkpoints, 1);
   }
 });
 
 test('next links cannot forward credentials to another origin, repository, head, or query binding', async () => {
   const valid = `${endpoint}&page=2`;
   const rejected = [
     ['https://other.example.com/compare?page=2', 'UNAPPROVED_ORIGIN'],
     [valid.replace('/selected_repo/', '/another_repo/'), 'UNSAFE_GITHUB_PAGINATION'],
     [valid.replace(`...${head}`, `...${first}`), 'UNSAFE_GITHUB_PAGINATION'],
     [valid.replace('per_page=100', 'per_page=1'), 'UNSAFE_GITHUB_PAGINATION'],
   ] as const;
   for (const [url, code] of rejected) {
     const wire = fixture(() => response(page([first, second]), `<${url}>; rel="next"`));
     await assert.rejects(compareCommits(wire.http, scope), isCode(code));
     assert.equal(wire.calls.length, 1);
     assert.equal(wire.calls[0]!.url, endpoint);
   }
 });
 
 test('inconsistent commit totals and finite page exhaustion stay partial; independently known empty is complete', async () => {
   for (const [commits, total] of [[[first], 2], [[first, second], 1]] as const) {
     const result = await compareCommits(fixture(() => response(page([...commits], total))).http, scope);
     assert.equal(result.state, 'partial'); assert.equal(result.received_commits, commits.length); assert.equal(result.total_commits, total);
   }
   const bounded = fixture((_url, index) => response(page([index.toString(16).padStart(40, '0')], 51), next(index + 1)));
   const partial = await compareCommits(bounded.http, scope);
   assert.equal(partial.state, 'partial'); assert.equal(partial.pages, 50); assert.equal(partial.received_commits, 50); assert.equal(partial.total_commits, 51);
   assert.equal(bounded.calls.length, 50); assert.equal(bounded.calls.some(call => new URL(call.url).searchParams.get('page') === '51'), false);
   const empty = await compareCommits(fixture(() => response(page([], 0, {status: 'identical'}))).http, {...scope, head_sha: base});
   assert.equal(empty.state, 'complete'); assert.equal(empty.received_commits, 0); assert.equal(empty.total_commits, 0);
 });
 
 test('repeated page bodies and duplicate commit identities are errors rather than count-based completion', async () => {
   const repeated = fixture(() => response(page([first]), next(2)));
   await assert.rejects(compareCommits(repeated.http, scope), isCode('GITHUB_PAGINATION_LOOP'));
   assert.equal(repeated.calls.length, 2);
   const duplicate = fixture(() => response(page([first, first], 2)));
   await assert.rejects(compareCommits(duplicate.http, scope), isCode('INVALID_GITHUB_COMPARISON'));
 });
}

// github import
{
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
}
