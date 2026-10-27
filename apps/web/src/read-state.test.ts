import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {ApiError} from './api';
import {boundedResource, readAccount, readAccountAfterAuthentication} from './read-state';
import {readRecords, type RecordRead} from './features/data/read-records';

const session = {user: {id: 'unit-user', name: 'Unit account', email: 'unit@example.invalid'}, csrf_token: 'unit-session-token'};
const workspaces = [{id: 'unit-workspace', name: 'Unit workspace', created_at: '2026-10-11T00:00:00Z', role: 'viewer', revision: 1}];
const investigation = {id: 'unit-case', workspace_id: 'unit-workspace', title: 'Unit question', question: 'What changed?', revision: 2};
const envelope = (value: unknown) => Response.json({data: value, meta: {request_id: 'unit-only'}});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(accept => {resolve = accept;}); return {promise, resolve};}

test('account reads start together and cannot publish roles before a valid session', async () => {
  const original = globalThis.fetch, pendingSession = deferred<Response>(), paths: string[] = [];
  globalThis.fetch = async (input, init) => {paths.push(String(input)); assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'same-origin'); return String(input).endsWith('/session') ? pendingSession.promise : envelope(workspaces);};
  try {
    let published = false;
    const account = readAccount(new AbortController().signal).then(value => {published = true; return value;});
    assert.deepEqual(paths, ['/api/v1/session', '/api/v1/workspaces']);
    await setImmediate(); assert.equal(published, false);
    pendingSession.resolve(envelope(session)); assert.deepEqual(await account, {session, workspaces});
  } finally {globalThis.fetch = original;}
});

test('a denied session rejects a simultaneous successful owner workspace response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => String(input).endsWith('/session') ? Response.json({error: {code: 'UNAUTHENTICATED', message: 'Sign in again.'}}, {status: 401}) : envelope([{...workspaces[0], role: 'owner'}]);
  try {await assert.rejects(readAccount(new AbortController().signal), (cause: unknown) => cause instanceof ApiError && cause.status === 401);}
  finally {globalThis.fetch = original;}
});

test('malformed workspace roles remain unavailable even after successful authentication', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => envelope(String(input).endsWith('/session') ? session : [{...workspaces[0], role: 'administrator'}]);
  try {await assert.rejects(readAccount(new AbortController().signal), /permitted workspace list was unavailable/);}
  finally {globalThis.fetch = original;}
});

test('an account read cancelled during switching cannot return old roles even when transport ignores cancellation', async () => {
  const original = globalThis.fetch, response = deferred<Response>(), controller = new AbortController();
  globalThis.fetch = async input => String(input).endsWith('/session') ? response.promise : envelope(workspaces);
  try {
    const account = readAccount(controller.signal), rejected = assert.rejects(account, (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
    controller.abort(); response.resolve(envelope(session)); await rejected;
  } finally {globalThis.fetch = original;}
});

test('the case is published while ancillary metadata is delayed, and a denied list stays unavailable', async () => {
  const original = globalThis.fetch, snapshots = deferred<Response>(), metrics = deferred<Response>(), states: {kind: string; state: RecordRead<unknown>}[] = [];
  globalThis.fetch = async input => String(input).endsWith('/snapshots') ? snapshots.promise : String(input).endsWith('/metrics') ? metrics.promise : envelope(investigation);
  const listeners = {investigation: (state: RecordRead<unknown>) => states.push({kind: 'case', state}), snapshots: (state: RecordRead<unknown>) => states.push({kind: 'snapshots', state}), metrics: (state: RecordRead<unknown>) => states.push({kind: 'metrics', state})};
  try {
    const read = readRecords('/api/v1/workspaces/unit-workspace/cases/unit-case', new AbortController().signal, listeners);
    await setImmediate(); assert.deepEqual(states.map(item => item.kind), ['case']); assert.equal(states[0].state.status, 'ready');
    snapshots.resolve(Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Snapshot records unavailable.'}}, {status: 503})); metrics.resolve(envelope([])); await read;
    assert.equal(states.find(item => item.kind === 'snapshots')?.state.status, 'unavailable');
    const metricState = states.find(item => item.kind === 'metrics')?.state; assert.equal(metricState?.status, 'ready'); if (metricState?.status === 'ready') assert.deepEqual(metricState.value, []);
  } finally {globalThis.fetch = original;}
});

test('late responses from a cancelled case refresh cannot publish stale metadata', async () => {
  const original = globalThis.fetch, response = deferred<Response>(), controller = new AbortController(), published: unknown[] = [];
  globalThis.fetch = async () => response.promise;
  try {
    const read = readRecords('/api/v1/workspaces/unit-workspace/cases/unit-case', controller.signal, {investigation: value => published.push(value), snapshots: value => published.push(value), metrics: value => published.push(value)});
    controller.abort(); response.resolve(envelope(investigation)); await read; assert.deepEqual(published, []);
  } finally {globalThis.fetch = original;}
});

test('a stalled read has a bounded unavailable outcome and aborts its transport without retrying', async () => {
  const original = globalThis.fetch, response = deferred<Response>(); let transport: AbortSignal | undefined, calls = 0;
  globalThis.fetch = async (_input, init) => {calls++; transport = init?.signal as AbortSignal; return response.promise;};
  try {
    await assert.rejects(boundedResource('/api/v1/workspaces/unit-workspace/cases/unit-case', undefined, 20), (cause: unknown) => cause instanceof ApiError && cause.status === 0 && cause.code === 'READ_TIMEOUT');
    assert.equal(transport?.aborted, true); assert.equal(calls, 1); response.resolve(envelope(investigation));
  } finally {globalThis.fetch = original;}
});

const transientFailures = ['NETWORK_UNAVAILABLE', 'READ_TIMEOUT', 502, 503, 504] as const;

test('post-authentication recovery retries each transient read failure once and publishes one coherent account', async t => {
  for (const failure of transientFailures) await t.test(String(failure), async context => {
    const original = globalThis.fetch, stalled = deferred<Response>(), calls: {path: string; method: string | undefined}[] = [];
    let sessionReads = 0, workspaceReads = 0, retries = 0;
    if (failure === 'READ_TIMEOUT') context.mock.timers.enable({apis: ['setTimeout']});
    globalThis.fetch = async (input, init) => {
      const path = String(input); calls.push({path, method: init?.method});
      if (path.endsWith('/workspaces')) return envelope(workspaceReads++ === 0 ? [{...workspaces[0], role: 'owner'}] : workspaces);
      if (sessionReads++ > 0) return envelope(session);
      if (failure === 'NETWORK_UNAVAILABLE') throw new TypeError('Unit transport unavailable');
      if (failure === 'READ_TIMEOUT') return stalled.promise;
      return Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Unit temporary read failure'}}, {status: failure});
    };
    try {
      const account = readAccountAfterAuthentication(new AbortController().signal, () => {retries++;});
      if (failure === 'READ_TIMEOUT') context.mock.timers.tick(15_000);
      assert.deepEqual(await account, {session, workspaces});
      assert.equal(retries, 1);
      assert.deepEqual(calls, [
        {path: '/api/v1/session', method: 'GET'}, {path: '/api/v1/workspaces', method: 'GET'},
        {path: '/api/v1/session', method: 'GET'}, {path: '/api/v1/workspaces', method: 'GET'}
      ]);
      // A late session from the first attempt cannot pair with its old owner role.
      stalled.resolve(envelope({...session, user: {...session.user, id: 'old-user'}}));
    } finally {globalThis.fetch = original; context.mock.timers.reset();}
  });
});

test('persistent post-authentication read failures remain unavailable after exactly two account attempts', async t => {
  for (const failure of transientFailures) await t.test(String(failure), async context => {
    const original = globalThis.fetch, stalled = deferred<Response>(), calls: string[] = [];
    let retries = 0;
    if (failure === 'READ_TIMEOUT') context.mock.timers.enable({apis: ['setTimeout']});
    globalThis.fetch = async (input, init) => {
      calls.push(String(input)); assert.equal(init?.method, 'GET');
      if (String(input).endsWith('/workspaces')) return envelope(workspaces);
      if (failure === 'NETWORK_UNAVAILABLE') throw new TypeError('Unit transport unavailable');
      if (failure === 'READ_TIMEOUT') return stalled.promise;
      return Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Unit persistent read failure'}}, {status: failure});
    };
    try {
      const rejected = assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => {retries++;}), (cause: unknown) =>
        cause instanceof ApiError && (typeof failure === 'number' ? cause.status === failure : cause.code === failure));
      if (failure === 'READ_TIMEOUT') {context.mock.timers.tick(15_000); await setImmediate(); context.mock.timers.tick(15_000);}
      await rejected;
      assert.equal(retries, 1);
      assert.deepEqual(calls, ['/api/v1/session', '/api/v1/workspaces', '/api/v1/session', '/api/v1/workspaces']);
      stalled.resolve(envelope(session));
    } finally {globalThis.fetch = original; context.mock.timers.reset();}
  });
});

test('post-authentication nontransient HTTP failures never retry or publish permissions', async t => {
  const failures = [{status: 401, endpoint: 'session'}, {status: 401, endpoint: 'workspaces'}, {status: 403, endpoint: 'session'}, {status: 403, endpoint: 'workspaces'}, {status: 400, endpoint: 'session'}];
  for (const {status, endpoint} of failures) await t.test(`${status} ${endpoint}`, async () => {
    const original = globalThis.fetch, calls: string[] = []; let retries = 0;
    globalThis.fetch = async (input, init) => {
      calls.push(String(input)); assert.equal(init?.method, 'GET');
      return String(input).endsWith(`/${endpoint}`)
        ? Response.json({error: {code: 'READ_TIMEOUT', message: 'Unit denied account read'}}, {status})
        : envelope(endpoint === 'session' ? [{...workspaces[0], role: 'owner'}] : session);
    };
    try {
      await assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => {retries++;}), (cause: unknown) => cause instanceof ApiError && cause.status === status);
      assert.equal(retries, 0); assert.deepEqual(calls, ['/api/v1/session', '/api/v1/workspaces']);
    } finally {globalThis.fetch = original;}
  });
});

test('both account endpoints validate on the initial and retried attempt without retrying malformed data', async t => {
  for (const endpoint of ['session', 'workspaces']) for (const retried of [false, true]) await t.test(`${endpoint} ${retried ? 'retry' : 'initial'}`, async () => {
    const original = globalThis.fetch, calls: string[] = []; let sessionReads = 0, workspaceReads = 0, retries = 0;
    globalThis.fetch = async (input, init) => {
      const path = String(input); calls.push(path); assert.equal(init?.method, 'GET');
      const isSession = path.endsWith('/session'), attempt = isSession ? sessionReads++ : workspaceReads++;
      if (retried && attempt === 0 && isSession) return Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Unit temporary failure'}}, {status: 503});
      if (path.endsWith(`/${endpoint}`) && attempt === Number(retried)) return envelope(isSession ? {...session, csrf_token: ''} : [{...workspaces[0], role: 'administrator'}]);
      return envelope(isSession ? session : workspaces);
    };
    try {
      await assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => {retries++;}), endpoint === 'session' ? /current session response was unavailable/ : /permitted workspace list was unavailable/);
      assert.equal(retries, Number(retried)); assert.equal(calls.length, retried ? 4 : 2);
    } finally {globalThis.fetch = original;}
  });
});

test('external cancellation during either account attempt rejects late responses without publishing old roles', async t => {
  for (const attempt of [1, 2]) await t.test(`attempt ${attempt}`, async () => {
    const original = globalThis.fetch, stalled = deferred<Response>(), controller = new AbortController();
    let sessionReads = 0, calls = 0, retries = 0, published = false, pendingSessionTransport: AbortSignal | undefined;
    globalThis.fetch = async (input, init) => {
      calls++; assert.equal(init?.method, 'GET');
      if (String(input).endsWith('/workspaces')) return envelope([{...workspaces[0], role: 'owner'}]);
      if (++sessionReads < attempt) return Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Unit temporary failure'}}, {status: 503});
      pendingSessionTransport = init?.signal as AbortSignal;
      return stalled.promise; // Deliberately ignores the transport's abort signal.
    };
    try {
      const account = readAccountAfterAuthentication(controller.signal, () => {retries++;}).then(value => {published = true; return value;});
      const rejected = assert.rejects(account, (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
      await setImmediate(); controller.abort(); stalled.resolve(envelope(session)); await rejected;
      assert.equal(published, false); assert.equal(retries, attempt - 1); assert.equal(calls, attempt * 2);
      assert.equal(pendingSessionTransport?.aborted, true);
    } finally {globalThis.fetch = original;}
  });
});

test('external cancellation before reading or during the retry notice prevents another account attempt', async t => {
  for (const when of ['before', 'retry-notice']) await t.test(when, async () => {
    const original = globalThis.fetch, controller = new AbortController(); let calls = 0, retries = 0;
    globalThis.fetch = async (input, init) => {
      calls++; assert.equal(init?.method, 'GET');
      return String(input).endsWith('/session') ? Response.json({error: {code: 'READ_UNAVAILABLE', message: 'Unit temporary failure'}}, {status: 503}) : envelope(workspaces);
    };
    try {
      if (when === 'before') controller.abort();
      await assert.rejects(readAccountAfterAuthentication(controller.signal, () => {retries++; controller.abort();}), (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
      assert.equal(calls, when === 'before' ? 0 : 2); assert.equal(retries, when === 'before' ? 0 : 1);
    } finally {globalThis.fetch = original;}
  });
});
