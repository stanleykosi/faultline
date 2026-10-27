import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Investigation} from '../../api';
import type {AnalysisContext, FollowUp} from './types';
import {FollowUpsPanel, FollowUpResultView, followUpDefaults} from './FollowUpsPanel';

test('a persisted waiting-for-data receipt without metric values remains visible and cannot crash or invent counts', () => {
  for (const result of [null, {mode: 'observational' as const, causal_effect: 'not_established' as const, reason: 'new_snapshot_required', missing_data_notified_at: null}]) {
    const html = renderToStaticMarkup(<FollowUpResultView state="waiting_for_data" result={result} />);
    assert.match(html, /Follow-up comparison unavailable/); assert.match(html, /Waiting for fresh data/); assert.match(html, /remain unknown/);
    assert.doesNotMatch(html, /Actual observed comparison|<table|>passed<|0 \/ 0/);
    if (result) assert.match(html, /new snapshot required/);
  }
});

test('an incomplete comparison keeps null metric values unknown and retains its recorded diagnostic quality', () => {
  const html = renderToStaticMarkup(<FollowUpResultView state="waiting_for_data" result={{mode: 'observational', causal_effect: 'not_established', reason: 'coverage_tail_missing', value: {metric_hash: 'a'.repeat(64), quality: 'incomplete', basis: 'none', baseline: null, comparison: null, delta_pp: null, relative_change: null}}} />);
  assert.match(html, /Incomplete follow-up diagnostic comparison/); assert.match(html, /coverage tail missing/); assert.match(html, /Unknown/); assert.match(html, /not established/); assert.doesNotMatch(html, /0 \/ 0|>passed</);
});


test('follow-up review defaults preserve the frozen observation duration and stay manual', () => {
  const context = {metric: {windows: {comparison: {start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z'}}}} as AnalysisContext;
  assert.deepEqual(followUpDefaults(context), {start: '2026-10-08T00:00:00', end: '2026-10-15T00:00:00', note: 'Compare the next observation window using the same frozen metric and source. Treat any change as observational.'});
  for (const end of ['bad-date', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z']) assert.deepEqual(followUpDefaults({...context, metric: {...context.metric, windows: {...context.metric.windows, comparison: {...context.metric.windows.comparison, end}}}}), {start: '', end: '', note: ''});
});


test('follow-up creation opens for an empty list, collapses beside saved work, and retains explicit consent', () => {
  const context = {binding: {revision_id: 'revision-one', metric_hash: 'metric-one'}, metric: {source_id: 'source-one', windows: {comparison: {start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z'}}}} as AnalysisContext;
  const investigation = {revision: 2, active_revision_id: 'revision-one'} as Investigation;
  const saved = {id: 'followup-one', revision_id: 'revision-one', revision: 1, freshness: 'fresh', state: 'scheduled', result: null, value: {source_ids: ['source-one'], note: 'Observe checkout', comparison_start: '2026-10-08T00:00:00Z', comparison_end: '2026-10-15T00:00:00Z', trigger_mode: 'manual', original_snapshot_id: 'original', metric_hash: 'metric-one'}} as unknown as FollowUp;
  const render = (followups: FollowUp[], canMutate = true) => renderToStaticMarkup(<FollowUpsPanel base="/case" csrf="token" investigation={investigation} context={context} followups={followups} snapshots={[]} evidence={[]} canMutate={canMutate} onChanged={async () => {}} />);
  const empty = render([]), existing = render([saved]);
  assert.match(empty, /<details class="panel" open=""><summary>Create follow-up<\/summary>/);
  assert.match(existing, /<details class="panel"><summary>Create follow-up<\/summary>/);
  for (const html of [empty, existing]) {
    assert.match(html, /<input(?=[^>]*name="start")(?=[^>]*required="")[^>]*>/);
    assert.match(html, /<input(?=[^>]*name="end")(?=[^>]*required="")[^>]*>/);
    assert.match(html, /type="checkbox" required=""/);
    assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
    assert.match(html, /<option value="manual" selected="">/);
  }
  assert.doesNotMatch(render([saved], false), /<summary>Create follow-up|type="checkbox"|>Run follow-up<|>Cancel follow-up</);
});
