import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createJobEventWatcher, JobCursorStore, JobEventParser, type JobConnection, type JobEvent, type JobStreamView } from './job-stream';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../../api';
import { type CommandIdentity } from '../../command-key';
import { JobPanel, FollowupJobOutcome, recordedFollowupOutcome, jobRecoveryMode, recoverJob, type JobRecoveryReceipt, type RecoveryJob } from './Presentation';
describe("Scoped progress stream", () => {
    const encoder = new TextEncoder(), path = '/api/v1/workspaces/workspace-unit/jobs/job-unit/events';
    const time = '2026-10-12T10:00:00.123456Z';
    const frame = (id: string, payload: Record<string, unknown> = { status: 'running', attempt: 1, created_at: time }) => `id: ${id}\nevent: job\ndata: ${JSON.stringify(payload)}\n\n`;
    const eventResponse = (text: string) => new Response(encoder.encode(text), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    const immediately = async () => { };
    test("incremental progress parsing preserves split UTF-8 and exact monotonic cursor identities", () => {
        {
            const seen: JobEvent[] = [], parser = new JobEventParser(null, event => seen.push(event), () => assert.fail('Unexpected access closure'));
            const bytes = encoder.encode(': heartbeat\r\n\r\n' + frame('17', { status: 'running', attempt: 2, created_at: time, reason: 'untrusted café 🚦 <script>data</script>' }).replaceAll('\n', '\r\n'));
            for (const byte of bytes)
                parser.push(new Uint8Array([byte]));
            parser.finish();
            assert.deepEqual(seen, [{ id: '17', status: 'running', attempt: 2, created_at: time }]);
            assert.equal(parser.cursor, '17');
            assert.throws(() => new JobEventParser(null, () => { }, () => { }).push(new Uint8Array([0xff])), /invalid or exceeded/);
        }
        {
            const seen: JobEvent[] = [], parser = new JobEventParser('9007199254740992', event => seen.push(event), () => { });
            parser.push(encoder.encode(frame('9007199254740993') + frame('9007199254740993') + frame('9007199254740991') + frame('9007199254740994')));
            parser.finish();
            assert.deepEqual(seen.map(event => event.id), ['9007199254740993', '9007199254740994']);
            assert.equal(parser.cursor, '9007199254740994');
        }
    });
    test("malformed, forged, incomplete and closed streams cannot publish progress", () => {
        {
            const invalid = ['0', '-1', '1e3', '1.5', '1234567890123456789', '1\u0000', ''];
            for (const id of invalid) {
                const parser = new JobEventParser(null, () => assert.fail('Invalid ID delivered'), () => { });
                assert.throws(() => parser.push(encoder.encode(frame(id))), /invalid or exceeded/);
                assert.equal(parser.cursor, null);
            }
            for (const payload of [{ status: 'PASS', created_at: time }, { status: 'running', attempt: -1, created_at: time }, { status: 'running', created_at: '<script>timestamp</script>' }])
                assert.throws(() => new JobEventParser(null, () => assert.fail('Invalid event delivered'), () => { }).push(encoder.encode(frame('1', payload))), /invalid or exceeded/);
            for (const oversized of ['data: ' + 'x'.repeat(8193), ': ' + 'a'.repeat(8100) + '\n: ' + 'b'.repeat(8100) + '\n: ' + 'c'.repeat(1000) + '\n\n'])
                assert.throws(() => new JobEventParser(null, () => assert.fail('Oversized frame delivered'), () => { }).push(encoder.encode(oversized)), /invalid or exceeded/);
            const bounded = new JobEventParser(null, () => { }, () => { }), heartbeats = encoder.encode(': heartbeat\n\n'.repeat(1000));
            assert.throws(() => { for (let index = 0; index < 100; index++)
                bounded.push(heartbeats); }, /invalid or exceeded/);
        }
        {
            const seen: JobEvent[] = [], partial = new JobEventParser('8', event => seen.push(event), () => { });
            partial.push(encoder.encode(frame('9').slice(0, -1)));
            partial.finish();
            assert.equal(seen.length, 0);
            assert.equal(partial.cursor, '8');
            let closed = 0;
            const parser = new JobEventParser('8', event => seen.push(event), () => closed++);
            parser.push(encoder.encode('event: access_closed\ndata: {}\n\n' + frame('9')));
            parser.finish();
            assert.equal(closed, 1);
            assert.equal(parser.cursor, '8');
            assert.deepEqual(seen, []);
        }
    });
    test('reconnect sends the exact last complete cursor, deduplicates replay and never performs business requests', async () => {
        const stop = new AbortController(), calls: {
            path: string;
            headers: Headers;
            method?: string;
            credentials?: RequestCredentials;
        }[] = [], seen: JobEvent[] = [], connections: JobConnection[] = [], waits: number[] = [];
        const watcher = createJobEventWatcher({ fetch: async (input, options) => { calls.push({ path: String(input), headers: new Headers(options?.headers), method: options?.method, credentials: options?.credentials }); return eventResponse(calls.length === 1 ? frame('41') + frame('42') : frame('42') + frame('43', { status: 'succeeded', created_at: time })); }, sleep: async (delay) => { waits.push(delay); } });
        await watcher(path, { signal: stop.signal, cursor: '40', onEvent: event => { seen.push(event); if (event.id === '43')
                stop.abort(); }, onConnection: state => connections.push(state) });
        assert.equal(calls.length, 2);
        assert.equal(calls[0].headers.get('Last-Event-ID'), '40');
        assert.equal(calls[1].headers.get('Last-Event-ID'), '42');
        for (const call of calls) {
            assert.equal(call.path, path);
            assert.equal(call.method, 'GET');
            assert.equal(call.credentials, 'same-origin');
            assert.equal(call.headers.get('Accept'), 'text/event-stream');
        }
        assert.deepEqual(seen.map(event => event.id), ['41', '42', '43']);
        assert.deepEqual(waits, [1000]);
        assert.ok(connections.some(value => value.state === 'reconnecting' && value.cursor === '42'));
    });
    test('401, 403, 404 and explicit access_closed invalidate the connection instead of retrying or announcing outcomes', async () => {
        for (const response of [new Response(null, { status: 401 }), new Response(null, { status: 403 }), new Response(null, { status: 404 }), eventResponse('event: access_closed\ndata: {}\n\n' + frame('3'))]) {
            let calls = 0;
            const states: JobConnection[] = [], watcher = createJobEventWatcher({ fetch: async () => { calls++; return response; }, sleep: async () => assert.fail('Access closure must not retry') });
            await watcher(path, { signal: new AbortController().signal, cursor: '2', onEvent: () => assert.fail('Access-closed outcome delivered'), onConnection: value => states.push(value) });
            assert.equal(calls, 1);
            assert.equal(states.at(-1)?.state, 'access_closed');
            assert.equal(states.at(-1)?.cursor, '2');
        }
    });
    test('network failures use finite backoff and error MIME/HTTP never becomes progress', async () => {
        const delays: number[] = [], states: JobConnection[] = [];
        let calls = 0;
        await createJobEventWatcher({ fetch: async () => { calls++; throw new TypeError('Injected unit network failure'); }, sleep: async (delay) => { delays.push(delay); } })(path, { signal: new AbortController().signal, cursor: null, onEvent: () => assert.fail('Network error is not progress'), onConnection: value => states.push(value) });
        assert.equal(calls, 6);
        assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
        assert.equal(states.at(-1)?.state, 'unavailable');
        for (const response of [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), new Response(null, { status: 400 }), new Response(null, { status: 204 })]) {
            const seen: JobConnection[] = [];
            await createJobEventWatcher({ fetch: async () => response, sleep: immediately })(path, { signal: new AbortController().signal, cursor: '1', onEvent: () => assert.fail('Invalid response is not progress'), onConnection: value => seen.push(value) });
            assert.equal(seen.at(-1)?.state, 'unavailable');
        }
    });
    test('read timeout and unmount abort the owned request/reader and deliver no events after abort', async () => {
        for (const mode of ['timeout', 'unmount']) {
            const stop = new AbortController();
            let cancelled = false, requestSignal: AbortSignal | null = null;
            const states: JobConnection[] = [];
            const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
            const watcher = createJobEventWatcher({ fetch: async (_path, options) => { requestSignal = options?.signal ?? null; return response; }, readTimeoutMs: 10, sleep: async () => stop.abort() });
            await watcher(path, { signal: stop.signal, cursor: '6', onEvent: () => assert.fail('Aborted reader delivered progress'), onConnection: value => { states.push(value); if (mode === 'unmount' && value.state === 'connected')
                    stop.abort(); } });
            assert.equal((requestSignal as AbortSignal | null)?.aborted, true);
            assert.equal(cancelled, true);
            assert.ok(mode === 'unmount' || states.some(value => value.state === 'reconnecting'));
            assert.equal(states.at(-1)?.cursor, '6');
        }
    });
    test('cursor persistence is scoped, monotonic, bounded and contains no event payload or business authority', () => {
        let raw: string | null = null;
        const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
        const store = new JobCursorStore(storage);
        store.set('w/c/job-one', '9007199254740993');
        store.set('w/c/job-two', '7');
        store.set('w/c/job-one', '9007199254740992');
        const fresh = new JobCursorStore(storage);
        assert.equal(fresh.get('w/c/job-one'), '9007199254740993');
        assert.equal(fresh.get('w/c/job-two'), '7');
        assert.equal(fresh.get('other/c/job-one'), null);
        assert.equal(JSON.parse(raw!).length, 2);
        assert.doesNotMatch(raw!, /status|result|created_at|password|token|csrf/);
        for (let index = 0; index < 21; index++)
            store.set(`w/c/job-${index}`, String(index + 1));
        assert.equal(JSON.parse(raw!).length, 20);
        assert.equal(new JobCursorStore(storage).get('w/c/job-0'), null);
        assert.throws(() => store.set('w/c/job-invalid', '1e3'), /invalid or exceeded/);
        const unavailable = new JobCursorStore({ getItem: () => { throw new Error('Storage unavailable'); }, setItem: () => { throw new Error('Storage unavailable'); } });
        unavailable.set('w/c/job-memory', '11');
        assert.equal(unavailable.get('w/c/job-memory'), '11');
    });
});
describe("Authoritative job outcome and recovery", () => {
    const failed: RecoveryJob = { id: 'original-job', case_id: 'case-unit', kind: 'analytic_compute', status: 'failed', attempt: 3, result: null, error_code: 'WORKER_INTERRUPTED' };
    const receipt: JobRecoveryReceipt = { job_id: 'new-job', status: 'queued', retry_of: failed.id, attempt: 0 };
    const callback = async () => receipt;
    const panel = (job: RecoveryJob, role?: 'owner' | 'analyst' | 'viewer') => renderToStaticMarkup(<JobPanel job={job} role={role} pending={false} error={null} onRefresh={() => { }} onRetry={callback} onResume={callback} onCancel={async () => { }}/>);
    test("recovery actions require registered failed work or its exact missing-data checkpoint", () => {
        {
            for (const role of ['owner', 'analyst'] as const)
                assert.match(panel(failed, role), />Retry<\/button>/);
            for (const role of ['viewer', undefined] as const) {
                assert.doesNotMatch(panel(failed, role), />Retry<\/button>|>Resume<\/button>|Request cancellation/);
                assert.doesNotMatch(panel({ ...failed, status: 'running' }, role), /Request cancellation/);
            }
            assert.doesNotMatch(panel({ ...failed, kind: 'not_a_registered_handler' }, 'owner'), />Retry<\/button>/);
            assert.doesNotMatch(panel({ ...failed, status: 'succeeded' }, 'owner'), />Retry<\/button>/);
            assert.match(panel({ ...failed, attempt: undefined }, 'analyst'), /disabled=""[^>]*>Retry<\/button>/);
        }
        {
            const waiting = { ...failed, kind: 'followup_due', status: 'waiting_for_input', error_code: 'FOLLOWUP_DATA_REQUIRED' };
            assert.equal(jobRecoveryMode(waiting, 'analyst'), 'resume');
            assert.match(panel(waiting, 'analyst'), />Resume<\/button>/);
            for (const job of [{ ...waiting, error_code: 'HANDLER_UNAVAILABLE' }, { ...waiting, error_code: null }, { ...waiting, kind: 'analytic_compute' }]) {
                assert.equal(jobRecoveryMode(job, 'owner'), null);
                assert.doesNotMatch(panel(job, 'owner'), />Resume<\/button>/);
                assert.match(panel(job, 'owner'), /no available resume command/);
            }
        }
        {
            const job = { ...failed, kind: 'followup_due', status: 'succeeded', result: { id: 'followup-unit', state: 'compared' } };
            assert.deepEqual(recordedFollowupOutcome(job), { id: 'followup-unit', state: 'compared' });
            const html = renderToStaticMarkup(<FollowupJobOutcome job={job}/>);
            assert.match(html, /Recorded follow-up followup-unit: compared/);
            assert.match(html, /does not prove the overall cause/);
            assert.doesNotMatch(html, /PASS|passed/);
            for (const result of [null, { id: 'followup-unit', state: 'waiting_for_data' }, { state: 'compared' }]) {
                const unknown = { ...job, result };
                assert.equal(recordedFollowupOutcome(unknown), null);
                assert.match(renderToStaticMarkup(<FollowupJobOutcome job={unknown}/>), /result remains unknown/);
            }
        }
    });
    test('real UI transport reuses the command key after a lost response, sends job attempt and accepts only the linked new queued job', async () => {
        const originalFetch = globalThis.fetch, seen: {
            path: string;
            headers: Headers;
            body: string;
        }[] = [], identity: {
            current: CommandIdentity;
        } = { current: null };
        globalThis.fetch = async (input, options) => {
            seen.push({ path: String(input), headers: new Headers(options?.headers), body: String(options?.body) });
            if (seen.length === 1)
                throw new TypeError('Unit fixture simulates commit-then-lost-response');
            return new Response(JSON.stringify({ data: receipt, meta: { request_id: 'unit-request' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        try {
            const intent = { workspaceId: 'workspace-unit', caseId: 'case-unit', role: 'analyst' as const, csrf: 'unit-csrf', job: failed, mode: 'retry' as const, identity };
            await assert.rejects(recoverJob(intent), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
            const retainedKey = identity.current?.key;
            assert.ok(retainedKey);
            assert.deepEqual(await recoverJob(intent), receipt);
            assert.equal(identity.current, null);
            assert.equal(seen.length, 2);
            assert.equal(seen[0].headers.get('Idempotency-Key'), retainedKey);
            assert.equal(seen[1].headers.get('Idempotency-Key'), retainedKey);
            for (const call of seen) {
                assert.equal(call.path, '/api/v1/workspaces/workspace-unit/jobs/original-job/retry');
                assert.equal(call.headers.get('X-Faultline-Revision'), '3');
                assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf');
                assert.equal(call.body, '{}');
            }
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    test('resume submits an empty finite prerequisite list and stale-attempt errors remain errors with the uncertain identity retained', async () => {
        const originalFetch = globalThis.fetch, identity: {
            current: CommandIdentity;
        } = { current: null };
        let seen: {
            path: string;
            headers: Headers;
            body: string;
        } | undefined;
        globalThis.fetch = async (input, options) => { seen = { path: String(input), headers: new Headers(options?.headers), body: String(options?.body) }; return new Response(JSON.stringify({ error: { code: 'STALE_INPUTS', message: 'Job attempt changed.' }, meta: { request_id: 'unit-stale' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }); };
        try {
            await assert.rejects(recoverJob({ workspaceId: 'workspace-unit', caseId: 'case-unit', role: 'owner', csrf: 'unit-csrf', job: { ...failed, kind: 'followup_due', status: 'waiting_for_input', error_code: 'FOLLOWUP_DATA_REQUIRED' }, mode: 'resume', identity }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_INPUTS');
            assert.equal(seen?.path, '/api/v1/workspaces/workspace-unit/jobs/original-job/resume');
            assert.equal(seen?.headers.get('X-Faultline-Revision'), '3');
            assert.deepEqual(JSON.parse(seen!.body), { prerequisite_ids: [] });
            assert.ok(identity.current?.key);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    test('unknown roles, unsupported waiting handlers and cross-case jobs cannot issue a transport call; an unlinked response never means accepted', async () => {
        const originalFetch = globalThis.fetch, identity: {
            current: CommandIdentity;
        } = { current: null };
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: { ...receipt, retry_of: 'wrong-original' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
        try {
            const intent = { workspaceId: 'workspace-unit', caseId: 'case-unit', csrf: 'unit-csrf', job: failed, mode: 'retry' as const, identity };
            await assert.rejects(recoverJob({ ...intent, role: undefined }), /Refresh this run/);
            await assert.rejects(recoverJob({ ...intent, role: 'owner', job: { ...failed, case_id: 'other-case' } }), /Refresh this run/);
            await assert.rejects(recoverJob({ ...intent, role: 'owner', mode: 'resume', job: { ...failed, status: 'waiting_for_input', error_code: 'HANDLER_UNAVAILABLE' } }), /Refresh this run/);
            assert.equal(calls, 0);
            await assert.rejects(recoverJob({ ...intent, role: 'owner' }), /did not return a new queued run/);
            assert.equal(calls, 1);
            assert.ok(identity.current?.key);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    test("stale stream progress cannot replace authoritative outcomes or retained access", () => {
        {
            const stream: JobStreamView = { connection: { state: 'connected', cursor: '42' }, lastEvent: { id: '42', status: 'succeeded', created_at: '2026-10-12T10:00:00.123456Z' }, lastJobReadAt: '2026-10-12T10:00:01.000Z' };
            const html = renderToStaticMarkup(<JobPanel job={failed} role="analyst" stream={stream} pending={false} error={null} onRefresh={() => { }} onRetry={callback}/>);
            assert.match(html, /aria-label="Progress connection"/);
            assert.match(html, /data-event-cursor="42"/);
            assert.match(html, /Live updates: Connected/);
            assert.match(html, /The run failed/);
            assert.match(html, />Retry<\/button>/);
            assert.doesNotMatch(html, /Finished|status good|PASS/);
            assert.match(html, /Connection details/);
        }
        {
            const stream: JobStreamView = { connection: { state: 'reconnecting', cursor: '8', reason: '<script>untrusted transport data</script>' }, lastEvent: { id: '8', status: 'running', attempt: 1, created_at: '2026-10-12T10:00:00.123456Z' }, lastJobReadAt: null };
            const html = renderToStaticMarkup(<JobPanel job={{ ...failed, status: 'running' }} role="owner" stream={stream} authority="unknown" pending={false} error={null} onRefresh={() => { }} onCancel={async () => { }}/>);
            assert.match(html, /Disconnected; reconnecting/);
            assert.match(html, /Progress may be out of date/);
            assert.match(html, /displayed status is last known\s+and may be stale/);
            assert.match(html, /still checking the saved\s+run/);
            assert.doesNotMatch(html, /Request cancellation|>Retry<\/button>|>Resume<\/button>|<script>/);
            assert.match(html, /&lt;script&gt;/);
        }
        {
            const cached = { ...failed, id: 'private-cached-job', status: 'succeeded', result: { snapshot_id: 'private-snapshot-id' } };
            const stream: JobStreamView = { connection: { state: 'access_closed', cursor: '19' }, lastEvent: { id: '19', status: 'succeeded', created_at: '2026-10-12T10:00:00.123456Z' }, lastJobReadAt: '2026-10-12T10:00:01.000Z' };
            const html = renderToStaticMarkup(<JobPanel job={cached} role="owner" stream={stream} history={[failed]} pending={false} error={new Error('Current job access closed')} onRefresh={() => { }} onCancel={async () => { }} onRetry={callback} onResume={callback}/>);
            assert.match(html, /Live updates: Access closed/);
            assert.match(html, /Cleared when access closed/);
            assert.match(html, /outcome is unknown/);
            assert.doesNotMatch(html, /private-cached-job|private-snapshot-id|original-job|Original run history|Finished|Request cancellation|>Retry<\/button>|>Resume<\/button>/);
        }
    });
});
