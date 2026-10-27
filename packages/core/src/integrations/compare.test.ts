import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../canonical.js';
import {GITHUB_API_VERSION} from '../connectors/github/index.js';
import {ConnectorError, type SafeHttp, type WireResponse} from '../connectors/wire.js';
import {compareCommits} from './compare.js';

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
