import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricContractDiff, metricContractDiff } from './MetricContractDiff';
import { type Metric, type MetricRecord, type Snapshot, type Coverage } from './types';
import { ApiError, casePath, type Investigation, type Role } from '../../api';
import { type CommandIdentity } from '../../command-key';
import { MetricPanel, metricFromFormData, MetricFreezeReviewSummary, pinMetricFreezeReview, metricFreezeReviewCurrent, submitMetricFreezeReview, type MetricFreezeFacts } from './MetricPanel';
import { type SelectionInvestigation, SnapshotSelection, SnapshotSelectionSummary, createSnapshotSelectionCommand, isSnapshotSelection, readSnapshotQuality, type SelectableSnapshot, type SnapshotSelectionReceipt } from './SnapshotSelection';
describe("Metric change review", () => {
    const value: Metric = { version: 1, template: 'session_conversion_v1', source_id: 'source-before', unit: 'session', entry_event: 'entered', success_event: 'converted', horizon_seconds: 1800, segment_property: 'device', cohorts: ['mobile', 'desktop'], windows: { baseline: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' }, comparison: { start: '2026-09-02T00:00:00Z', end: '2026-09-03T00:00:00Z' } }, exclusion_rule: 'entry_excluded_false', timezone: 'UTC' };
    const record: MetricRecord = { id: 'prior-metric', state: 'frozen', value, metric_hash: 'a'.repeat(64), revision_id: 'prior-revision', snapshot_id: 'prior-snapshot' };
    const snapshot: Snapshot = { id: 'prior-snapshot', source_id: 'source-before', content_hash: 'b'.repeat(64), coverage: { extraction_status: 'complete', basis: 'operator_attestation', covered_start: '2026-09-01T00:00:00Z', covered_end: '2026-09-03T00:30:00Z', event_watermark: '2026-09-03T00:30:00Z', attestation: 'Authored complete interval.', event_time_intervals: [{ start: '2026-09-01T00:00:00Z', end: '2026-09-03T00:30:00Z' }] } };
    test('changed windows, source and attribution horizon are independently visible', () => {
        // The comparator can expose a changed historical field; the editor/server still enforce locked V1 horizon.
        const proposed = { ...value, source_id: 'source-after', horizon_seconds: 900, windows: { ...value.windows, comparison: { ...value.windows.comparison, end: '2026-09-04T00:00:00Z' } } } as unknown as Metric;
        const rows = metricContractDiff(record, proposed, snapshot, { ...snapshot, id: 'proposed-snapshot', source_id: 'source-after', content_hash: 'c'.repeat(64) });
        for (const field of ['Logical analytics source', 'Later period end — excluded', 'Conversion time window', 'Snapshot identity', 'Snapshot source', 'Snapshot content hash'])
            assert.equal(rows.find(row => row.field === field)?.status, 'Changed', field);
        assert.equal(rows.find(row => row.field === 'Entry event')?.status, 'Unchanged');
        assert.equal(rows.find(row => row.field === 'Conversion time window')?.proposed, '900 seconds');
    });
    test('new investigation and unavailable earlier snapshot preserve unknown states and authored text is escaped', () => {
        const proposed = { ...value, entry_event: '<script>entered</script>' };
        const html = renderToStaticMarkup(<MetricContractDiff previous={null} proposed={proposed} previousSnapshot={null} proposedSnapshot={snapshot}/>);
        assert.match(html, /No prior frozen metric is recorded/);
        assert.match(html, /Unknown/);
        assert.match(html, /&lt;script&gt;/);
        assert.doesNotMatch(html, /<script>/);
        const unknown = metricContractDiff(record, value, null, snapshot);
        assert.equal(unknown.find(row => row.field === 'Snapshot content hash')?.status, 'Unknown');
        assert.equal(unknown.find(row => row.field === 'Completeness and observation tail')?.status, 'Unknown');
        assert.equal(unknown.find(row => row.field === 'Snapshot identity')?.status, 'Unchanged');
    });
});
describe("Frozen metric review", () => {
    const investigation: SelectionInvestigation = { id: 'case-review', workspace_id: 'workspace-review', title: 'Unchanged metric draft', question: 'Does renewed consent bind the actual revision?', affected_flow: 'checkout', active_revision_id: 'revision-before', lifecycle: 'open', archived: false, revision: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', snapshot_selection: { revision_id: 'revision-before', snapshot_bundle_hash: 'b'.repeat(64), selected_snapshots: [{ id: 'snapshot-review', source_id: 'source-review', content_hash: 's'.repeat(64).replaceAll('s', 'c') }], selection_reason: 'Retain the explicit source.' } };
    const metric: MetricRecord = { id: 'metric-review', state: 'draft', metric_hash: 'a'.repeat(64), value: { version: 1, template: 'session_conversion_v1', source_id: 'source-review', unit: 'session', entry_event: 'checkout_started', success_event: 'checkout_completed', horizon_seconds: 1800, segment_property: 'device', cohorts: ['desktop'], windows: { baseline: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' }, comparison: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' } }, exclusion_rule: 'entry_excluded_false', timezone: 'UTC' } };
    const snapshot: Snapshot = { id: 'snapshot-review', source_id: 'source-review', record_kind: 'analytics', content_hash: 'c'.repeat(64), record_count: 4, coverage: { extraction_status: 'complete', basis: 'lateness_assumption', covered_start: '2026-10-01T00:00:00.000Z', covered_end: '2026-10-04T00:30:00.000Z', event_watermark: '2026-10-04T00:30:00.000Z', attestation: '', event_time_intervals: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-04T00:30:00.000Z' }], assumptions: ['Explicit source lateness assumption.'] } };
    const facts = (): MetricFreezeFacts => ({ base: casePath(investigation.workspace_id, investigation.id), investigation: structuredClone(investigation), metric: structuredClone(metric), snapshot: structuredClone(snapshot), canMutate: true, metadataAvailable: true });
    const accepted = { id: metric.id, state: 'frozen', revision_id: 'server-new-revision', metric_hash: metric.metric_hash, snapshot_id: snapshot.id };
    const respond = (value: unknown) => new Response(JSON.stringify({ data: value }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    test("metric review is invalidated by changed revision, hashes, access or completeness assumptions", async () => {
        {
            const current = facts(), pinned = pinMetricFreezeReview(current), originalFetch = globalThis.fetch;
            let requests = 0;
            globalThis.fetch = async () => { requests++; return respond(accepted); };
            try {
                const changed = [
                    { ...facts(), investigation: { ...investigation, revision: 4 } },
                    { ...facts(), investigation: { ...investigation, active_revision_id: 'revision-after', snapshot_selection: { ...investigation.snapshot_selection!, revision_id: 'revision-after' } } },
                    { ...facts(), investigation: { ...investigation, snapshot_selection: { ...investigation.snapshot_selection!, snapshot_bundle_hash: 'd'.repeat(64) } } }
                ];
                for (const refreshed of changed) {
                    assert.equal(refreshed.metric!.id, pinned.metric_id);
                    assert.equal(refreshed.snapshot!.id, pinned.snapshot_id);
                    assert.equal(metricFreezeReviewCurrent(pinned, refreshed), false);
                    await assert.rejects(submitMetricFreezeReview(pinned, refreshed, 'unit-csrf', true, { current: null }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_METRIC_REVIEW');
                }
                assert.equal(requests, 0);
                assert.equal(pinned.case_revision, 3);
                assert.equal(pinned.active_revision_id, 'revision-before');
                assert.equal(pinned.snapshot_bundle_hash, 'b'.repeat(64));
                const html = renderToStaticMarkup(<MetricFreezeReviewSummary review={pinned} onRefresh={async () => { }}/>);
                assert.match(html, /Reviewed case revision<\/dt><dd>3/);
                assert.match(html, /revision-before/);
                assert.ok(html.includes('b'.repeat(64)));
                assert.doesNotMatch(html, /revision-after|>PASS</);
                assert.match(html, /type="button"[^>]*>Refresh recorded inputs/);
                const reading = renderToStaticMarkup(<MetricFreezeReviewSummary review={pinned} onRefresh={async () => { }} pending/>);
                assert.match(reading, /disabled=""[^>]*>Refresh recorded inputs/);
                assert.match(reading, /Reviewed case revision<\/dt><dd>3/);
                assert.ok(reading.includes('b'.repeat(64)), 'Refreshing cannot silently replace the displayed reviewed binding.');
            }
            finally {
                globalThis.fetch = originalFetch;
            }
        }
        {
            const current = facts(), pinned = pinMetricFreezeReview(current);
            const changed: MetricFreezeFacts[] = [{ ...facts(), canMutate: false }, { ...facts(), metadataAvailable: false }, { ...facts(), investigation: { ...investigation, archived: true } }, { ...facts(), investigation: { ...investigation, lifecycle: 'closed' } }, { ...facts(), metric: { ...metric, metric_hash: 'd'.repeat(64) } }, { ...facts(), snapshot: { ...snapshot, content_hash: 'e'.repeat(64) } }, { ...facts(), investigation: { ...investigation, snapshot_selection: undefined } }, { ...facts(), snapshot: { ...snapshot, coverage: { ...snapshot.coverage!, assumptions: ['A different source completeness assumption.'] } } }];
            for (const refreshed of changed)
                assert.equal(metricFreezeReviewCurrent(pinned, refreshed), false);
            current.snapshot!.coverage!.assumptions!.push('A later UI metadata replacement.');
            assert.deepEqual(pinned.acknowledged_assumptions, ['Explicit source lateness assumption.']);
            assert.deepEqual(pinned.coverage!.assumptions, ['Explicit source lateness assumption.']);
            assert.equal(metricFreezeReviewCurrent(pinned, current), false);
            const noBundle = { ...facts(), investigation: { ...investigation, snapshot_selection: null } };
            assert.equal(pinMetricFreezeReview(noBundle).snapshot_bundle_hash, null, 'Explicit authoritative no-bundle flow remains supported.');
        }
    });
    test('the freeze transport always uses pinned X-Faultline-Revision/body; stale API responses clear no identity and a fresh review requires a new explicit acknowledgment', async () => {
        const originalFetch = globalThis.fetch, current = facts(), pinned = pinMetricFreezeReview(current), identity: {
            current: CommandIdentity;
        } = { current: null }, seen: {
            path: string;
            headers: Headers;
            body: unknown;
        }[] = [];
        globalThis.fetch = async (input, options) => { seen.push({ path: String(input), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body)) }); return new Response(JSON.stringify({ error: { code: 'STALE_INPUTS', message: 'Case resource revision changed.' } }), { status: 409 }); };
        try {
            for (let n = 0; n < 2; n++)
                await assert.rejects(submitMetricFreezeReview(pinned, current, 'unit-csrf', true, identity), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_INPUTS');
            const oldKey = identity.current?.key;
            assert.ok(oldKey);
            for (const call of seen) {
                assert.equal(call.path, current.base + '/metrics/metric-review/freeze');
                assert.equal(call.headers.get('X-Faultline-Revision'), '3');
                assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf');
                assert.equal(call.headers.get('Idempotency-Key'), oldKey);
                assert.deepEqual(call.body, { snapshot_id: 'snapshot-review', metric_hash: 'a'.repeat(64), acknowledged_assumptions: ['Explicit source lateness assumption.'] });
            }
            const freshFacts = { ...facts(), investigation: { ...investigation, revision: 4, active_revision_id: 'reviewed-revision-four', snapshot_selection: { ...investigation.snapshot_selection!, revision_id: 'reviewed-revision-four', snapshot_bundle_hash: 'd'.repeat(64) } } }, renewed = pinMetricFreezeReview(freshFacts);
            await assert.rejects(submitMetricFreezeReview(renewed, freshFacts, 'unit-csrf', false, identity), /Review and acknowledge/);
            assert.equal(seen.length, 2);
            globalThis.fetch = async (input, options) => { seen.push({ path: String(input), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body)) }); return respond(accepted); };
            assert.deepEqual(await submitMetricFreezeReview(renewed, freshFacts, 'unit-csrf', true, identity), accepted);
            assert.equal(seen[2].headers.get('X-Faultline-Revision'), '4');
            assert.notEqual(seen[2].headers.get('Idempotency-Key'), oldKey);
            assert.equal(identity.current, null);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    test('unrelated display updates preserve the reviewed binding and viewer presentation keeps read-only metric semantics', () => {
        const current = facts(), pinned = pinMetricFreezeReview(current), displayUpdate = { ...facts(), investigation: { ...investigation, title: 'A display title', updated_at: '2026-10-12T23:30:00.000Z' } };
        assert.equal(metricFreezeReviewCurrent(pinned, displayUpdate), true);
        assert.deepEqual(pinned.metric, metric.value);
        const html = renderToStaticMarkup(<MetricPanel base={current.base} csrf="" investigation={investigation} snapshots={[snapshot]} metrics={[metric]} selectedMetricId={metric.id} selectedSnapshotId={snapshot.id} canMutate={false} onMetric={() => { }} onSnapshot={() => { }} onFrozen={async () => { }} onCompare={async () => { }}/>);
        assert.doesNotMatch(html, /Review &amp; freeze metric|Freeze reviewed inputs|Save metric draft|Compute frozen comparison/);
        assert.match(html, /checkout_started/);
        assert.match(html, /checkout_completed/);
        assert.match(html, /2026-10-01T00:00:00.000Z/);
        assert.match(html, /2026-10-04T00:00:00.000Z/);
        assert.match(html, /lateness assumption/);
    });
    function displayedMetricForm(): FormData {
        const form = new FormData();
        for (const [name, value] of Object.entries({ source_id: 'captured-source', cohorts: 'mobile, desktop', entry_event: 'checkout_started', success_event: 'checkout_completed', baseline_start: '2026-09-01T00:00', baseline_end: '2026-09-02T00:00', comparison_start: '2026-09-02T00:00', comparison_end: '2026-09-03T00:00' }))
            form.set(name, value);
        return form;
    }
    test("displayed metric boundaries serialize exactly and reject missing, invalid or reversed dates", () => {
        {
            const submitted = metricFromFormData(displayedMetricForm());
            assert.deepEqual(submitted.windows, { baseline: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' }, comparison: { start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z' } });
            assert.notDeepEqual(submitted.windows, metric.value.windows, 'Existing October metric state must not replace the displayed September dates.');
            assert.equal(submitted.source_id, 'captured-source');
            assert.deepEqual(submitted.cohorts, ['mobile', 'desktop']);
            assert.equal(submitted.entry_event, 'checkout_started');
            assert.equal(submitted.success_event, 'checkout_completed');
            assert.equal(submitted.horizon_seconds, 1800);
            assert.equal(submitted.timezone, 'UTC');
            const html = renderToStaticMarkup(<MetricPanel base={facts().base} csrf="" investigation={investigation} snapshots={[snapshot]} metrics={[]} selectedMetricId="" selectedSnapshotId="" canMutate onMetric={() => { }} onSnapshot={() => { }} onFrozen={async () => { }} onCompare={async () => { }}/>);
            for (const name of ['source_id', 'cohorts', 'entry_event', 'success_event', 'baseline_start', 'baseline_end', 'comparison_start', 'comparison_end'])
                assert.match(html, new RegExp(`name="${name}"`));
        }
        {
            for (const name of ['baseline_start', 'baseline_end', 'comparison_start', 'comparison_end']) {
                const missing = displayedMetricForm();
                missing.delete(name);
                assert.throws(() => metricFromFormData(missing), /Missing metric field/);
                for (const value of ['', '2026-13-01T00:00', '2026-09-01T00:00Z', 'not-a-date']) {
                    const invalid = displayedMetricForm();
                    invalid.set(name, value);
                    assert.throws(() => metricFromFormData(invalid), /valid UTC date|UTC date or time is invalid/);
                }
            }
            const reversed = displayedMetricForm();
            reversed.set('baseline_end', '2026-08-31T00:00');
            assert.throws(() => metricFromFormData(reversed), /end must follow/);
            const equal = displayedMetricForm();
            equal.set('comparison_end', '2026-09-02T00:00');
            assert.throws(() => metricFromFormData(equal), /end must follow/);
            const absentSource = displayedMetricForm();
            absentSource.delete('source_id');
            assert.throws(() => metricFromFormData(absentSource), /Missing metric field/);
            const duplicateCohorts = displayedMetricForm();
            duplicateCohorts.set('cohorts', 'mobile, mobile');
            assert.throws(() => metricFromFormData(duplicateCohorts), /unique device groups/);
        }
    });
});
describe("Snapshot selection", () => {
    const item: Investigation = { id: 'case-unit', workspace_id: 'workspace-unit', title: 'Independently authored review', question: 'Which immutable inputs?', affected_flow: 'checkout', active_revision_id: 'revision-before', lifecycle: 'open', archived: false, revision: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
    const a: SelectableSnapshot = { id: 'snapshot-a', source_id: 'source-a', record_kind: 'analytics', content_hash: 'a'.repeat(64), record_count: 4 };
    const b: SelectableSnapshot = { id: 'snapshot-b', source_id: 'source-b', record_kind: 'support', content_hash: 'b'.repeat(64), record_count: 1 };
    const receipt: SnapshotSelectionReceipt = { revision_id: 'server-revision-after', parent_id: item.active_revision_id, revision: 4, selected_snapshots: [{ id: a.id, source_id: a.source_id, content_hash: a.content_hash! }, { id: b.id, source_id: b.source_id, content_hash: b.content_hash! }], snapshot_bundle_hash: 'c'.repeat(64), selection_reason: 'Review both independent source captures.', metric_status: 'requires_freeze' };
    const intent = () => ({ base: casePath(item.workspace_id, item.id), csrf: 'unit-csrf', role: 'analyst' as Role, canMutate: true, metadataAvailable: true, investigation: item, snapshots: [a, b], snapshotIds: [b.id, a.id], reason: receipt.selection_reason, reviewed: true });
    const response = (value: unknown) => new Response(JSON.stringify({ data: value }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    test('viewer and unknown-role metadata have no selection form; analyst review requires a reason and explicit acknowledgement', () => {
        const props = { base: intent().base, csrf: 'unit-csrf', investigation: { ...item, snapshot_selection: receipt }, snapshots: [a, { ...b, withdrawn: true }], canMutate: true, metadataAvailable: true, onSaved: () => { throw new Error('Static rendering must not submit.'); } };
        for (const role of ['viewer', undefined] as const) {
            const html = renderToStaticMarkup(<SnapshotSelection {...props} role={role}/>);
            assert.doesNotMatch(html, /<form|type="checkbox"|Save selected data|Reason for this selection/);
            assert.match(html, /Snapshot snapshot-a/);
            assert.match(html, /Withdrawn, expired/);
            assert.match(html, /Check coverage/);
        }
        const html = renderToStaticMarkup(<SnapshotSelection {...props} investigation={{ ...item, snapshot_selection: null }} role="analyst"/>);
        assert.match(html, /No data selected yet/);
        assert.match(html, /Reason for this selection/);
        assert.match(html, /<textarea[^>]*required=""[^>]*maxLength="2000"/);
        assert.match(html, /I reviewed this data/);
        assert.match(html, /disabled=""[^>]*>Save selected data/);
        assert.match(html, /<details open=""><summary>Select data<\/summary>/);
        assert.doesNotMatch(html, /status good|PASS/);
    });
    test('finite reviewed identities, current role/revision and retained hashes are required before any mutation', async () => {
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async () => { calls++; return response(receipt); };
        try {
            const invalid = [
                { ...intent(), role: 'viewer' as Role }, { ...intent(), role: undefined }, { ...intent(), canMutate: false }, { ...intent(), metadataAvailable: false },
                { ...intent(), investigation: { ...item, lifecycle: 'closed' } }, { ...intent(), investigation: { ...item, revision: NaN } },
                { ...intent(), base: casePath(item.workspace_id, 'other-case') }, { ...intent(), reviewed: false }, { ...intent(), reason: '   ' }, { ...intent(), reason: 'x'.repeat(2001) },
                { ...intent(), snapshotIds: [a.id, a.id] }, { ...intent(), snapshotIds: Array.from({ length: 101 }, (_, n) => `snapshot-${n}`) },
                { ...intent(), snapshots: [a, { ...b, withdrawn: true }] }, { ...intent(), snapshots: [a, { ...b, retention_expired: true }] },
                { ...intent(), snapshots: [a, { ...b, content_hash: undefined }] }, { ...intent(), snapshots: [a, a, b] }, { ...intent(), snapshotIds: ['not-in-current-metadata'] }
            ];
            for (const input of invalid)
                await assert.rejects(createSnapshotSelectionCommand().submit(input));
            assert.equal(calls, 0);
            globalThis.fetch = async (_path, options) => { calls++; assert.deepEqual(JSON.parse(String(options?.body)), { snapshot_ids: [], reason: 'Explicitly clear this saved bundle.' }); return response({ ...receipt, selected_snapshots: [], selection_reason: 'Explicitly clear this saved bundle.' }); };
            const cleared = await createSnapshotSelectionCommand().submit({ ...intent(), snapshotIds: [], reason: 'Explicitly clear this saved bundle.' });
            assert.equal(cleared.metric_status, 'requires_freeze');
            assert.deepEqual(cleared.selected_snapshots, []);
            assert.equal(calls, 1);
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('the actual UI transport sends only reviewed sorted IDs/reason and X-Faultline-Revision; uncertain network/stale errors retain the same command identity', async () => {
        const original = globalThis.fetch, seen: {
            path: string;
            headers: Headers;
            body: string;
            method: string | undefined;
        }[] = [], command = createSnapshotSelectionCommand();
        globalThis.fetch = async (input, options) => {
            seen.push({ path: String(input), headers: new Headers(options?.headers), body: String(options?.body), method: options?.method });
            if (seen.length === 1)
                throw new TypeError('Explicit component transport fixture: response lost.');
            if (seen.length === 2)
                return new Response(JSON.stringify({ error: { code: 'STALE_INPUTS', message: 'Current revision changed.' } }), { status: 409 });
            return response(receipt);
        };
        try {
            await assert.rejects(command.submit(intent()), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK_UNAVAILABLE');
            await assert.rejects(command.submit(intent()), (error: unknown) => error instanceof ApiError && error.code === 'STALE_INPUTS');
            assert.deepEqual(await command.submit(intent()), receipt);
            const key = seen[0].headers.get('Idempotency-Key');
            assert.ok(key);
            for (const call of seen) {
                assert.equal(call.path, `${intent().base}/snapshot-selections`);
                assert.equal(call.method, 'POST');
                assert.equal(call.headers.get('Idempotency-Key'), key);
                assert.equal(call.headers.get('X-Faultline-Revision'), '3');
                assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf');
                assert.deepEqual(JSON.parse(call.body), { snapshot_ids: [a.id, b.id], reason: receipt.selection_reason });
            }
            await command.submit(intent());
            assert.notEqual(seen[3].headers.get('Idempotency-Key'), key, 'validated success releases the command identity');
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('the synchronous pending fence blocks double click; changed intent gets a new key and mismatched server bindings never become a saved receipt', async () => {
        const original = globalThis.fetch, seen: Headers[] = [];
        let release: ((value: Response) => void) | undefined;
        globalThis.fetch = async (_input, options) => { seen.push(new Headers(options?.headers)); return new Promise<Response>(resolve => { release = resolve; }); };
        const command = createSnapshotSelectionCommand();
        try {
            const pending = command.submit(intent());
            assert.equal(command.pending, true);
            await assert.rejects(command.submit(intent()), /already being saved/);
            assert.equal(seen.length, 1);
            assert.ok(release);
            release(response({ ...receipt, selected_snapshots: [{ ...receipt.selected_snapshots[0], content_hash: 'd'.repeat(64) }, receipt.selected_snapshots[1]] }));
            await assert.rejects(pending, /did not return the reviewed snapshot selection/);
            assert.equal(command.pending, false);
            const originalKey = seen[0].get('Idempotency-Key');
            globalThis.fetch = async (_input, options) => { seen.push(new Headers(options?.headers)); return response({ ...receipt, parent_id: 'wrong-parent' }); };
            await assert.rejects(command.submit({ ...intent(), reason: 'A newly reviewed reason.' }), /did not return the reviewed/);
            assert.notEqual(seen[1].get('Idempotency-Key'), originalKey);
            for (const changed of [{ ...receipt, revision: 99 }, { ...receipt, metric_status: 'fresh' }, { ...receipt, revision_id: receipt.parent_id }, { ...receipt, selected_snapshots: [...receipt.selected_snapshots].reverse() }]) {
                globalThis.fetch = async () => response(changed);
                await assert.rejects(command.submit(intent()), /did not return the reviewed/);
            }
        }
        finally {
            globalThis.fetch = original;
        }
    });
    test('persisted server IDs/hash remain visible on reload; exact coverage is a bounded scoped read and unknown is never promoted to PASS', async () => {
        assert.equal(isSnapshotSelection(receipt, receipt.revision_id), true);
        assert.equal(isSnapshotSelection(receipt, item.active_revision_id), false);
        const summary = renderToStaticMarkup(<SnapshotSelectionSummary value={receipt} receipt/>);
        for (const expected of [receipt.revision_id, receipt.snapshot_bundle_hash, a.id, a.content_hash!, b.id, b.content_hash!])
            assert.ok(summary.includes(expected));
        assert.match(summary, /Lock the metric again before running a new comparison/);
        assert.match(summary, /does not create a result/);
        assert.doesNotMatch(summary, /PASS|status good/);
        const reloaded = renderToStaticMarkup(<SnapshotSelection base={intent().base} csrf="" role="viewer" investigation={{ ...item, active_revision_id: receipt.revision_id, snapshot_selection: receipt }} snapshots={[a, b]} canMutate={false} metadataAvailable onSaved={() => { }}/>);
        assert.match(reloaded, /Saved data selection/);
        assert.ok(reloaded.includes(receipt.snapshot_bundle_hash));
        assert.doesNotMatch(reloaded, /<form/);
        const unknown: Coverage = { extraction_status: 'unknown', basis: 'none', covered_start: null, covered_end: null, event_watermark: null, attestation: '', event_time_intervals: [], assumptions: ['No event-time completeness is established.'] };
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async (path, options) => { calls++; assert.equal(String(path), `${intent().base}/snapshots/snapshot-a/quality`); assert.equal(options?.method, 'GET'); assert.equal(new Headers(options?.headers).get('Idempotency-Key'), null); return response(unknown); };
        try {
            assert.deepEqual(await readSnapshotQuality(intent().base, a), unknown);
            await assert.rejects(readSnapshotQuality(intent().base, { ...a, withdrawn: true }));
            await assert.rejects(readSnapshotQuality('https://external.invalid/cases/unit', a));
            assert.equal(calls, 1);
            globalThis.fetch = async () => response({ extraction_status: 'PASS' });
            await assert.rejects(readSnapshotQuality(intent().base, a), /quality remains unknown/);
        }
        finally {
            globalThis.fetch = original;
        }
    });
});
