import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, resource, casePath, type Investigation } from '../../api';
import { commandKey, type CommandIdentity } from '../../command-key';
import { addressDraft, changeAddressFormat, changeAddressText, confirmAddressFormat, mappingFromForm, parseAddress, sameMapping, type ImportMapping } from './mapping';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportMappingForm } from './ImportMappingForm';
import { ImportPanel, canDiscardImport, pinImportDiscardReview, submitImportDiscard } from './ImportPanel';
import { type ImportRecord } from './types';
import { uploadSource } from './upload';
describe("Finite import mappings", () => {
    function analyticsForm(): FormData { const form = new FormData(); for (const [name, value] of Object.entries({ event_id_path: 'Record UID', session_id_path: 'Visit UID', event_time_path: 'Event instant', event_name_path: 'Action name', device_path: 'Device class', exclusion_default: 'reviewed' }))
        form.set(name, value); form.append('device_source', 'Phone'); form.append('device_cohort', 'mobile'); form.append('device_source', 'Computer'); form.append('device_cohort', 'desktop'); return form; }
    test("analytics, support and release mappings preserve literal and nested fields without inferring times", () => {
        {
            const value = mappingFromForm('analytics', 'fields', analyticsForm());
            assert.deepEqual(value, { kind: 'analytics', event_id_path: 'Record UID', session_id_path: 'Visit UID', event_time_path: 'Event instant', event_name_path: 'Action name', device_path: 'Device class', device_map: [{ source_value: 'Phone', cohort: 'mobile' }, { source_value: 'Computer', cohort: 'desktop' }], precision_policy: 'lossless_utc_microseconds' });
            assert.ok(sameMapping({ ...value }, value));
            const unsafe = analyticsForm();
            unsafe.set('event_id_path', '__proto__');
            assert.throws(() => mappingFromForm('analytics', 'fields', unsafe), /safe exact names/);
            const ambiguous = analyticsForm();
            ambiguous.delete('device_source');
            ambiguous.append('device_source', 'Phone');
            ambiguous.append('device_source', 'Phone');
            assert.throws(() => mappingFromForm('analytics', 'fields', ambiguous), /only one group/);
            const unreviewed = analyticsForm();
            unreviewed.delete('exclusion_default');
            assert.throws(() => mappingFromForm('analytics', 'fields', unreviewed), /excluded=false default/);
        }
        {
            const support = new FormData();
            support.set('record_id_path', 'Ticket');
            support.set('text_path', 'Customer text');
            assert.deepEqual(mappingFromForm('support', 'fields', support), { kind: 'support', record_id_path: 'Ticket', text_path: 'Customer text' });
            const release = new FormData();
            release.set('record_id_path', 'Release UID');
            release.set('description_path', 'Notes');
            release.set('published_at_path', 'Published');
            assert.deepEqual(mappingFromForm('release', 'fields', release), { kind: 'release', record_id_path: 'Release UID', description_path: 'Notes', published_at_path: 'Published' });
            for (const record_type of ['analytics', 'support', 'release'] as const)
                assert.deepEqual(mappingFromForm(record_type, 'canonical', new FormData()), { kind: 'canonical', record_type, schema_version: 1 });
        }
        {
            assert.equal(parseAddress('properties.basket', 'literal'), 'properties.basket');
            assert.equal(parseAddress('[field.name]', 'literal'), '[field.name]');
            assert.equal(parseAddress('["properties","basket"]', 'literal'), '["properties","basket"]');
            const form = analyticsForm();
            for (const [field, parts] of Object.entries({ event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], release_id_path: ['properties', 'release'] })) {
                form.set(field, JSON.stringify(parts));
                form.set(`${field}_format`, 'array');
            }
            const mapping = mappingFromForm('analytics', 'fields', form);
            assert.deepEqual(mapping, { kind: 'analytics', event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], release_id_path: ['properties', 'release'], device_map: [{ source_value: 'Phone', cohort: 'mobile' }, { source_value: 'Computer', cohort: 'desktop' }], precision_policy: 'lossless_utc_microseconds' });
        }
        {
            const support = new FormData();
            support.set('record_id_path', '["ticket","id"]');
            support.set('record_id_path_format', 'array');
            support.set('text_path', '["ticket","message"]');
            support.set('text_path_format', 'array');
            assert.deepEqual(mappingFromForm('support', 'fields', support), { kind: 'support', record_id_path: ['ticket', 'id'], text_path: ['ticket', 'message'] });
            const release = new FormData();
            release.set('record_id_path', '["release","id"]');
            release.set('record_id_path_format', 'array');
            release.set('description_path', '["release","notes"]');
            release.set('description_path_format', 'array');
            release.set('published_at_path', '["release","published"]');
            release.set('published_at_path_format', 'array');
            release.set('commit_path', '["release","reported_ref"]');
            release.set('commit_path_format', 'array');
            assert.deepEqual(mappingFromForm('release', 'fields', release), { kind: 'release', record_id_path: ['release', 'id'], description_path: ['release', 'notes'], published_at_path: ['release', 'published'], commit_path: ['release', 'reported_ref'] });
            release.set('commit_path', '["release","constructor"]');
            assert.throws(() => mappingFromForm('release', 'fields', release), /commit_path:.*safe string components/);
        }
    });
    test('finite arrays reject unsafe, empty, non-string, expression and excessive addresses before any write', () => {
        for (const value of ['[]', '[""]', '[" "]', '["properties","__proto__"]', '["constructor"]', '["prototype"]', '["a",0]', '{"a":"b"}', 'properties.basket', '$.properties.basket', '["a",["b"]]', JSON.stringify(Array(9).fill('a')), JSON.stringify(['x'.repeat(129)])])
            assert.throws(() => parseAddress(value, 'array'), /JSON array|finite JSON path/);
        assert.deepEqual(parseAddress(JSON.stringify(Array(8).fill('a'.repeat(128))), 'array'), Array(8).fill('a'.repeat(128)));
        const escaped = Array(8).fill('\u0000'.repeat(128)), escapedText = JSON.stringify(escaped);
        assert.ok(escapedText.length > 1200);
        assert.deepEqual(parseAddress(escapedText, 'array'), escaped);
        const form = analyticsForm();
        form.set('excluded_path', '["properties","prototype"]');
        form.set('excluded_path_format', 'array');
        assert.throws(() => mappingFromForm('analytics', 'fields', form), /excluded_path:.*safe string components/);
    });
    test('saved arrays round trip exactly and switching format retains unsaved text with unresolved review', () => {
        const saved = ['properties', 'drop'] as const, initial = addressDraft(saved);
        assert.deepEqual(parseAddress(initial.text, initial.format), saved);
        const switched = changeAddressFormat(initial, 'literal');
        assert.equal(switched.text, initial.text);
        assert.equal(switched.needsReview, true);
        const form = analyticsForm();
        form.set('excluded_path', switched.text);
        form.set('excluded_path_format', switched.format);
        form.set('excluded_path_format_reviewed', 'pending');
        assert.throws(() => mappingFromForm('analytics', 'fields', form), /Address format changed/);
        const deliberateLiteral = confirmAddressFormat(switched);
        assert.equal(deliberateLiteral.needsReview, false);
        assert.equal(parseAddress(deliberateLiteral.text, deliberateLiteral.format), '["properties","drop"]');
        const unsaved = changeAddressText(addressDraft('Initial header'), 'My.unsaved[header]'), array = changeAddressFormat(unsaved, 'array');
        assert.equal(array.text, 'My.unsaved[header]');
        assert.throws(() => confirmAddressFormat(array), /JSON array/);
        assert.equal(changeAddressFormat(array, 'literal').text, unsaved.text);
        const edited = changeAddressText(array, '["payload","My.unsaved[header]"]');
        assert.equal(edited.needsReview, false);
        assert.deepEqual(parseAddress(edited.text, edited.format), ['payload', 'My.unsaved[header]']);
    });
    test('finite mapping transport retains the reviewed revision and command identity across a manually retried lost response', async () => {
        const original = globalThis.fetch, reference: {
            current: CommandIdentity;
        } = { current: null }, observed: RequestInit[] = [], path = '/api/v1/workspaces/unit/cases/unit/imports/unit/mappings';
        globalThis.fetch = async (_input, options) => { observed.push(options!); if (observed.length === 1)
            throw new TypeError('Unit fixture lost mapping reply after commit.'); return Response.json({ data: { id: 'recorded-map' }, meta: { request_id: 'unit-wire' } }); };
        const submit = () => { const body = mappingFromForm('analytics', 'fields', analyticsForm()); return resource(path, { method: 'POST', csrf: 'unit-session', revision: 7, body, idempotencyKey: commandKey(reference, { path, method: 'POST', revision: 7, body }) }); };
        try {
            await assert.rejects(submit(), (cause: unknown) => cause instanceof ApiError && cause.status === 0);
            assert.equal(observed.length, 1);
            await submit();
            const first = observed[0].headers as Record<string, string>, second = observed[1].headers as Record<string, string>;
            assert.equal(first['X-Faultline-Revision'], '7');
            assert.equal(first['X-CSRF-Token'], 'unit-session');
            assert.equal(first['Idempotency-Key'], second['Idempotency-Key']);
            assert.equal(JSON.parse(String(observed[1].body)).precision_policy, 'lossless_utc_microseconds');
        }
        finally {
            globalThis.fetch = original;
        }
    });
});
describe("Saved mapping recovery", () => {
    test('reopening an actual saved analytics array mapping renders exclusion review without string-method crash', () => {
        const savedValue: ImportMapping = { kind: 'analytics', event_id_path: ['properties', 'uid'], session_id_path: ['properties', 'basket'], event_time_path: ['timestamp'], event_name_path: ['event'], device_path: ['properties', 'device'], excluded_path: ['properties', 'drop'], device_map: [{ source_value: 'Phone', cohort: 'mobile' }], precision_policy: 'lossless_utc_microseconds' };
        const html = renderToStaticMarkup(<ImportMappingForm kind="analytics" savedValue={savedValue} savedId="unit-recorded-mapping" revision={9} pending={false} immutable={false} onDirty={() => { }} onApply={async () => true} onRefreshRevision={async () => { }}/>);
        assert.match(html, /name="excluded_path"[^>]*value="\[&quot;properties&quot;,&quot;drop&quot;\]"/);
        assert.match(html, /name="excluded_path_format"[^>]*>[\s\S]*?<option value="array" selected="">Finite JSON path array<\/option>/);
        assert.doesNotMatch(html, /name="exclusion_default"/);
        assert.match(html, /six fractional digits in UTC/);
    });
});
describe("Import discard review", () => {
    const investigation: Investigation = { id: 'case', workspace_id: 'workspace', title: 'Synthetic', question: 'Review', affected_flow: 'checkout', active_revision_id: 'revision', lifecycle: 'open', archived: false, revision: 7, created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:00Z' };
    const base = casePath('workspace', 'case'), record: ImportRecord = { id: 'staged-import', source_id: 'source', record_kind: 'analytics', stage: 'blocked' };
    test("discard eligibility follows staged state, parent scope and the available review action", () => {
        {
            for (const stage of ['staged', 'mapped', 'review_ready', 'blocked'])
                assert.equal(canDiscardImport({ ...record, stage }), true);
            for (const changed of [{ stage: 'accepted' }, { stage: 'queued' }, { stage: 'discarded' }, { snapshot_id: 'snapshot' }, { job_id: 'job' }])
                assert.equal(canDiscardImport({ ...record, ...changed }), false);
            assert.throws(() => pinImportDiscardReview(casePath('other', 'case'), record, investigation));
            assert.throws(() => pinImportDiscardReview(base, record, { ...investigation, lifecycle: 'closed' }));
            assert.throws(() => pinImportDiscardReview(base, record, { ...investigation, archived: true }));
        }
        {
            const props = { base, csrf: '', snapshots: [], savedMappingId: '', onImport: () => { }, onJob: () => { } };
            assert.doesNotMatch(renderToStaticMarkup(<ImportPanel {...props} current={{ ...record, stage: 'accepted', snapshot_id: 'snapshot' }} onDiscard={() => { }}/>), /Review discard/);
            assert.doesNotMatch(renderToStaticMarkup(<ImportPanel {...props} current={record}/>), /Review discard/);
            assert.match(renderToStaticMarkup(<ImportPanel {...props} current={record} onDiscard={() => { }}/>), /Review discard/);
        }
    });
    test('discard issues no request without acknowledgment or after staged state changes', async () => {
        const review = pinImportDiscardReview(base, record, investigation), original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };
        try {
            await assert.rejects(submitImportDiscard(review, record, 'csrf', false, { current: null }), /Review the exact/);
            await assert.rejects(submitImportDiscard(review, { ...record, job_id: 'queued-job' }, 'csrf', true, { current: null }), error => error instanceof ApiError && error.status === 409);
            assert.equal(calls, 0);
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('actual empty discard response uses exact reviewed parent revision and failed stale response retains command identity', async () => {
        const review = pinImportDiscardReview(base, record, investigation), original = globalThis.fetch, identity: {
            current: CommandIdentity;
        } = { current: null };
        let calls = 0;
        globalThis.fetch = async (url, options) => {
            calls++;
            assert.equal(url, base + '/imports/staged-import');
            assert.equal(options?.method, 'DELETE');
            assert.equal(options?.body, undefined);
            const headers = new Headers(options?.headers);
            assert.equal(headers.get('X-Faultline-Revision'), calls === 1 ? '7' : '8');
            assert.equal(headers.get('X-CSRF-Token'), 'csrf');
            assert.ok(headers.get('Idempotency-Key'));
            return calls === 1 ? new Response(JSON.stringify({ error: { code: 'STALE_INPUTS', message: 'Parent case changed.' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }) : new Response(null, { status: 204 });
        };
        try {
            await assert.rejects(submitImportDiscard(review, record, 'csrf', true, identity), error => error instanceof ApiError && error.status === 409);
            assert.ok(identity.current);
            const fresh = pinImportDiscardReview(base, record, { ...investigation, revision: 8 });
            await submitImportDiscard(fresh, record, 'csrf', true, identity);
            assert.equal(identity.current, null);
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('a staged or newly mapped import has no preview yet; actual blocked preview retains its issues and cannot be saved', () => {
        const props = { base, csrf: '', snapshots: [], savedMappingId: '', onImport: () => { }, onJob: () => { } };
        for (const stage of ['staged', 'mapped']) {
            const html = renderToStaticMarkup(<ImportPanel {...props} current={{ ...record, stage, can_finalize: false }}/>);
            assert.match(html, /Preview not run/);
            assert.doesNotMatch(html, /Preview is blocked|Resolve the recorded invalid fields|Save snapshot/);
        }
        const html = renderToStaticMarkup(<ImportPanel {...props} current={{ ...record, stage: 'blocked', can_finalize: false, counts: { input: 2, rejected: 1 }, issues: [{ code: 'CONFLICTING_EVENT_ID', message: 'Conflicting event identity.' }] }}/>);
        assert.match(html, /Preview is blocked/);
        assert.match(html, /CONFLICTING_EVENT_ID/);
        assert.match(html, /Conflicting event identity/);
        assert.match(html, /Resolve the recorded invalid fields/);
        assert.doesNotMatch(html, /Save snapshot/);
    });
});
describe("Source upload", () => {
    const base = '/api/v1/workspaces/w/cases/c', file = new File(['synthetic'], 'data.jsonl'), args = { base, file, kind: 'analytics' as const, sourceId: 'source-1', contentHash: 'a'.repeat(64), csrf: 'synthetic-csrf', idempotencyKey: 'synthetic-command' };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    test('multipart host retains normal file import and source identity', async () => {
        const original = globalThis.fetch;
        const calls: {
            url: string;
            init?: RequestInit;
        }[] = [];
        globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return calls.length === 1 ? reply({ mode: 'multipart', max_bytes: 52428800 }) : reply({ id: 'import-1' }); };
        try {
            assert.equal((await uploadSource(args)).id, 'import-1');
            assert.equal(calls[1]!.url, base + '/imports');
            const body = calls[1]!.init!.body as FormData;
            assert.equal(body.get('source_id'), 'source-1');
            assert.equal(body.get('kind'), 'analytics');
            assert.equal((body.get('file') as File).name, 'data.jsonl');
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test("direct upload validates its destination and excludes application authority from storage requests", async () => {
        {
            const original = globalThis.fetch;
            const calls: {
                url: string;
                init?: RequestInit;
            }[] = [];
            globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); switch (calls.length) {
                case 1: return reply({ mode: 'direct', max_bytes: 52428800 });
                case 2: return reply({ upload_url: 'https://synthetic.supabase.co/storage/v1/object/upload/sign/private/staging/w/id?token=synthetic', token: 'signed-receipt', method: 'PUT' });
                case 3: return new Response('', { status: 409 });
                default: return reply({ id: 'verified-import' });
            } };
            try {
                assert.equal((await uploadSource(args)).id, 'verified-import');
                assert.equal(calls[2]!.init!.credentials, 'omit');
                assert.equal(new Headers(calls[2]!.init!.headers).get('x-csrf-token'), null);
                assert.equal(new Headers(calls[2]!.init!.headers).get('authorization'), null);
                assert.equal(calls[3]!.url, base + '/uploads/accept');
                assert.deepEqual(JSON.parse(String(calls[3]!.init!.body)), { token: 'signed-receipt' });
            }
            finally {
                globalThis.fetch = original;
            }
        }
        {
            const original = globalThis.fetch;
            let calls = 0;
            globalThis.fetch = async () => ++calls === 1 ? reply({ mode: 'direct', max_bytes: 52428800 }) : reply({ upload_url: 'https://foreign.invalid/storage/v1/object/upload/sign/x', token: 'x', method: 'PUT' });
            try {
                await assert.rejects(() => uploadSource(args));
                assert.equal(calls, 2);
            }
            finally {
                globalThis.fetch = original;
            }
        }
    });
    test('completed upload retry returns its existing import without retransferring bytes', async () => {
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async () => ++calls === 1 ? reply({ mode: 'direct', max_bytes: 52428800 }) : reply({ completed_import: { id: 'original-import' } });
        try {
            assert.equal((await uploadSource(args)).id, 'original-import');
            assert.equal(calls, 2);
        }
        finally {
            globalThis.fetch = original;
        }
    });
});
