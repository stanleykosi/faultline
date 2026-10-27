import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, casePath, request, resource } from './api';
import { commandKey, type CommandIdentity } from './command-key';
import { setImmediate } from 'node:timers/promises';
import { boundedResource, readAccount, readAccountAfterAuthentication } from './read-state';
import { readRecords, type RecordRead } from './features/data/read-records';
import { renderToStaticMarkup } from 'react-dom/server';
import { Login } from './features/auth/Login';
import { displayLabel } from './plain-language';
describe("Request authorization and command identity", () => {
    test("scoped mutations bind reviewed authority without leaking deletion tokens", async () => {
        {
            const original = globalThis.fetch;
            let observed: RequestInit | undefined;
            globalThis.fetch = async (_input, init) => { observed = init; return Response.json({ data: { id: 'case-1', revision: 5 }, meta: { request_id: 'actual-request' } }); };
            try {
                const result = await resource<{
                    id: string;
                    revision: number;
                }>('/api/v1/workspaces/w/cases/c', { method: 'PATCH', body: { title: 'Reviewed title' }, csrf: 'session-bound-token', revision: 4, idempotencyKey: 'same-command-key' });
                const headers = observed?.headers as Record<string, string>;
                assert.equal(headers['X-CSRF-Token'], 'session-bound-token');
                assert.equal(headers['Idempotency-Key'], 'same-command-key');
                assert.equal(headers['X-Faultline-Revision'], '4');
                assert.equal(headers['If-Match'], undefined, 'Application revisions must not trigger hosting entity-tag preconditions');
                assert.equal(observed?.credentials, 'same-origin');
                assert.deepEqual(result, { id: 'case-1', revision: 5 });
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            let observed: RequestInit | undefined, observedPath = '';
            globalThis.fetch = async (input, init) => { observedPath = String(input); observed = init; return Response.json({ data: { request_id: 'unit-receipt', status: 'pending_containment' }, meta: { request_id: 'unit-transport' } }); };
            try {
                await resource('/api/v1/workspaces/w/cases/c', { method: 'DELETE', csrf: 'unit-csrf', revision: 7, idempotencyKey: 'unit-delete-intent', deletionReviewToken: 'unit-private-review-token' });
                const headers = observed?.headers as Record<string, string>;
                assert.equal(headers['X-Deletion-Review-Token'], 'unit-private-review-token');
                assert.equal(headers['X-Faultline-Revision'], '7');
                assert.equal(headers['Idempotency-Key'], 'unit-delete-intent');
                assert.equal(headers['X-CSRF-Token'], 'unit-csrf');
                assert.equal(observed?.body, undefined);
                assert.equal(observedPath.includes('review-token'), false);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
    test("denied and disconnected resources remain errors", async () => {
        {
            const original = globalThis.fetch;
            globalThis.fetch = async () => Response.json({ error: { code: 'NOT_FOUND', message: 'The resource is unavailable.', retryable: false, field_errors: [] }, meta: { request_id: 'tenant-denial' } }, { status: 404 });
            try {
                await assert.rejects(resource('/api/v1/workspaces/other/cases/private'), (error: unknown) => error instanceof ApiError && error.status === 404 && error.requestId === 'tenant-denial');
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            globalThis.fetch = async () => { throw new TypeError('connection lost'); };
            try {
                await assert.rejects(resource('/api/v1/workspaces'), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE' && error.status === 0);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
    test('a concurrent revision conflict remains an actionable failure with safe field details', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = async () => Response.json({ error: { code: 'STALE_INPUTS', message: 'Refresh the investigation before changing its scope.', retryable: false, field_errors: [{ field: 'revision', message: 'Current revision is newer.' }] }, meta: { request_id: 'conflict' } }, { status: 409 });
        try {
            await assert.rejects(request('/api/v1/workspaces/w/cases/c', { method: 'PATCH', revision: 1, csrf: 'bound-token', body: { question: 'New question' } }), (error: unknown) => error instanceof ApiError && error.code === 'STALE_INPUTS' && error.fields[0].field === 'revision');
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('resource identity is encoded in the scoped URL instead of changing its route', () => {
        assert.equal(casePath('workspace/other', 'case?private=true'), '/api/v1/workspaces/workspace%2Fother/cases/case%3Fprivate%3Dtrue');
    });
    test("uncertain commands retry once per user intent and rotate when reviewed intent changes", async () => {
        {
            const original = globalThis.fetch;
            const command: {
                current: CommandIdentity;
            } = { current: null };
            const committed = new Map<string, {
                id: string;
                name: string;
            }>();
            const observedKeys: string[] = [];
            let loseFirstResponse = true;
            globalThis.fetch = async (_input, init) => {
                const headers = init?.headers as Record<string, string>, key = headers['Idempotency-Key'];
                observedKeys.push(key);
                const body = JSON.parse(init?.body as string) as {
                    name: string;
                };
                if (!committed.has(key))
                    committed.set(key, { id: `workspace-${committed.size + 1}`, name: body.name });
                if (loseFirstResponse) {
                    loseFirstResponse = false;
                    throw new TypeError('Unit fixture lost the committed reply.');
                }
                return Response.json({ data: committed.get(key), meta: { request_id: 'retried-command' } });
            };
            const submit = (name: string) => {
                const path = '/api/v1/workspaces', body = { name };
                return resource<{
                    id: string;
                    name: string;
                }>(path, { method: 'POST', csrf: 'unit-bound-session', body, idempotencyKey: commandKey(command, { path, method: 'POST', body }) });
            };
            try {
                await assert.rejects(submit('Checkout team'), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
                assert.equal(observedKeys.length, 1, 'a failed request must not trigger an automatic mutation retry');
                const recovered = await submit('Checkout team');
                assert.equal(recovered.id, 'workspace-1');
                assert.equal(committed.size, 1);
                assert.equal(observedKeys[0], observedKeys[1]);
                await submit('Edited workspace name');
                assert.equal(committed.size, 2);
                assert.notEqual(observedKeys[1], observedKeys[2]);
                command.current = null;
                await submit('Edited workspace name');
                assert.equal(committed.size, 3);
                assert.notEqual(observedKeys[2], observedKeys[3]);
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const command: {
                current: CommandIdentity;
            } = { current: null };
            const first = commandKey(command, { path: '/cases/one', revision: 1, body: { title: 'A', question: 'B' } });
            assert.equal(commandKey(command, { body: { question: 'B', title: 'A' }, revision: 1, path: '/cases/one' }), first);
            const revised = commandKey(command, { path: '/cases/one', revision: 2, body: { title: 'A', question: 'B' } });
            assert.notEqual(revised, first);
            assert.notEqual(commandKey(command, { path: '/cases/two', revision: 2, body: { title: 'A', question: 'B' } }), revised);
        }
    });
});
describe("Account and scoped read lifecycle", () => {
    const session = { user: { id: 'unit-user', name: 'Unit account', email: 'unit@example.invalid' }, csrf_token: 'unit-session-token' };
    const workspaces = [{ id: 'unit-workspace', name: 'Unit workspace', created_at: '2026-10-11T00:00:00Z', role: 'viewer', revision: 1 }];
    const investigation = { id: 'unit-case', workspace_id: 'unit-workspace', title: 'Unit question', question: 'What changed?', revision: 2 };
    const envelope = (value: unknown) => Response.json({ data: value, meta: { request_id: 'unit-only' } });
    function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
    test("account permissions publish only after both endpoints authenticate and validate", async () => {
        {
            const original = globalThis.fetch, pendingSession = deferred<Response>(), paths: string[] = [];
            globalThis.fetch = async (input, init) => { paths.push(String(input)); assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'same-origin'); return String(input).endsWith('/session') ? pendingSession.promise : envelope(workspaces); };
            try {
                let published = false;
                const account = readAccount(new AbortController().signal).then(value => { published = true; return value; });
                assert.deepEqual(paths, ['/api/v1/session', '/api/v1/workspaces']);
                await setImmediate();
                assert.equal(published, false);
                pendingSession.resolve(envelope(session));
                assert.deepEqual(await account, { session, workspaces });
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            globalThis.fetch = async (input) => String(input).endsWith('/session') ? Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again.' } }, { status: 401 }) : envelope([{ ...workspaces[0], role: 'owner' }]);
            try {
                await assert.rejects(readAccount(new AbortController().signal), (cause: unknown) => cause instanceof ApiError && cause.status === 401);
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            globalThis.fetch = async (input) => envelope(String(input).endsWith('/session') ? session : [{ ...workspaces[0], role: 'administrator' }]);
            try {
                await assert.rejects(readAccount(new AbortController().signal), /permitted workspace list was unavailable/);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
    test("cancelled account and case reads cannot publish obsolete roles or metadata", async () => {
        {
            const original = globalThis.fetch, response = deferred<Response>(), controller = new AbortController();
            globalThis.fetch = async (input) => String(input).endsWith('/session') ? response.promise : envelope(workspaces);
            try {
                const account = readAccount(controller.signal), rejected = assert.rejects(account, (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
                controller.abort();
                response.resolve(envelope(session));
                await rejected;
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch, response = deferred<Response>(), controller = new AbortController(), published: unknown[] = [];
            globalThis.fetch = async () => response.promise;
            try {
                const read = readRecords('/api/v1/workspaces/unit-workspace/cases/unit-case', controller.signal, { investigation: value => published.push(value), snapshots: value => published.push(value), metrics: value => published.push(value) });
                controller.abort();
                response.resolve(envelope(investigation));
                await read;
                assert.deepEqual(published, []);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
    test('the case is published while ancillary metadata is delayed, and a denied list stays unavailable', async () => {
        const original = globalThis.fetch, snapshots = deferred<Response>(), metrics = deferred<Response>(), states: {
            kind: string;
            state: RecordRead<unknown>;
        }[] = [];
        globalThis.fetch = async (input) => String(input).endsWith('/snapshots') ? snapshots.promise : String(input).endsWith('/metrics') ? metrics.promise : envelope(investigation);
        const listeners = { investigation: (state: RecordRead<unknown>) => states.push({ kind: 'case', state }), snapshots: (state: RecordRead<unknown>) => states.push({ kind: 'snapshots', state }), metrics: (state: RecordRead<unknown>) => states.push({ kind: 'metrics', state }) };
        try {
            const read = readRecords('/api/v1/workspaces/unit-workspace/cases/unit-case', new AbortController().signal, listeners);
            await setImmediate();
            assert.deepEqual(states.map(item => item.kind), ['case']);
            assert.equal(states[0].state.status, 'ready');
            snapshots.resolve(Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Snapshot records unavailable.' } }, { status: 503 }));
            metrics.resolve(envelope([]));
            await read;
            assert.equal(states.find(item => item.kind === 'snapshots')?.state.status, 'unavailable');
            const metricState = states.find(item => item.kind === 'metrics')?.state;
            assert.equal(metricState?.status, 'ready');
            if (metricState?.status === 'ready')
                assert.deepEqual(metricState.value, []);
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('a stalled read has a bounded unavailable outcome and aborts its transport without retrying', async () => {
        const original = globalThis.fetch, response = deferred<Response>();
        let transport: AbortSignal | undefined, calls = 0;
        globalThis.fetch = async (_input, init) => { calls++; transport = init?.signal as AbortSignal; return response.promise; };
        try {
            await assert.rejects(boundedResource('/api/v1/workspaces/unit-workspace/cases/unit-case', undefined, 20), (cause: unknown) => cause instanceof ApiError && cause.status === 0 && cause.code === 'READ_TIMEOUT');
            assert.equal(transport?.aborted, true);
            assert.equal(calls, 1);
            response.resolve(envelope(investigation));
        }
        finally {
            globalThis.fetch = original;
        }
    });
    const transientFailures = ['NETWORK_UNAVAILABLE', 'READ_TIMEOUT', 502, 503, 504] as const;
    test("post-authentication recovery retries transient reads once and leaves persistent failures unavailable", async (t) => {
        {
            for (const failure of transientFailures)
                await t.test(String(failure), async (context) => {
                    const original = globalThis.fetch, stalled = deferred<Response>(), calls: {
                        path: string;
                        method: string | undefined;
                    }[] = [];
                    let sessionReads = 0, workspaceReads = 0, retries = 0;
                    if (failure === 'READ_TIMEOUT')
                        context.mock.timers.enable({ apis: ['setTimeout'] });
                    globalThis.fetch = async (input, init) => {
                        const path = String(input);
                        calls.push({ path, method: init?.method });
                        if (path.endsWith('/workspaces'))
                            return envelope(workspaceReads++ === 0 ? [{ ...workspaces[0], role: 'owner' }] : workspaces);
                        if (sessionReads++ > 0)
                            return envelope(session);
                        if (failure === 'NETWORK_UNAVAILABLE')
                            throw new TypeError('Unit transport unavailable');
                        if (failure === 'READ_TIMEOUT')
                            return stalled.promise;
                        return Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Unit temporary read failure' } }, { status: failure });
                    };
                    try {
                        const account = readAccountAfterAuthentication(new AbortController().signal, () => { retries++; });
                        if (failure === 'READ_TIMEOUT')
                            context.mock.timers.tick(15000);
                        assert.deepEqual(await account, { session, workspaces });
                        assert.equal(retries, 1);
                        assert.deepEqual(calls, [
                            { path: '/api/v1/session', method: 'GET' }, { path: '/api/v1/workspaces', method: 'GET' },
                            { path: '/api/v1/session', method: 'GET' }, { path: '/api/v1/workspaces', method: 'GET' }
                        ]);
                        // A late session from the first attempt cannot pair with its old owner role.
                        stalled.resolve(envelope({ ...session, user: { ...session.user, id: 'old-user' } }));
                    }
                    finally {
                        globalThis.fetch = original;
                        context.mock.timers.reset();
                    }
                });
        }
        {
            for (const failure of transientFailures)
                await t.test(String(failure), async (context) => {
                    const original = globalThis.fetch, stalled = deferred<Response>(), calls: string[] = [];
                    let retries = 0;
                    if (failure === 'READ_TIMEOUT')
                        context.mock.timers.enable({ apis: ['setTimeout'] });
                    globalThis.fetch = async (input, init) => {
                        calls.push(String(input));
                        assert.equal(init?.method, 'GET');
                        if (String(input).endsWith('/workspaces'))
                            return envelope(workspaces);
                        if (failure === 'NETWORK_UNAVAILABLE')
                            throw new TypeError('Unit transport unavailable');
                        if (failure === 'READ_TIMEOUT')
                            return stalled.promise;
                        return Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Unit persistent read failure' } }, { status: failure });
                    };
                    try {
                        const rejected = assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => { retries++; }), (cause: unknown) => cause instanceof ApiError && (typeof failure === 'number' ? cause.status === failure : cause.code === failure));
                        if (failure === 'READ_TIMEOUT') {
                            context.mock.timers.tick(15000);
                            await setImmediate();
                            context.mock.timers.tick(15000);
                        }
                        await rejected;
                        assert.equal(retries, 1);
                        assert.deepEqual(calls, ['/api/v1/session', '/api/v1/workspaces', '/api/v1/session', '/api/v1/workspaces']);
                        stalled.resolve(envelope(session));
                    }
                    finally {
                        globalThis.fetch = original;
                        context.mock.timers.reset();
                    }
                });
        }
    });
    test("nontransient and malformed reads never retry or publish permissions", async (t) => {
        {
            const failures = [{ status: 401, endpoint: 'session' }, { status: 401, endpoint: 'workspaces' }, { status: 403, endpoint: 'session' }, { status: 403, endpoint: 'workspaces' }, { status: 400, endpoint: 'session' }];
            for (const { status, endpoint } of failures)
                await t.test(`${status} ${endpoint}`, async () => {
                    const original = globalThis.fetch, calls: string[] = [];
                    let retries = 0;
                    globalThis.fetch = async (input, init) => {
                        calls.push(String(input));
                        assert.equal(init?.method, 'GET');
                        return String(input).endsWith(`/${endpoint}`)
                            ? Response.json({ error: { code: 'READ_TIMEOUT', message: 'Unit denied account read' } }, { status })
                            : envelope(endpoint === 'session' ? [{ ...workspaces[0], role: 'owner' }] : session);
                    };
                    try {
                        await assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => { retries++; }), (cause: unknown) => cause instanceof ApiError && cause.status === status);
                        assert.equal(retries, 0);
                        assert.deepEqual(calls, ['/api/v1/session', '/api/v1/workspaces']);
                    }
                    finally {
                        globalThis.fetch = original;
                    }
                });
        }
        {
            for (const endpoint of ['session', 'workspaces'])
                for (const retried of [false, true])
                    await t.test(`${endpoint} ${retried ? 'retry' : 'initial'}`, async () => {
                        const original = globalThis.fetch, calls: string[] = [];
                        let sessionReads = 0, workspaceReads = 0, retries = 0;
                        globalThis.fetch = async (input, init) => {
                            const path = String(input);
                            calls.push(path);
                            assert.equal(init?.method, 'GET');
                            const isSession = path.endsWith('/session'), attempt = isSession ? sessionReads++ : workspaceReads++;
                            if (retried && attempt === 0 && isSession)
                                return Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Unit temporary failure' } }, { status: 503 });
                            if (path.endsWith(`/${endpoint}`) && attempt === Number(retried))
                                return envelope(isSession ? { ...session, csrf_token: '' } : [{ ...workspaces[0], role: 'administrator' }]);
                            return envelope(isSession ? session : workspaces);
                        };
                        try {
                            await assert.rejects(readAccountAfterAuthentication(new AbortController().signal, () => { retries++; }), endpoint === 'session' ? /current session response was unavailable/ : /permitted workspace list was unavailable/);
                            assert.equal(retries, Number(retried));
                            assert.equal(calls.length, retried ? 4 : 2);
                        }
                        finally {
                            globalThis.fetch = original;
                        }
                    });
        }
    });
    test("cancellation during either attempt or its retry notice prevents late publication", async (t) => {
        {
            for (const attempt of [1, 2])
                await t.test(`attempt ${attempt}`, async () => {
                    const original = globalThis.fetch, stalled = deferred<Response>(), controller = new AbortController();
                    let sessionReads = 0, calls = 0, retries = 0, published = false, pendingSessionTransport: AbortSignal | undefined;
                    globalThis.fetch = async (input, init) => {
                        calls++;
                        assert.equal(init?.method, 'GET');
                        if (String(input).endsWith('/workspaces'))
                            return envelope([{ ...workspaces[0], role: 'owner' }]);
                        if (++sessionReads < attempt)
                            return Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Unit temporary failure' } }, { status: 503 });
                        pendingSessionTransport = init?.signal as AbortSignal;
                        return stalled.promise; // Deliberately ignores the transport's abort signal.
                    };
                    try {
                        const account = readAccountAfterAuthentication(controller.signal, () => { retries++; }).then(value => { published = true; return value; });
                        const rejected = assert.rejects(account, (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
                        await setImmediate();
                        controller.abort();
                        stalled.resolve(envelope(session));
                        await rejected;
                        assert.equal(published, false);
                        assert.equal(retries, attempt - 1);
                        assert.equal(calls, attempt * 2);
                        assert.equal(pendingSessionTransport?.aborted, true);
                    }
                    finally {
                        globalThis.fetch = original;
                    }
                });
        }
        {
            for (const when of ['before', 'retry-notice'])
                await t.test(when, async () => {
                    const original = globalThis.fetch, controller = new AbortController();
                    let calls = 0, retries = 0;
                    globalThis.fetch = async (input, init) => {
                        calls++;
                        assert.equal(init?.method, 'GET');
                        return String(input).endsWith('/session') ? Response.json({ error: { code: 'READ_UNAVAILABLE', message: 'Unit temporary failure' } }, { status: 503 }) : envelope(workspaces);
                    };
                    try {
                        if (when === 'before')
                            controller.abort();
                        await assert.rejects(readAccountAfterAuthentication(controller.signal, () => { retries++; controller.abort(); }), (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError');
                        assert.equal(calls, when === 'before' ? 0 : 2);
                        assert.equal(retries, when === 'before' ? 0 : 1);
                    }
                    finally {
                        globalThis.fetch = original;
                    }
                });
        }
    });
});
describe("Authentication recovery", () => {
    const actions = { onRetry: () => { }, onSignedIn: async () => { } };
    const render = (error: Error | null) => renderToStaticMarkup(<Login unavailable={error !== null} {...actions}/>);
    test("unavailable accounts disable mutations and a signed-out retry restores sign-in", async () => {
        {
            const original = globalThis.fetch;
            globalThis.fetch = async () => Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Internal configuration detail' } }, { status: 503 });
            try {
                let error: Error | null = null;
                try {
                    await readAccount(new AbortController().signal);
                    assert.fail('Unavailable session must not authenticate.');
                }
                catch (cause) {
                    assert.ok(cause instanceof ApiError && cause.status === 503);
                    error = cause;
                }
                const html = render(error);
                assert.match(html, /Sign in to Faultline/);
                assert.match(html, /name="email"/);
                assert.match(html, /name="password"/);
                assert.match(html, /We couldn’t load your account\. Try again\./);
                assert.match(html, /type="button">Try again<\/button>/);
                assert.match(html, /type="submit" disabled=""/);
                assert.match(html, /aria-pressed="false" disabled="">Create account/);
                assert.doesNotMatch(html, /Internal configuration detail|Invalid password|Workspace navigation/);
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            const attempts: number[] = [];
            globalThis.fetch = async () => {
                const status = attempts.length < 2 ? 503 : 401;
                attempts.push(status);
                return Response.json({ error: { code: status === 401 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE', message: 'Unavailable' } }, { status });
            };
            try {
                for (const expectedStatus of [503, 401]) {
                    let error: Error | null = null;
                    try {
                        await readAccount(new AbortController().signal);
                        assert.fail('No response contains an authenticated account.');
                    }
                    catch (cause) {
                        assert.ok(cause instanceof ApiError);
                        assert.equal(cause.status, expectedStatus);
                        if (cause.status !== 401)
                            error = cause;
                    }
                    const html = render(error);
                    assert.match(html, /Sign in to Faultline/);
                    if (expectedStatus === 503)
                        assert.match(html, /type="submit" disabled=""/);
                    else {
                        assert.doesNotMatch(html, /temporarily unavailable|type="submit" disabled=""/);
                        assert.match(html, /aria-pressed="false">Create account/);
                    }
                }
                assert.deepEqual(attempts, [503, 503, 401, 401]);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
});
describe("Honest display states", () => {
    test('friendly labels preserve distinct untested, failed, blocked, stale and unknown states', () => {
        const states = ['not_established', 'untested', 'not_reproduced', 'failed', 'blocked', 'stale', 'unknown', 'not_run'];
        for (const state of states)
            assert.doesNotMatch(displayLabel(state), /^(?:passed|validated|reproduced)$/i);
        assert.equal(displayLabel('association_only'), 'Observed link only');
        assert.equal(displayLabel('specified_snapshot_and_test_environment'), 'Selected data and test environment');
        assert.equal(displayLabel('untested'), 'Not tested');
        assert.equal(displayLabel('not_reproduced'), 'Not reproduced');
        assert.equal(displayLabel('failed'), 'failed');
        assert.equal(displayLabel('sanitized'), 'Filtered');
        assert.equal(displayLabel('inconclusive'), 'No conclusion');
        assert.equal(displayLabel('mechanism'), 'Issue reproduction');
        assert.equal(displayLabel('complete_attested'), 'Complete (reported)');
        assert.equal(displayLabel('provisional'), 'May change');
        assert.equal(displayLabel('incomplete'), 'Incomplete');
    });
});
