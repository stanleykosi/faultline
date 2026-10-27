import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceInspection } from './EvidencePanel';
import { type Evidence } from './types';
import { ApiError } from '../../api';
import { TimelineReadState, TimelineResult, readTimeline, timelinePath, type TimelineEvidence, type TimelineFilters, type TimelineRecord, type TimelineSource } from './TimelinePanel';
import { RedactionPanel, reviewedRedaction } from './RedactionPanel';
describe("Evidence visibility", () => {
    const evidence: Evidence = { id: 'unit-evidence', workspace_id: 'unit-workspace', case_id: 'unit-case', revision_id: 'unit-input-revision', snapshot_id: 'unit-snapshot', source_kind: 'support', source_ref: '<a href="https://untrusted.invalid">Imported reference</a>', content_hash: 'a'.repeat(64), captured_at: '2026-10-11T20:00:00.123456Z', event_time: { kind: 'unknown', raw_description: 'Occurrence was not supplied' }, text: '<script>globalThis.untrusted = true</script>', redaction_status: 'sanitized', evidence_status: 'reported', supersedes_id: null, resource_revision: 4 };
    test("evidence inspection escapes imported content and hides withdrawn or inaccessible records", () => {
        {
            const html = renderToStaticMarkup(<EvidenceInspection item={evidence}/>);
            assert.doesNotMatch(html, /<script>|<a href=/);
            assert.match(html, /&lt;script&gt;/);
            assert.match(html, /&lt;a href=/);
            assert.match(html, /Unknown — Occurrence was not supplied/);
            assert.match(html, /2026-10-11T20:00:00\.123456Z/);
            for (const value of ['unit-evidence', 'unit-input-revision', 'unit-snapshot', 'a'.repeat(64)])
                assert.ok(html.includes(value));
            assert.match(html, /Unknown — freshness was not supplied/);
            assert.match(html, /Neither proves the cause/);
        }
        {
            const html = renderToStaticMarkup(<EvidenceInspection item={{ ...evidence, text: 'SECRET_WITHDRAWN_UNIT_TEXT', redaction_status: 'withdrawn', freshness: 'stale' }}/>);
            assert.ok(!html.includes('SECRET_WITHDRAWN_UNIT_TEXT'));
            assert.match(html, /text is unavailable/);
            assert.match(html, /Recorded freshness<\/dt><dd>stale/);
            const missing = renderToStaticMarkup(<EvidenceInspection item={undefined}/>);
            assert.match(missing, /role="alert"/);
            assert.match(missing, /unavailable in the current authorized record list/);
        }
    });
});
describe("Attributed timeline", () => {
    const base = '/api/v1/workspaces/unit-workspace/cases/unit-case', filters: TimelineFilters = { from: '', to: '', source_kind: '', limit: 50 };
    const baseline = { start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T01:00:00.000Z' }, comparison = { start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T01:00:00.000Z' }, window = { start: baseline.start, end: comparison.end };
    const qualityWarning = 'analytics has 1 uncovered intervals; missing records there do not establish absence of events.';
    const sources: TimelineSource[] = [
        { source_kind: 'analytics', status: 'partial', basis: ['operator_attestation'], snapshot_ids: ['snapshot-analytics'], source_ids: ['source-analytics'], covered_intervals: [baseline, comparison], covered_interval_count: 2, covered_intervals_truncated: false, gaps: [{ start: baseline.end, end: comparison.start }], gap_count: 1, gaps_truncated: false, limitations: [qualityWarning] },
        { source_kind: 'support', status: 'unavailable', basis: [], snapshot_ids: [], source_ids: [], covered_intervals: [], covered_interval_count: 0, covered_intervals_truncated: false, gaps: [window], gap_count: 1, gaps_truncated: false, limitations: ['support has no usable declared event-time coverage; event absence is unknown.'] },
        { source_kind: 'release', status: 'provisional', basis: ['lateness_assumption'], snapshot_ids: ['snapshot-release'], source_ids: ['source-release'], covered_intervals: [window], covered_interval_count: 1, covered_intervals_truncated: false, gaps: [], gap_count: 0, gaps_truncated: false, limitations: ['release uses a lateness assumption, not complete source proof.'] }
    ];
    const common = { source_ref: '<a href="https://untrusted.invalid">Imported reference</a>', content_hash: 'e'.repeat(64), captured_at: '2026-10-10T20:00:00.123Z', text: '<script>doNotExecuteImportedText()</script>', redaction_status: 'restricted' as const, evidence_status: 'user_attested' as const, cohort_relation: 'not_established' as const };
    const known: TimelineEvidence = { ...common, id: 'evidence-known', snapshot_id: 'snapshot-release', source_kind: 'release', event_time: { kind: 'range', start: '2026-10-02T23:59:59.999999Z', end: '2026-10-03T00:00:00.000001Z' }, temporal_relation: 'overlaps_selected_interval' };
    const unknown: TimelineEvidence = { ...common, id: 'evidence-unknown', snapshot_id: null, source_kind: 'human_note', event_time: { kind: 'unknown', raw_description: 'Occurrence was not supplied' }, captured_at: baseline.start, temporal_relation: 'occurrence_unknown' };
    const rate = (eligible: number, converted: number, value: number | null) => ({ eligible, converted, rate: value, interval: null });
    const record: TimelineRecord = {
        window, known_occurrence: [known], unknown_occurrence: [unknown], sources, limitations: ['Occurrence alignment is temporal association only.', ...sources.flatMap(source => source.limitations)], coverage_hash: 'c'.repeat(64), revision_id: 'input-revision',
        metric_windows: { baseline, comparison }, metric_cohorts: ['mobile', 'desktop'], metric_summary: { metric_hash: 'a'.repeat(64), quality: 'complete_attested', basis: 'operator_attestation', baseline: { ...rate(2, 1, 0.5), strata: { mobile: rate(1, 1, 1), desktop: rate(1, 0, 0) }, unknown_cohort_count: 0 }, comparison: { ...rate(2, 1, 0.5), strata: { mobile: rate(1, 0, 0), desktop: rate(1, 1, 1) }, unknown_cohort_count: 0 }, delta_pp: 0, relative_change: 0 },
        affected_flow: '<img src=x onerror=run()> checkout', page: { next_cursor: 'opaque.signature' }, association_limit: 'Temporal overlap does not establish a cohort link or aggregate causal effect.'
    };
    test('occurrence and capture retain exact times while unknown occurrence stays in its own section and imported text is escaped', () => {
        const html = renderToStaticMarkup(<TimelineResult value={record}/>), knownSection = html.split('aria-label="Known occurrence"')[1]!.split('aria-label="Unknown occurrence"')[0]!;
        assert.match(knownSection, /2026-10-02T23:59:59\.999999Z → 2026-10-03T00:00:00\.000001Z/);
        assert.match(knownSection, /Saved at<\/dt><dd>2026-10-10T20:00:00\.123Z/);
        assert.doesNotMatch(knownSection, /evidence-unknown|Occurrence was not supplied/);
        assert.match(html, /Unknown occurrence — kept separate/);
        assert.match(html, /Unknown — Occurrence was not supplied/);
        assert.match(html, /Saved-at timestamps do not supply a missing occurrence time/);
        for (const exact of [known.id, unknown.id, common.content_hash, 'snapshot-release'])
            assert.ok(html.includes(exact));
        assert.match(html, /&lt;script&gt;/);
        assert.match(html, /&lt;a href=/);
        assert.match(html, /&lt;img/);
        assert.doesNotMatch(html, /<script>|<a href=|<img /);
        assert.match(html, /Group relation<\/dt><dd>Not established/);
    });
    test("gaps, unavailable reads and provisional coverage never become empty or passing findings", () => {
        {
            const html = renderToStaticMarkup(<TimelineResult value={record}/>);
            assert.match(html, /analytics event-time coverage/);
            assert.match(html, /support event-time coverage/);
            assert.match(html, /release event-time coverage/);
            assert.match(html, /Uncovered intervals<\/dt><dd>1/);
            assert.ok(html.includes(qualityWarning));
            assert.ok(html.includes(`${baseline.end} → ${comparison.start}`));
            assert.match(html, /unavailable<\/span>/);
            assert.match(html, /May change<\/span>/);
            assert.match(html, /Logical source identities<\/dt><dd>source-analytics/);
            assert.match(html, /Temporal overlap does not establish a group link or the overall cause/);
            assert.match(html, /not a passing verification result/);
            assert.doesNotMatch(html, /status good|>PASS<|Events absent|Proven cause/);
            const gaps = Array.from({ length: 100 }, (_, n) => ({ start: new Date(Date.parse(baseline.start) + n * 2).toISOString(), end: new Date(Date.parse(baseline.start) + n * 2 + 1).toISOString() }));
            const truncated = renderToStaticMarkup(<TimelineResult value={{ ...record, sources: [{ ...sources[0], gaps, gap_count: 141, gaps_truncated: true }, ...sources.slice(1)] }}/>);
            assert.match(truncated, /Uncovered intervals<\/dt><dd>141/);
            assert.match(truncated, /showing 100 of 141/);
            assert.match(truncated, /Gaps after the displayed prefix remain uncovered/);
        }
        {
            const html = renderToStaticMarkup(<TimelineReadState value={record} pending={false} error={new Error('NETWORK_UNAVAILABLE')}/>);
            assert.match(html, /role="alert"/);
            assert.match(html, /Timeline state is unavailable/);
            assert.match(html, /coverage gaps and metric counts remain unknown/);
            assert.doesNotMatch(html, /No known-occurrence|No unknown-occurrence|Uncovered intervals|evidence-known/);
            const pending = renderToStaticMarkup(<TimelineReadState value={record} pending error={null}/>);
            assert.match(pending, /role="status"/);
            assert.match(pending, /Loading current timeline/);
            assert.doesNotMatch(pending, /evidence-known|Uncovered intervals/);
        }
    });
    test('cohort selection changes only authored metric symptom rows; evidence and its no-cohort warning remain unchanged', () => {
        const html = renderToStaticMarkup(<TimelineResult value={record} cohort="mobile"/>), symptoms = html.split('aria-label="Metric symptoms"')[1]!.split('aria-label="Source coverage"')[0]!;
        assert.match(symptoms, /mobile<\/th>/);
        assert.match(symptoms, /1 \/ 1/);
        assert.match(symptoms, /0 \/ 1/);
        assert.doesNotMatch(symptoms, /desktop<\/th>|All sessions<\/th>/);
        assert.match(html, /Group selection changes metric symptoms only/);
        assert.ok(html.includes(known.id));
        assert.ok(html.includes(unknown.id));
        const nullMetric = renderToStaticMarkup(<TimelineResult value={{ ...record, metric_summary: null, metric_windows: null }}/>);
        assert.match(nullMetric, /Metric counts remain unknown/);
        assert.match(nullMetric, /no frozen metric windows/);
        assert.doesNotMatch(nullMetric, /0 \/ 0|Timeline metric symptoms/);
        const undefinedCohort = renderToStaticMarkup(<TimelineResult value={record} cohort="invented-cohort"/>);
        assert.match(undefinedCohort, /selected group is not defined by this metric/);
        assert.doesNotMatch(undefinedCohort, /Timeline metric symptoms/);
    });
    test("timeline transport is finite, scoped and rejects changed pagination bindings", async () => {
        {
            assert.equal(timelinePath(base, filters), base + '/timeline?limit=50');
            const path = new URL(timelinePath(base, { ...filters, from: window.start, to: window.end, source_kind: 'release', cohort: 'mobile', target_url: 'https://untrusted.invalid' } as TimelineFilters, 'opaque.signature'), 'http://localhost:3000');
            assert.deepEqual([...path.searchParams.keys()], ['from', 'to', 'source_kind', 'limit', 'cursor']);
            assert.equal(path.searchParams.get('from'), window.start);
            for (const value of [{ ...filters, from: window.start }, { ...filters, from: window.end, to: window.start }, { ...filters, from: '2026-02-30T00:00:00.000Z', to: window.end }, { ...filters, source_kind: 'execute(anything)' }, { ...filters, limit: 101 }])
                assert.throws(() => timelinePath(base, value as TimelineFilters));
            assert.throws(() => timelinePath('https://untrusted.invalid/timeline', filters));
            assert.throws(() => timelinePath(base, filters, 'https://untrusted.invalid'));
        }
        {
            const previous = globalThis.fetch, calls: {
                path: string;
                options?: RequestInit;
            }[] = [], signal = new AbortController().signal;
            globalThis.fetch = async (path, options) => { calls.push({ path: String(path), options }); return new Response(JSON.stringify({ data: record, meta: { request_id: 'unit-timeline' } }), { headers: { 'Content-Type': 'application/json' } }); };
            try {
                assert.deepEqual(await readTimeline(base, filters, null, signal), record);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].path, base + '/timeline?limit=50');
                assert.equal(calls[0].options?.method, 'GET');
                assert.equal(calls[0].options?.credentials, 'same-origin');
                assert.equal(calls[0].options?.signal, signal);
                assert.equal(calls[0].options?.body, undefined);
                const headers = new Headers(calls[0].options?.headers);
                for (const name of ['Idempotency-Key', 'X-CSRF-Token', 'X-Faultline-Revision'])
                    assert.equal(headers.has(name), false);
            }
            finally {
                globalThis.fetch = previous;
            }
        }
        {
            const previous = globalThis.fetch;
            try {
                for (const value of [{ ...record, revision_id: 'new-revision' }, { ...record, coverage_hash: 'd'.repeat(64) }]) {
                    globalThis.fetch = async () => new Response(JSON.stringify({ data: value }));
                    await assert.rejects(readTimeline(base, filters, 'opaque.signature', undefined, record), /Reset to the first page/);
                }
                globalThis.fetch = async () => new Response(JSON.stringify({ data: record }));
                await assert.rejects(readTimeline(base, filters, 'opaque.signature', undefined, record), /cursor did not advance/);
                for (const value of [{ ...record, sources: undefined }, { ...record, sources: [{ ...sources[0], gap_count: null }, ...sources.slice(1)] }, { ...record, unknown_occurrence: [{ ...unknown, event_time: known.event_time }] }, { ...record, page: {} }, { ...record, metric_summary: { ...record.metric_summary, comparison: undefined } }, { ...record, association_limit: 'Temporal overlap proves the cause' }]) {
                    globalThis.fetch = async () => new Response(JSON.stringify({ data: value }));
                    await assert.rejects(readTimeline(base, filters, null), /unavailable or incomplete/);
                }
                globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'INPUTS_REQUIRED', message: 'Choose an interval or freeze metric windows.' } }), { status: 409 });
                await assert.rejects(readTimeline(base, filters, null), error => error instanceof ApiError && error.code === 'INPUTS_REQUIRED');
            }
            finally {
                globalThis.fetch = previous;
            }
        }
    });
});
describe("Redaction approval", () => {
    const preview = { preview_id: '8cc14e71-370a-4eb3-97da-9d415166e43f', preview_hash: 'a'.repeat(64), revision_id: '777acb4d-df00-4844-813c-9c33088514c1', review_status: 'preview_only', binding: { policy_version: 'contact-secrets-v1' }, rows: [{ id: 'bf984f4a-9eaf-4439-8032-d60f45fc2d12', redaction: { text: '[REDACTED_SECRET]', output_hash: 'b'.repeat(64), counts: { emails: 0, secrets: 1, phones: 0 }, limitations: ['Only the approved finite policy was applied.'] } }], limitations: ['Unknown private text can remain.'] };
    test("only exact completed supported previews can receive explicit bounded human approval", () => {
        {
            assert.deepEqual(reviewedRedaction(preview, true, '  Reviewed excerpt  '), { preview_id: preview.preview_id, reason: 'Reviewed excerpt' });
            assert.throws(() => reviewedRedaction(preview, false, 'Reviewed excerpt'), /Review every/);
            assert.throws(() => reviewedRedaction(preview, true, ' '), /Review every/);
            assert.throws(() => reviewedRedaction(preview, true, 'x'.repeat(2001)), /Review every/);
        }
        {
            for (const value of [null, { ...preview, review_status: 'queued' }, { ...preview, preview_hash: 'unknown' }, { ...preview, preview_id: 'untrusted' }, { ...preview, rows: [] }, { ...preview, binding: { policy_version: 'model-proposed-policy' } }])
                assert.throws(() => reviewedRedaction(value, true, 'Reviewed excerpt'), /complete supported/);
        }
    });
    test('viewer has no redaction controls; analyst sees finite policy limits without changing owner approval', () => {
        const common = { base: '/api/v1/workspaces/unit-workspace/cases/unit-case', csrf: 'unit-csrf', evidence: [], onChanged: async () => { } };
        assert.equal(renderToStaticMarkup(<RedactionPanel {...common} canMutate={false}/>), '');
        const html = renderToStaticMarkup(<RedactionPanel {...common} canMutate/>);
        assert.match(html, /contact-secrets-v1/);
        assert.match(html, /Other private text can remain/);
        assert.match(html, /Original files and attachments stay separate/);
        assert.match(html, /disabled="">Preview redaction/);
        assert.doesNotMatch(html, /Apply reviewed redaction|Save reviewed policy|sanitized citations/);
    });
});
