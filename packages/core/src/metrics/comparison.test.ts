import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {computeComparison, computeMixShift, comparisonEvidenceSummary, previewComparison, summarizeRate, validateMetric} from './comparison.js';
import {normalizeAnalytics} from '../imports/parser.js';
import {normalizeEventTime} from '../imports/time.js';
import {DomainError} from '../errors.js';
import type {FaultlineCanonicalEvent, FaultlineCoverage, FaultlineMetric} from '../../../contracts/src/generated.js';
const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const metric = read('fixtures/regression/metric.json') as FaultlineMetric;
const coverage = read('fixtures/regression/coverage.json') as FaultlineCoverage;
const close = (actual: number | null, expected: number, tolerance = 1e-12) => {assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} differs from ${expected}`);};
let id = 0;
function event(session: string, name: string, time: string, device = 'mobile', excluded = false, source = 'synthetic-analytics'): FaultlineCanonicalEvent {
  return {source_id: source, event_id: `event-${id++}`, session_id: session, event_name: name, occurred_at: normalizeEventTime(time), device, excluded, release_id: null};
}
const entry = (session: string, time: string, device?: string, excluded?: boolean) => event(session, metric.entry_event, time, device, excluded);
const success = (session: string, time: string, device?: string, source?: string) => event(session, metric.success_event, time, device, false, source);
const errorCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

for (const fixture of ['regression', 'mix-shift']) test(`${fixture}: deterministic comparison and mix standardization match independent fixture expectations`, () => {
  const events = normalizeAnalytics(fs.readFileSync(`fixtures/${fixture}/events.csv`), 'csv', 'synthetic-analytics').events;
  const result = computeComparison(events, read(`fixtures/${fixture}/metric.json`), read(`fixtures/${fixture}/coverage.json`)), expected = read(`fixtures/${fixture}/expected.json`);
  assert.equal(result.quality, 'complete_attested'); assert.equal(result.baseline!.eligible, 1000); assert.equal(result.comparison!.eligible, 1000);
  assert.equal(result.baseline!.converted, fixture === 'regression' ? 200 : 340); assert.equal(result.comparison!.converted, fixture === 'regression' ? 110 : 160);
  close(result.baseline!.rate, expected.baseline_rate); close(result.comparison!.rate, expected.comparison_rate); close(result.delta_pp, expected.delta_pp);
  close(result.baseline!.strata.mobile!.rate, expected.mobile_before); close(result.comparison!.strata.mobile!.rate, expected.mobile_after);
  close(result.baseline!.strata.desktop!.rate, expected.desktop_before); close(result.comparison!.strata.desktop!.rate, expected.desktop_after);
  const mix = computeMixShift(result); assert.equal(mix.status, 'complete'); close(mix.standardized_rate, expected.standardized_rate); close(mix.within_component_pp, expected.within_component_pp); close(mix.composition_component_pp, expected.composition_component_pp);
  close(mix.within_component_pp! + mix.composition_component_pp!, expected.delta_pp);
  if (fixture === 'regression') close(result.relative_change, -0.45);
});

test('model evidence labels baseline, later and standardized conversion as rates, not an adjusted decline',()=>{
  const events=normalizeAnalytics(fs.readFileSync('fixtures/mix-shift/events.csv'),'csv','synthetic-analytics').events;
  const result=computeComparison(events,read('fixtures/mix-shift/metric.json'),read('fixtures/mix-shift/coverage.json')),before=JSON.stringify(result),text=comparisonEvidenceSummary(result,computeMixShift(result));
  assert.match(text,/baseline 340\/1000 \(rate 0\.34\)/);assert.match(text,/comparison 160\/1000 \(rate 0\.16\)/);
  const rate=Number(text.match(/Comparison conversion rate at baseline cohort weights: ([0-9.]+)/)?.[1]);close(rate,0.34);
  assert.match(text,/percentage points/);assert.match(text,/\(complete\)/);assert.match(text,/aggregate causal effect not established/);
  assert.equal(JSON.stringify(result),before);
});

test('incomplete evidence never renders absent windows or standardization as zero or a passing result',()=>{
  const result=computeComparison([],metric,{...coverage,basis:'none'}),text=comparisonEvidenceSummary(result,computeMixShift(result));
  assert.match(text,/baseline unknown; comparison unknown; change unknown/);assert.match(text,/weights: unknown \(inconclusive\)/);
  assert.doesNotMatch(text,/undefined|null|0\/0|\(complete\)/);assert.match(text,/causal effect not established/);
});
test('half-open entry windows preserve one microsecond around boundaries', () => {
  const events = [entry('before', '2026-08-31T23:59:59.999999Z'), entry('start', '2026-09-01T00:00:00.000000Z'), entry('last', '2026-09-01T23:59:59.999999Z'), entry('end', '2026-09-02T00:00:00.000000Z')];
  const result = computeComparison(events, metric, coverage);
  assert.equal(result.baseline!.eligible, 2); assert.equal(result.comparison!.eligible, 1);
});
test('success at inclusive horizon counts, one microsecond after and before entry do not', () => {
  const events = [entry('at', '2026-09-01T23:50:00.000000Z'), success('at', '2026-09-02T00:20:00.000000Z'), entry('after', '2026-09-01T01:00:00.000000Z'), success('after', '2026-09-01T01:30:00.000001Z'), entry('before', '2026-09-01T02:00:00.000001Z'), success('before', '2026-09-01T02:00:00.000000Z')];
  const result = computeComparison(events, metric, coverage);
  assert.equal(result.baseline!.eligible, 3); assert.equal(result.baseline!.converted, 1);
});
test('first entry selection precedes exclusions and preserves entry-time cohort', () => {
  const events = [entry('excluded', '2026-09-01T01:00:00Z', 'mobile', true), entry('excluded', '2026-09-01T01:01:00Z', 'mobile', false), success('excluded', '2026-09-01T01:02:00Z'), entry('switch', '2026-09-01T01:00:00Z', 'mobile'), success('switch', '2026-09-01T01:02:00Z', 'desktop')];
  const result = computeComparison(events.reverse(), metric, coverage);
  assert.equal(result.baseline!.eligible, 1); assert.equal(result.baseline!.converted, 1); assert.equal(result.baseline!.strata.mobile!.converted, 1); assert.equal(result.baseline!.strata.desktop!.eligible, 0);
  const preview = previewComparison(events, metric); assert.equal(preview.samples.baseline.find(s => s.session_id === 'excluded')!.excluded, true);
});
test('duplicate successes contribute once and cross-source same session cannot convert', () => {
  const one = success('repeat', '2026-09-01T01:02:00Z');
  const events = [entry('repeat', '2026-09-01T01:00:00Z'), one, one, success('repeat', '2026-09-01T01:03:00Z'), entry('cross', '2026-09-01T02:00:00Z'), success('cross', '2026-09-01T02:01:00Z', 'mobile', 'another-source')];
  const result = computeComparison(events, metric, coverage); assert.equal(result.baseline!.eligible, 2); assert.equal(result.baseline!.converted, 1);
  assert.throws(() => computeComparison([one, {...one, device: 'desktop'}], metric, coverage), errorCode('CONFLICTING_DUPLICATE'));
});
test('a session can enter once in each disjoint window', () => {
  const events = [entry('same', '2026-09-01T01:00:00Z'), entry('same', '2026-09-02T01:00:00Z'), success('same', '2026-09-02T01:01:00Z')];
  const result = computeComparison(events, metric, coverage); assert.equal(result.baseline!.eligible, 1); assert.equal(result.comparison!.eligible, 1); assert.equal(result.baseline!.converted, 0); assert.equal(result.comparison!.converted, 1);
});
test('unknown cohorts block authoritative counts while remaining visible in separate preview', () => {
  const events = [entry('unknown', '2026-09-01T01:00:00Z', 'tablet')];
  const result = computeComparison(events, metric, coverage); assert.equal(result.quality, 'incomplete'); assert.equal(result.reason, 'unknown_entry_cohort'); assert.equal(result.baseline, null);
  const preview = previewComparison(events, metric); assert.equal(preview.baseline.eligible, 1); assert.equal(preview.baseline.unknown_cohort_count, 1);
});
test('coverage gaps cannot be hidden by extrema, missing tail/watermark never passes', () => {
  const gap = {...coverage, event_time_intervals: [{start: coverage.covered_start!, end: '2026-09-01T12:00:00.000Z'}, {start: '2026-09-01T12:00:00.001Z', end: coverage.covered_end!}]};
  for (const c of [gap, {...coverage, event_watermark: '2026-09-03T00:29:59.999Z'}, {...coverage, covered_end: '2026-09-03T00:00:00.000Z'}, {...coverage, basis: 'none'}, {...coverage, extraction_status: 'partial'}]) {
    const result = computeComparison([], metric, c); assert.equal(result.quality, 'incomplete'); assert.equal(result.baseline, null); assert.equal(result.delta_pp, null);
  }
  const adjacent = {...coverage, event_time_intervals: [{start: coverage.covered_start!, end: '2026-09-02T00:00:00.000Z'}, {start: '2026-09-02T00:00:00.000Z', end: coverage.covered_end!}]};
  assert.equal(computeComparison([], metric, adjacent).quality, 'complete_attested');
});
test('lateness assumptions yield provisional results and remain provisional in adjustment', () => {
  const assumed = {...coverage, basis: 'lateness_assumption', attestation: 'Events assumed mature after 24 hours', assumptions: ['24-hour lateness']};
  const events = [entry('base', '2026-09-01T01:00:00Z'), success('base', '2026-09-01T01:01:00Z'), entry('after', '2026-09-02T01:00:00Z')];
  const result = computeComparison(events, metric, assumed); assert.equal(result.quality, 'provisional'); assert.equal(computeMixShift(result).status, 'provisional');
  assert.equal(computeComparison(events, metric, {...assumed, attestation: '', assumptions: []}).quality, 'incomplete');
});
test('known empty windows have null rates/intervals and zero baseline rate has undefined relative change', () => {
  const empty = computeComparison([], metric, coverage); assert.equal(empty.baseline!.eligible, 0); assert.equal(empty.baseline!.rate, null); assert.equal(empty.baseline!.interval, null); assert.equal(empty.reason, 'known_empty_window');
  const zero = computeComparison([entry('base', '2026-09-01T01:00:00Z'), entry('after', '2026-09-02T01:00:00Z'), success('after', '2026-09-02T01:01:00Z')], metric, coverage);
  assert.equal(zero.baseline!.rate, 0); assert.equal(zero.delta_pp, 100); assert.equal(zero.relative_change, null);
});
test('mix adjustment requires positive comparison denominators for every positive baseline weight', () => {
  const events = [entry('base-mobile', '2026-09-01T01:00:00Z'), entry('base-desktop', '2026-09-01T01:00:00Z', 'desktop'), entry('after', '2026-09-02T01:00:00Z')];
  const result = computeComparison(events, metric, coverage), mix = computeMixShift(result);
  assert.equal(mix.status, 'inconclusive'); assert.deepEqual(mix.missing_comparison_strata, ['desktop']); assert.equal(mix.standardized_rate, null);
});
test('mix adjustment rejects invented rates rather than copying trusted-looking JSON numbers', () => {
  const result = computeComparison([entry('base', '2026-09-01T01:00:00Z'), entry('after', '2026-09-02T01:00:00Z')], metric, coverage);
  const forged = structuredClone(result); forged.baseline!.rate = 0.5;
  assert.throws(() => computeMixShift(forged), errorCode('INVALID_METRIC_RESULT'));
});
test('Wilson intervals match independent numerical boundary examples', () => {
  // Ordinary-sample values are independently supplied in metric-result.example.json.
  const examples = [[10, 0, 0, 0.2775327998628892], [10, 10, 0.7224672001371107, 1], [5, 1, 0.03622410863243014, 0.6244653702374747], [1000, 200, 0.1763770904431985, 0.22591896464813463]];
  for (const [n, y, low, high] of examples) {const interval = summarizeRate(n!, y!).interval!; close(interval.low, low!); close(interval.high, high!); assert.equal(interval.method, 'wilson_descriptive');}
});
test('invalid ordering, overlap, unsafe cohort and windows beyond 31 days are rejected', () => {
  assert.throws(() => validateMetric({...metric, windows: {baseline: metric.windows.comparison, comparison: metric.windows.baseline}}), errorCode('INVALID_WINDOWS'));
  assert.throws(() => validateMetric({...metric, cohorts: ['constructor']}), errorCode('INVALID_COHORT'));
  assert.throws(() => validateMetric({...metric, windows: {...metric.windows, baseline: {start: '2026-07-01T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z'}}}), errorCode('WINDOW_LIMIT'));
  assert.throws(() => computeComparison([], metric, {...coverage, event_time_intervals: [{start: coverage.covered_end, end: coverage.covered_start}]}), errorCode('INVALID_COVERAGE'));
});

test('unordered timestamp ties retain first-entry exclusion and deterministic earliest-success identity',()=>{const excluded={...entry('tie-entry','2026-09-01T01:00:00.000001Z','mobile',true),event_id:'a-entry'},later={...excluded,event_id:'z-entry',excluded:false},healthy={...entry('tie-success','2026-09-01T02:00:00.000001Z'),event_id:'healthy-entry'},late={...success('tie-success','2026-09-01T02:01:00.000001Z'),event_id:'z-success'},first={...late,event_id:'a-success'},events=[late,later,healthy,first,excluded];const result=computeComparison(events,metric,coverage);assert.equal(result.baseline!.eligible,1);assert.equal(result.baseline!.converted,1);const samples=previewComparison(events,metric).samples.baseline;assert.equal(samples[0]!.entry_event_id,'a-entry');assert.equal(samples[0]!.excluded,true);assert.equal(samples[1]!.success_event_id,'a-success');});
