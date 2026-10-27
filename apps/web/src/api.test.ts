import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, casePath, request, resource } from './api';
import { commandKey, type CommandIdentity } from './command-key';

test('a business mutation binds CSRF, command identity, and reviewed revision to the actual request', async () => {
  const original = globalThis.fetch;
  let observed: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { observed = init; return Response.json({ data: { id: 'case-1', revision: 5 }, meta: { request_id: 'actual-request' } }); };
  try {
    const result = await resource<{ id: string; revision: number }>('/api/v1/workspaces/w/cases/c', { method: 'PATCH', body: { title: 'Reviewed title' }, csrf: 'session-bound-token', revision: 4, idempotencyKey: 'same-command-key' });
    const headers = observed?.headers as Record<string, string>;
    assert.equal(headers['X-CSRF-Token'], 'session-bound-token');
    assert.equal(headers['Idempotency-Key'], 'same-command-key');
    assert.equal(headers['X-Faultline-Revision'], '4');
    assert.equal(headers['If-Match'], undefined, 'Application revisions must not trigger hosting entity-tag preconditions');
    assert.equal(observed?.credentials, 'same-origin');
    assert.deepEqual(result, { id: 'case-1', revision: 5 });
  } finally { globalThis.fetch = original; }
});

test('an inaccessible workspace response never becomes a successful empty resource', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: 'NOT_FOUND', message: 'The resource is unavailable.', retryable: false, field_errors: [] }, meta: { request_id: 'tenant-denial' } }, { status: 404 });
  try { await assert.rejects(resource('/api/v1/workspaces/other/cases/private'), (error: unknown) => error instanceof ApiError && error.status === 404 && error.requestId === 'tenant-denial'); }
  finally { globalThis.fetch = original; }
});

test('a concurrent revision conflict remains an actionable failure with safe field details', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: 'STALE_INPUTS', message: 'Refresh the investigation before changing its scope.', retryable: false, field_errors: [{ field: 'revision', message: 'Current revision is newer.' }] }, meta: { request_id: 'conflict' } }, { status: 409 });
  try { await assert.rejects(request('/api/v1/workspaces/w/cases/c', { method: 'PATCH', revision: 1, csrf: 'bound-token', body: { question: 'New question' } }), (error: unknown) => error instanceof ApiError && error.code === 'STALE_INPUTS' && error.fields[0].field === 'revision'); }
  finally { globalThis.fetch = original; }
});

test('resource identity is encoded in the scoped URL instead of changing its route', () => {
  assert.equal(casePath('workspace/other', 'case?private=true'), '/api/v1/workspaces/workspace%2Fother/cases/case%3Fprivate%3Dtrue');
});

test('explicit deletion sends its reviewed token only in the exact revision-bound request header', async () => {
  const original = globalThis.fetch; let observed: RequestInit | undefined, observedPath = '';
  globalThis.fetch = async (input, init) => {observedPath = String(input); observed = init; return Response.json({data: {request_id: 'unit-receipt', status: 'pending_containment'}, meta: {request_id: 'unit-transport'}});};
  try {await resource('/api/v1/workspaces/w/cases/c', {method: 'DELETE', csrf: 'unit-csrf', revision: 7, idempotencyKey: 'unit-delete-intent', deletionReviewToken: 'unit-private-review-token'}); const headers = observed?.headers as Record<string, string>; assert.equal(headers['X-Deletion-Review-Token'], 'unit-private-review-token'); assert.equal(headers['X-Faultline-Revision'], '7'); assert.equal(headers['Idempotency-Key'], 'unit-delete-intent'); assert.equal(headers['X-CSRF-Token'], 'unit-csrf'); assert.equal(observed?.body, undefined); assert.equal(observedPath.includes('review-token'), false);} finally {globalThis.fetch = original;}
});

test('a lost connection remains unavailable instead of returning an empty result', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('connection lost'); };
  try { await assert.rejects(resource('/api/v1/workspaces'), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE' && error.status === 0); }
  finally { globalThis.fetch = original; }
});

test('a user retry after a committed response is lost keeps the actual form command identity', async () => {
  const original = globalThis.fetch;
  const command: { current: CommandIdentity } = { current: null };
  const committed = new Map<string, { id: string; name: string }>();
  const observedKeys: string[] = [];
  let loseFirstResponse = true;
  globalThis.fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>, key = headers['Idempotency-Key'];
    observedKeys.push(key);
    const body = JSON.parse(init?.body as string) as { name: string };
    if (!committed.has(key)) committed.set(key, { id: `workspace-${committed.size + 1}`, name: body.name });
    if (loseFirstResponse) { loseFirstResponse = false; throw new TypeError('Unit fixture lost the committed reply.'); }
    return Response.json({ data: committed.get(key), meta: { request_id: 'retried-command' } });
  };
  const submit = (name: string) => {
    const path = '/api/v1/workspaces', body = { name };
    return resource<{ id: string; name: string }>(path, { method: 'POST', csrf: 'unit-bound-session', body, idempotencyKey: commandKey(command, { path, method: 'POST', body }) });
  };
  try {
    await assert.rejects(submit('Checkout team'), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
    assert.equal(observedKeys.length, 1, 'a failed request must not trigger an automatic mutation retry');
    const recovered = await submit('Checkout team');
    assert.equal(recovered.id, 'workspace-1'); assert.equal(committed.size, 1); assert.equal(observedKeys[0], observedKeys[1]);
    await submit('Edited workspace name');
    assert.equal(committed.size, 2); assert.notEqual(observedKeys[1], observedKeys[2]);
    command.current = null;
    await submit('Edited workspace name');
    assert.equal(committed.size, 3); assert.notEqual(observedKeys[2], observedKeys[3]);
  } finally { globalThis.fetch = original; }
});

test('a changed reviewed revision or target creates a new command identity while object key order does not', () => {
  const command: { current: CommandIdentity } = { current: null };
  const first = commandKey(command, { path: '/cases/one', revision: 1, body: { title: 'A', question: 'B' } });
  assert.equal(commandKey(command, { body: { question: 'B', title: 'A' }, revision: 1, path: '/cases/one' }), first);
  const revised = commandKey(command, { path: '/cases/one', revision: 2, body: { title: 'A', question: 'B' } }); assert.notEqual(revised, first);
  assert.notEqual(commandKey(command, { path: '/cases/two', revision: 2, body: { title: 'A', question: 'B' } }), revised);
});
