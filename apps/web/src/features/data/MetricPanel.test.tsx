import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ApiError, casePath} from '../../api';
import type {CommandIdentity} from '../../command-key';
import {MetricPanel, metricFromFormData, MetricFreezeReviewSummary, pinMetricFreezeReview, metricFreezeReviewCurrent, submitMetricFreezeReview, type MetricFreezeFacts} from './MetricPanel';
import type {SelectionInvestigation} from './SnapshotSelection';
import type {MetricRecord, Snapshot} from './types';

const investigation: SelectionInvestigation = {id: 'case-review', workspace_id: 'workspace-review', title: 'Unchanged metric draft', question: 'Does renewed consent bind the actual revision?', affected_flow: 'checkout', active_revision_id: 'revision-before', lifecycle: 'open', archived: false, revision: 3, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', snapshot_selection: {revision_id: 'revision-before', snapshot_bundle_hash: 'b'.repeat(64), selected_snapshots: [{id: 'snapshot-review', source_id: 'source-review', content_hash: 's'.repeat(64).replaceAll('s', 'c')}], selection_reason: 'Retain the explicit source.'}};
const metric: MetricRecord = {id: 'metric-review', state: 'draft', metric_hash: 'a'.repeat(64), value: {version: 1, template: 'session_conversion_v1', source_id: 'source-review', unit: 'session', entry_event: 'checkout_started', success_event: 'checkout_completed', horizon_seconds: 1800, segment_property: 'device', cohorts: ['desktop'], windows: {baseline: {start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z'}, comparison: {start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z'}}, exclusion_rule: 'entry_excluded_false', timezone: 'UTC'}};
const snapshot: Snapshot = {id: 'snapshot-review', source_id: 'source-review', record_kind: 'analytics', content_hash: 'c'.repeat(64), record_count: 4, coverage: {extraction_status: 'complete', basis: 'lateness_assumption', covered_start: '2026-10-01T00:00:00.000Z', covered_end: '2026-10-04T00:30:00.000Z', event_watermark: '2026-10-04T00:30:00.000Z', attestation: '', event_time_intervals: [{start: '2026-10-01T00:00:00.000Z', end: '2026-10-04T00:30:00.000Z'}], assumptions: ['Explicit source lateness assumption.']}};
const facts = (): MetricFreezeFacts => ({base: casePath(investigation.workspace_id, investigation.id), investigation: structuredClone(investigation), metric: structuredClone(metric), snapshot: structuredClone(snapshot), canMutate: true, metadataAvailable: true});
const accepted = {id: metric.id, state: 'frozen', revision_id: 'server-new-revision', metric_hash: metric.metric_hash, snapshot_id: snapshot.id};
const respond = (value: unknown) => new Response(JSON.stringify({data: value}), {status: 200, headers: {'Content-Type': 'application/json'}});

test('viewer can inspect a saved proposed contract diff without receiving freeze controls',()=>{
  const html=renderToStaticMarkup(<MetricPanel base={casePath(investigation.workspace_id,investigation.id)} csrf="" investigation={investigation} snapshots={[snapshot]} metrics={[metric]} selectedMetricId={metric.id} selectedSnapshotId={snapshot.id} canMutate={false} onMetric={()=>{}} onSnapshot={()=>{}} onFrozen={async()=>{}} onCompare={async()=>{}}/>);
  assert.match(html,/Previous frozen inputs versus proposed inputs/); assert.match(html,/No prior frozen metric is recorded/);
  assert.doesNotMatch(html,/Review &amp; freeze metric|Freeze reviewed inputs/);
});

test('J027B: changed case revision, active revision or bundle with identical metric/snapshot IDs cannot reuse earlier consent or submit the new revision', async () => {
  const current = facts(), pinned = pinMetricFreezeReview(current), originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => {requests++; return respond(accepted);};
  try {
    const changed = [
      {...facts(), investigation: {...investigation, revision: 4}},
      {...facts(), investigation: {...investigation, active_revision_id: 'revision-after', snapshot_selection: {...investigation.snapshot_selection!, revision_id: 'revision-after'}}},
      {...facts(), investigation: {...investigation, snapshot_selection: {...investigation.snapshot_selection!, snapshot_bundle_hash: 'd'.repeat(64)}}}
    ];
    for (const refreshed of changed) {
      assert.equal(refreshed.metric!.id, pinned.metric_id); assert.equal(refreshed.snapshot!.id, pinned.snapshot_id);
      assert.equal(metricFreezeReviewCurrent(pinned, refreshed), false);
      await assert.rejects(submitMetricFreezeReview(pinned, refreshed, 'unit-csrf', true, {current: null}), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_METRIC_REVIEW');
    }
    assert.equal(requests, 0); assert.equal(pinned.case_revision, 3); assert.equal(pinned.active_revision_id, 'revision-before'); assert.equal(pinned.snapshot_bundle_hash, 'b'.repeat(64));
    const html = renderToStaticMarkup(<MetricFreezeReviewSummary review={pinned} onRefresh={async () => {}} />); assert.match(html, /Reviewed case revision<\/dt><dd>3/); assert.match(html, /revision-before/); assert.ok(html.includes('b'.repeat(64))); assert.doesNotMatch(html, /revision-after|>PASS</); assert.match(html, /type="button"[^>]*>Refresh recorded inputs/);
    const reading = renderToStaticMarkup(<MetricFreezeReviewSummary review={pinned} onRefresh={async () => {}} pending />); assert.match(reading, /disabled=""[^>]*>Refresh recorded inputs/); assert.match(reading, /Reviewed case revision<\/dt><dd>3/); assert.ok(reading.includes('b'.repeat(64)), 'Refreshing cannot silently replace the displayed reviewed binding.');
  } finally {globalThis.fetch = originalFetch;}
});

test('the freeze transport always uses pinned X-Faultline-Revision/body; stale API responses clear no identity and a fresh review requires a new explicit acknowledgment', async () => {
  const originalFetch = globalThis.fetch, current = facts(), pinned = pinMetricFreezeReview(current), identity: {current: CommandIdentity} = {current: null}, seen: {path: string; headers: Headers; body: unknown}[] = [];
  globalThis.fetch = async (input, options) => {seen.push({path: String(input), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body))}); return new Response(JSON.stringify({error: {code: 'STALE_INPUTS', message: 'Case resource revision changed.'}}), {status: 409});};
  try {
    for (let n = 0; n < 2; n++) await assert.rejects(submitMetricFreezeReview(pinned, current, 'unit-csrf', true, identity), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_INPUTS');
    const oldKey = identity.current?.key; assert.ok(oldKey);
    for (const call of seen) {assert.equal(call.path, current.base + '/metrics/metric-review/freeze'); assert.equal(call.headers.get('X-Faultline-Revision'), '3'); assert.equal(call.headers.get('X-CSRF-Token'), 'unit-csrf'); assert.equal(call.headers.get('Idempotency-Key'), oldKey); assert.deepEqual(call.body, {snapshot_id: 'snapshot-review', metric_hash: 'a'.repeat(64), acknowledged_assumptions: ['Explicit source lateness assumption.']});}
    const freshFacts = {...facts(), investigation: {...investigation, revision: 4, active_revision_id: 'reviewed-revision-four', snapshot_selection: {...investigation.snapshot_selection!, revision_id: 'reviewed-revision-four', snapshot_bundle_hash: 'd'.repeat(64)}}}, renewed = pinMetricFreezeReview(freshFacts);
    await assert.rejects(submitMetricFreezeReview(renewed, freshFacts, 'unit-csrf', false, identity), /Review and acknowledge/); assert.equal(seen.length, 2);
    globalThis.fetch = async (input, options) => {seen.push({path: String(input), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body))}); return respond(accepted);};
    assert.deepEqual(await submitMetricFreezeReview(renewed, freshFacts, 'unit-csrf', true, identity), accepted); assert.equal(seen[2].headers.get('X-Faultline-Revision'), '4'); assert.notEqual(seen[2].headers.get('Idempotency-Key'), oldKey); assert.equal(identity.current, null);
  } finally {globalThis.fetch = originalFetch;}
});

test('lost metadata/access, changed hashes or completeness assumptions invalidate review while pinned copies retain exactly what was displayed', async () => {
  const current = facts(), pinned = pinMetricFreezeReview(current);
  const changed: MetricFreezeFacts[] = [{...facts(), canMutate: false}, {...facts(), metadataAvailable: false}, {...facts(), investigation: {...investigation, archived: true}}, {...facts(), investigation: {...investigation, lifecycle: 'closed'}}, {...facts(), metric: {...metric, metric_hash: 'd'.repeat(64)}}, {...facts(), snapshot: {...snapshot, content_hash: 'e'.repeat(64)}}, {...facts(), investigation: {...investigation, snapshot_selection: undefined}}, {...facts(), snapshot: {...snapshot, coverage: {...snapshot.coverage!, assumptions: ['A different source completeness assumption.']}}}];
  for (const refreshed of changed) assert.equal(metricFreezeReviewCurrent(pinned, refreshed), false);
  current.snapshot!.coverage!.assumptions!.push('A later UI metadata replacement.'); assert.deepEqual(pinned.acknowledged_assumptions, ['Explicit source lateness assumption.']); assert.deepEqual(pinned.coverage!.assumptions, ['Explicit source lateness assumption.']); assert.equal(metricFreezeReviewCurrent(pinned, current), false);
  const noBundle = {...facts(), investigation: {...investigation, snapshot_selection: null}}; assert.equal(pinMetricFreezeReview(noBundle).snapshot_bundle_hash, null, 'Explicit authoritative no-bundle flow remains supported.');
});

test('unrelated display updates preserve the reviewed binding and viewer presentation keeps read-only metric semantics', () => {
  const current = facts(), pinned = pinMetricFreezeReview(current), displayUpdate = {...facts(), investigation: {...investigation, title: 'A display title', updated_at: '2026-10-12T23:30:00.000Z'}};
  assert.equal(metricFreezeReviewCurrent(pinned, displayUpdate), true); assert.deepEqual(pinned.metric, metric.value);
  const html = renderToStaticMarkup(<MetricPanel base={current.base} csrf="" investigation={investigation} snapshots={[snapshot]} metrics={[metric]} selectedMetricId={metric.id} selectedSnapshotId={snapshot.id} canMutate={false} onMetric={() => {}} onSnapshot={() => {}} onFrozen={async () => {}} onCompare={async () => {}} />);
  assert.doesNotMatch(html, /Review &amp; freeze metric|Freeze reviewed inputs|Save metric draft|Compute frozen comparison/); assert.match(html, /checkout_started/); assert.match(html, /checkout_completed/); assert.match(html, /2026-10-01T00:00:00.000Z/); assert.match(html, /2026-10-04T00:00:00.000Z/); assert.match(html, /lateness assumption/);
});

function displayedMetricForm(): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries({source_id: 'captured-source', cohorts: 'mobile, desktop', entry_event: 'checkout_started', success_event: 'checkout_completed', baseline_start: '2026-09-01T00:00', baseline_end: '2026-09-02T00:00', comparison_start: '2026-09-02T00:00', comparison_end: '2026-09-03T00:00'})) form.set(name, value);
  return form;
}

test('metric save serializes the currently displayed form with exact UTC midnight boundaries instead of stale draft state', () => {
  const submitted = metricFromFormData(displayedMetricForm());
  assert.deepEqual(submitted.windows, {baseline: {start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z'}, comparison: {start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z'}});
  assert.notDeepEqual(submitted.windows, metric.value.windows, 'Existing October metric state must not replace the displayed September dates.');
  assert.equal(submitted.source_id, 'captured-source'); assert.deepEqual(submitted.cohorts, ['mobile', 'desktop']);
  assert.equal(submitted.entry_event, 'checkout_started'); assert.equal(submitted.success_event, 'checkout_completed'); assert.equal(submitted.horizon_seconds, 1800); assert.equal(submitted.timezone, 'UTC');
  const html = renderToStaticMarkup(<MetricPanel base={facts().base} csrf="" investigation={investigation} snapshots={[snapshot]} metrics={[]} selectedMetricId="" selectedSnapshotId="" canMutate onMetric={() => {}} onSnapshot={() => {}} onFrozen={async () => {}} onCompare={async () => {}} />);
  for (const name of ['source_id', 'cohorts', 'entry_event', 'success_event', 'baseline_start', 'baseline_end', 'comparison_start', 'comparison_end']) assert.match(html, new RegExp(`name="${name}"`));
});

test('metric form submission rejects missing, blank, invalid or reversed displayed boundaries without fallback to a saved metric', () => {
  for (const name of ['baseline_start', 'baseline_end', 'comparison_start', 'comparison_end']) {
    const missing = displayedMetricForm(); missing.delete(name); assert.throws(() => metricFromFormData(missing), /Missing metric field/);
    for (const value of ['', '2026-13-01T00:00', '2026-09-01T00:00Z', 'not-a-date']) {
      const invalid = displayedMetricForm(); invalid.set(name, value); assert.throws(() => metricFromFormData(invalid), /valid UTC date|UTC date or time is invalid/);
    }
  }
  const reversed = displayedMetricForm(); reversed.set('baseline_end', '2026-08-31T00:00'); assert.throws(() => metricFromFormData(reversed), /end must follow/);
  const equal = displayedMetricForm(); equal.set('comparison_end', '2026-09-02T00:00'); assert.throws(() => metricFromFormData(equal), /end must follow/);
  const absentSource = displayedMetricForm(); absentSource.delete('source_id'); assert.throws(() => metricFromFormData(absentSource), /Missing metric field/);
  const duplicateCohorts = displayedMetricForm(); duplicateCohorts.set('cohorts', 'mobile, mobile'); assert.throws(() => metricFromFormData(duplicateCohorts), /unique device groups/);
});
