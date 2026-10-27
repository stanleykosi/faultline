import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GITHUB_API_VERSION, GitHubChangesClient, githubNextLink, type GitHubConfig, type GitHubCaptureRequest} from './index.js';
import {ConnectorError, strictJson, type SafeHttp, type WireResponse} from '../wire.js';

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
