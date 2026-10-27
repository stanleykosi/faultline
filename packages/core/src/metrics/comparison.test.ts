import {type Tx} from '../../../database/src/client.js';
import {computePostgresComparison} from './postgres.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {computeComparison, computeMixShift, comparisonEvidenceSummary, previewComparison, summarizeRate, validateMetric} from './comparison.js';
import {normalizeAnalytics} from '../imports/parser.js';
import {normalizeEventTime} from '../imports/time.js';
import {DomainError} from '../errors.js';
import {type FaultlineCanonicalEvent, type FaultlineCoverage, type FaultlineMetric, type FaultlineEvidence} from '../../../contracts/src/generated.js';
import {createHash} from 'node:crypto';
import {projectTimeline, type TimelineCapture, type TimelineWindow} from './timeline.js';
import {baselineAdjustment, requireCurrentMixBinding} from '../captures/mix-adjustment.js';

// comparison
{
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
   const before=structuredClone(result),mix=baselineAdjustment(result,{standard_population:'baseline'});assert.deepEqual(mix,computeMixShift(result));assert.deepEqual(result,before);assert.match(mix.limitations[0]!,/not a causal contribution/); assert.equal(mix.status, 'complete'); close(mix.standardized_rate, expected.standardized_rate); close(mix.within_component_pp, expected.within_component_pp); close(mix.composition_component_pp, expected.composition_component_pp);
   close(mix.within_component_pp! + mix.composition_component_pp!, expected.delta_pp);
   if (fixture === 'regression') close(result.relative_change, -0.45);
 });
 
 test("comparison summaries preserve rates, unknowns and limits on causal claims", () => {
  // model evidence labels baseline, later and standardized conversion as rates, not an adjusted decline
  {
   const events=normalizeAnalytics(fs.readFileSync('fixtures/mix-shift/events.csv'),'csv','synthetic-analytics').events;
      const result=computeComparison(events,read('fixtures/mix-shift/metric.json'),read('fixtures/mix-shift/coverage.json')),before=JSON.stringify(result),text=comparisonEvidenceSummary(result,computeMixShift(result));
      assert.match(text,/baseline 340\/1000 \(rate 0\.34\)/);assert.match(text,/comparison 160\/1000 \(rate 0\.16\)/);
      const rate=Number(text.match(/Comparison conversion rate at baseline cohort weights: ([0-9.]+)/)?.[1]);close(rate,0.34);
      assert.match(text,/percentage points/);assert.match(text,/\(complete\)/);assert.match(text,/aggregate causal effect not established/);
      assert.equal(JSON.stringify(result),before);
  }
  // incomplete evidence never renders absent windows or standardization as zero or a passing result
  {
   const result=computeComparison([],metric,{...coverage,basis:'none'}),text=comparisonEvidenceSummary(result,computeMixShift(result));
      assert.match(text,/baseline unknown; comparison unknown; change unknown/);assert.match(text,/weights: unknown \(inconclusive\)/);
      assert.doesNotMatch(text,/undefined|null|0\/0|\(complete\)/);assert.match(text,/causal effect not established/);
  }
 });

 test("session windows and success horizons retain exact UTC6 boundaries", () => {
  // half-open entry windows preserve one microsecond around boundaries
  {
   const events = [entry('before', '2026-08-31T23:59:59.999999Z'), entry('start', '2026-09-01T00:00:00.000000Z'), entry('last', '2026-09-01T23:59:59.999999Z'), entry('end', '2026-09-02T00:00:00.000000Z')];
      const result = computeComparison(events, metric, coverage);
      assert.equal(result.baseline!.eligible, 2); assert.equal(result.comparison!.eligible, 1);
  }
  // success at inclusive horizon counts, one microsecond after and before entry do not
  {
   const events = [entry('at', '2026-09-01T23:50:00.000000Z'), success('at', '2026-09-02T00:20:00.000000Z'), entry('after', '2026-09-01T01:00:00.000000Z'), success('after', '2026-09-01T01:30:00.000001Z'), entry('before', '2026-09-01T02:00:00.000001Z'), success('before', '2026-09-01T02:00:00.000000Z')];
      const result = computeComparison(events, metric, coverage);
      assert.equal(result.baseline!.eligible, 3); assert.equal(result.baseline!.converted, 1);
  }
  // a session can enter once in each disjoint window
  {
   const events = [entry('same', '2026-09-01T01:00:00Z'), entry('same', '2026-09-02T01:00:00Z'), success('same', '2026-09-02T01:01:00Z')];
      const result = computeComparison(events, metric, coverage); assert.equal(result.baseline!.eligible, 1); assert.equal(result.comparison!.eligible, 1); assert.equal(result.baseline!.converted, 0); assert.equal(result.comparison!.converted, 1);
  }
 });
 
 test("first entry and earliest success determine cohorts, exclusions and deduplication", () => {
  // first entry selection precedes exclusions and preserves entry-time cohort
  {
   const events = [entry('excluded', '2026-09-01T01:00:00Z', 'mobile', true), entry('excluded', '2026-09-01T01:01:00Z', 'mobile', false), success('excluded', '2026-09-01T01:02:00Z'), entry('switch', '2026-09-01T01:00:00Z', 'mobile'), success('switch', '2026-09-01T01:02:00Z', 'desktop')];
      const result = computeComparison(events.reverse(), metric, coverage);
      assert.equal(result.baseline!.eligible, 1); assert.equal(result.baseline!.converted, 1); assert.equal(result.baseline!.strata.mobile!.converted, 1); assert.equal(result.baseline!.strata.desktop!.eligible, 0);
      const preview = previewComparison(events, metric); assert.equal(preview.samples.baseline.find(s => s.session_id === 'excluded')!.excluded, true);
  }
  // duplicate successes contribute once and cross-source same session cannot convert
  {
   const one = success('repeat', '2026-09-01T01:02:00Z');
      const events = [entry('repeat', '2026-09-01T01:00:00Z'), one, one, success('repeat', '2026-09-01T01:03:00Z'), entry('cross', '2026-09-01T02:00:00Z'), success('cross', '2026-09-01T02:01:00Z', 'mobile', 'another-source')];
      const result = computeComparison(events, metric, coverage); assert.equal(result.baseline!.eligible, 2); assert.equal(result.baseline!.converted, 1);
      assert.throws(() => computeComparison([one, {...one, device: 'desktop'}], metric, coverage), errorCode('CONFLICTING_DUPLICATE'));
  }
  // unordered timestamp ties retain first-entry exclusion and deterministic earliest-success identity
  {
   const excluded={...entry('tie-entry','2026-09-01T01:00:00.000001Z','mobile',true),event_id:'a-entry'},later={...excluded,event_id:'z-entry',excluded:false},healthy={...entry('tie-success','2026-09-01T02:00:00.000001Z'),event_id:'healthy-entry'},late={...success('tie-success','2026-09-01T02:01:00.000001Z'),event_id:'z-success'},first={...late,event_id:'a-success'},events=[late,later,healthy,first,excluded];const result=computeComparison(events,metric,coverage);assert.equal(result.baseline!.eligible,1);assert.equal(result.baseline!.converted,1);const samples=previewComparison(events,metric).samples.baseline;assert.equal(samples[0]!.entry_event_id,'a-entry');assert.equal(samples[0]!.excluded,true);assert.equal(samples[1]!.success_event_id,'a-success');
  }
 });

 test('unknown cohorts block authoritative counts while remaining visible in separate preview', () => {
   const events = [entry('unknown', '2026-09-01T01:00:00Z', 'tablet')];
   const result = computeComparison(events, metric, coverage); assert.equal(result.quality, 'incomplete'); assert.equal(result.reason, 'unknown_entry_cohort'); assert.equal(result.baseline, null);
   const preview = previewComparison(events, metric); assert.equal(preview.baseline.eligible, 1); assert.equal(preview.baseline.unknown_cohort_count, 1);
 });
 test("coverage gaps, tails and lateness prevent authoritative counts", () => {
  // coverage gaps cannot be hidden by extrema, missing tail/watermark never passes
  {
   const gap = {...coverage, event_time_intervals: [{start: coverage.covered_start!, end: '2026-09-01T12:00:00.000Z'}, {start: '2026-09-01T12:00:00.001Z', end: coverage.covered_end!}]};
      for (const c of [gap, {...coverage, event_watermark: '2026-09-03T00:29:59.999Z'}, {...coverage, covered_end: '2026-09-03T00:00:00.000Z'}, {...coverage, basis: 'none'}, {...coverage, extraction_status: 'partial'}]) {
        const result = computeComparison([], metric, c); assert.equal(result.quality, 'incomplete'); assert.equal(result.baseline, null); assert.equal(result.delta_pp, null);
      }
      const adjacent = {...coverage, event_time_intervals: [{start: coverage.covered_start!, end: '2026-09-02T00:00:00.000Z'}, {start: '2026-09-02T00:00:00.000Z', end: coverage.covered_end!}]};
      assert.equal(computeComparison([], metric, adjacent).quality, 'complete_attested');
  }
  // lateness assumptions yield provisional results and remain provisional in adjustment
  {
   const assumed = {...coverage, basis: 'lateness_assumption', attestation: 'Events assumed mature after 24 hours', assumptions: ['24-hour lateness']};
      const events = [entry('base', '2026-09-01T01:00:00Z'), success('base', '2026-09-01T01:01:00Z'), entry('after', '2026-09-02T01:00:00Z')];
      const result = computeComparison(events, metric, assumed); assert.equal(result.quality, 'provisional'); assert.equal(computeMixShift(result).status, 'provisional');
      assert.equal(computeComparison(events, metric, {...assumed, attestation: '', assumptions: []}).quality, 'incomplete');
  }
 });
 
 test("rate intervals and mix weights preserve empty populations and reject invented numbers", () => {
  // known empty windows have null rates/intervals and zero baseline rate has undefined relative change
  {
   const empty = computeComparison([], metric, coverage); assert.equal(empty.baseline!.eligible, 0); assert.equal(empty.baseline!.rate, null); assert.equal(empty.baseline!.interval, null); assert.equal(empty.reason, 'known_empty_window');
      const zero = computeComparison([entry('base', '2026-09-01T01:00:00Z'), entry('after', '2026-09-02T01:00:00Z'), success('after', '2026-09-02T01:01:00Z')], metric, coverage);
      assert.equal(zero.baseline!.rate, 0); assert.equal(zero.delta_pp, 100); assert.equal(zero.relative_change, null);
  }
  // mix adjustment requires positive comparison denominators for every positive baseline weight
  {
   const events = [entry('base-mobile', '2026-09-01T01:00:00Z'), entry('base-desktop', '2026-09-01T01:00:00Z', 'desktop'), entry('after', '2026-09-02T01:00:00Z')];
      const result = computeComparison(events, metric, coverage), mix = computeMixShift(result);
      assert.equal(mix.status, 'inconclusive'); assert.deepEqual(mix.missing_comparison_strata, ['desktop']); assert.equal(mix.standardized_rate, null);
  }
  // mix adjustment rejects invented rates rather than copying trusted-looking JSON numbers
  {
   const result = computeComparison([entry('base', '2026-09-01T01:00:00Z'), entry('after', '2026-09-02T01:00:00Z')], metric, coverage);
      const forged = structuredClone(result); forged.baseline!.rate = 0.5;
      assert.throws(() => computeMixShift(forged), errorCode('INVALID_METRIC_RESULT'));
  }
  // Wilson intervals match independent numerical boundary examples
  {
   // Ordinary-sample values are independently supplied in metric-result.example.json.
      const examples = [[10, 0, 0, 0.2775327998628892], [10, 10, 0.7224672001371107, 1], [5, 1, 0.03622410863243014, 0.6244653702374747], [1000, 200, 0.1763770904431985, 0.22591896464813463]];
      for (const [n, y, low, high] of examples) {const interval = summarizeRate(n!, y!).interval!; close(interval.low, low!); close(interval.high, high!); assert.equal(interval.method, 'wilson_descriptive');}
  }
 });

 test('invalid ordering, overlap, unsafe cohort and windows beyond 31 days are rejected', () => {
   assert.throws(() => validateMetric({...metric, windows: {baseline: metric.windows.comparison, comparison: metric.windows.baseline}}), errorCode('INVALID_WINDOWS'));
   assert.throws(() => validateMetric({...metric, cohorts: ['constructor']}), errorCode('INVALID_COHORT'));
   assert.throws(() => validateMetric({...metric, windows: {...metric.windows, baseline: {start: '2026-07-01T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z'}}}), errorCode('WINDOW_LIMIT'));
   assert.throws(() => computeComparison([], metric, {...coverage, event_time_intervals: [{start: coverage.covered_end, end: coverage.covered_start}]}), errorCode('INVALID_COVERAGE'));
 });

 test('PostgreSQL comparison enforces the resource deadline and propagates query failures without counts',async()=>{
  for(const timeout of [true,false]){
   const failure=Object.assign(new Error('authored database failure'),{code:timeout?'57014':'XX000'}),queries:string[]=[];
   const tx={query:async(text:string)=>{queries.push(text);if(queries.length===1)return {rows:[],rowCount:1};throw failure;}} as unknown as Tx;
   await assert.rejects(()=>computePostgresComparison(tx,'workspace','case','snapshot',metric,coverage),error=>timeout?error instanceof DomainError&&error.code==='METRIC_QUERY_TIMEOUT'&&error.status===503:error===failure);
   assert.equal(queries[0],"SELECT set_config('statement_timeout','5000',true)");
   assert.equal(queries.length,2,'Deadline is set before the failing scoped query; failure cannot return fabricated counts.');
  }
 });
}

// timeline
{
 const window: TimelineWindow = {start: '2026-10-01T10:00:00.000Z', end: '2026-10-01T12:00:00.000Z'};
 const span = (start: string, end: string): TimelineWindow => ({start, end});
 function coverage(intervals: TimelineWindow[] = [window], patch: Partial<FaultlineCoverage> = {}): FaultlineCoverage {
   return {extraction_status: 'complete', basis: 'operator_attestation', covered_start: window.start, covered_end: window.end, event_watermark: window.end, attestation: 'Generated declared interval only', event_time_intervals: intervals, ...patch};
 }
 function capture(id = 'snapshot-a', source_kind: TimelineCapture['source_kind'] = 'analytics', value = coverage(), source_id = 'logical-source-test'): TimelineCapture {return {id, source_id, source_kind, content_hash: 'a'.repeat(64), coverage: value};}
 function evidence(id: string, event_time: FaultlineEvidence['event_time'], patch: Partial<FaultlineEvidence> = {}): FaultlineEvidence {
   return {schema_version: 1, id, workspace_id: 'workspace-test', case_id: 'case-test', revision_id: 'revision-test', snapshot_id: 'snapshot-a', source_kind: 'support', source_ref: 'authored:' + id, content_hash: 'e'.repeat(64), event_time, captured_at: '2026-10-10T15:00:00.000Z', text: 'Authored untrusted text <script>not executed</script>', redaction_status: 'restricted', evidence_status: 'user_attested', supersedes_id: null, artifact_refs: [], ...patch};
 }
 const exact = (at: string): FaultlineEvidence['event_time'] => ({kind: 'exact', at});
 const unknown: FaultlineEvidence['event_time'] = {kind: 'unknown', raw_description: 'Reported occurrence is unknown'};
 const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
 const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
 const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
 
 test("timeline uses exact occurrence, source filters and explicit unknown categories", () => {
  // exact occurrence includes the half-open UTC6 edges and never uses capture time
  {
   const rows = [evidence('before', exact('2026-10-01T09:59:59.999999Z')), evidence('start', exact('2026-10-01T10:00:00.000000Z')), evidence('last', exact('2026-10-01T11:59:59.999999Z')), evidence('end', exact('2026-10-01T12:00:00.000000Z'))];
      const result = projectTimeline({window, captures: [], evidence: rows.reverse()});
      assert.deepEqual(result.known_occurrence.map(row => row.id), ['start', 'last']); assert.equal(result.unknown_occurrence.length, 0);
      const saved = result.known_occurrence[1]!; assert.deepEqual(saved.event_time, exact('2026-10-01T11:59:59.999999Z')); assert.equal(saved.captured_at, '2026-10-10T15:00:00.000Z'); assert.equal(saved.content_hash, 'e'.repeat(64)); assert.equal(saved.snapshot_id, 'snapshot-a'); assert.equal(saved.source_ref, 'authored:last'); assert.equal(saved.redaction_status, 'restricted'); assert.equal(saved.evidence_status, 'user_attested'); assert.equal(saved.temporal_relation, 'overlaps_selected_interval'); assert.equal(saved.cohort_relation, 'not_established'); assert.equal(saved.text, rows.find(row => row.id === 'last')!.text);
  }
  // ranges overlap by actual UTC6 half-open occurrence while unknowns remain separate even outside capture window
  {
   const enclosing = {kind: 'range', start: '2026-10-01T09:00:00.000001Z', end: '2026-10-01T13:00:00.000002Z'} as const;
      const result = projectTimeline({window, captures: [], evidence: [evidence('encloses', enclosing), evidence('touch-left', {kind: 'range', start: '2026-10-01T09:00:00.000000Z', end: '2026-10-01T10:00:00.000000Z'}), evidence('touch-right', {kind: 'range', start: '2026-10-01T12:00:00.000000Z', end: '2026-10-01T13:00:00.000000Z'}), evidence('one-micro-overlap', {kind: 'range', start: '2026-10-01T09:59:59.999999Z', end: '2026-10-01T10:00:00.000001Z'}), evidence('unknown-inside-capture', unknown, {captured_at: window.start}), evidence('unknown-late-capture', unknown)]});
      assert.deepEqual(result.known_occurrence.map(row => row.id), ['encloses', 'one-micro-overlap']); assert.deepEqual(result.known_occurrence[0]!.event_time, enclosing, 'Keep the original uncertain range, not the clipped display window.'); assert.deepEqual(result.unknown_occurrence.map(row => row.id), ['unknown-inside-capture', 'unknown-late-capture']);
      assert.ok(result.unknown_occurrence.every(row => row.event_time.kind === 'unknown' && row.temporal_relation === 'occurrence_unknown' && row.cohort_relation === 'not_established'));
  }
  // withdrawn records are excluded; finite source filter affects evidence but preserves all three coverage categories
  {
   const captures = [capture('analytics'), capture('release', 'release')], rows = [evidence('support', exact('2026-10-01T10:00:00.000000Z')), evidence('release', unknown, {source_kind: 'release'}), evidence('withdrawn', exact('2026-10-01T11:00:00.000000Z'), {source_kind: 'release', redaction_status: 'withdrawn'}), evidence('human', unknown, {source_kind: 'human_note', snapshot_id: null})];
      const result = projectTimeline({window, captures, evidence: rows, source_kind: 'release'});
      assert.deepEqual(result.known_occurrence, []); assert.deepEqual(result.unknown_occurrence.map(row => row.id), ['release']); assert.deepEqual(result.sources.map(row => row.source_kind), ['analytics', 'support', 'release']); assert.equal(result.sources[0]!.status, 'complete_attested'); assert.equal(result.sources[1]!.status, 'unavailable'); assert.equal(result.sources[2]!.status, 'complete_attested'); assert.equal(result.coverage_hash, projectTimeline({window, captures, evidence: rows}).coverage_hash);
      assert.throws(() => projectTimeline({window, captures, evidence: rows, source_kind: 'https://untrusted.test' as any}), code('TIMELINE_SOURCE_KIND'));
  }
 });

 test("timeline interval unions preserve gaps independently for each logical source", () => {
  // touching, overlapping and out-of-window declarations union and clamp without day-by-day loops
  {
   const captures = [capture('z', 'analytics', coverage([span('2026-10-01T11:00:00.000Z', '2026-10-01T13:00:00.000Z')])), capture('a', 'analytics', coverage([span('2026-10-01T09:00:00.000Z', '2026-10-01T11:00:00.000Z'), span('2026-10-01T10:30:00.000Z', '2026-10-01T11:30:00.000Z')]))];
      const source = projectTimeline({window, captures, evidence: []}).sources[0]!;
      assert.equal(source.status, 'complete_attested'); assert.deepEqual(source.covered_intervals, [window]); assert.equal(source.covered_interval_count, 1); assert.equal(source.covered_intervals_truncated, false); assert.deepEqual(source.gaps, []); assert.equal(source.gap_count, 0); assert.equal(source.gaps_truncated, false); assert.deepEqual(source.snapshot_ids, ['a', 'z']); assert.deepEqual(source.basis, ['operator_attestation']);
      const huge = {start: '0001-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.999Z'};
      const long = projectTimeline({window: huge, captures: [capture('long', 'analytics', coverage([huge], {covered_start: huge.start, covered_end: huge.end, event_watermark: huge.end}))], evidence: []}).sources[0]!;
      assert.equal(long.status, 'complete_attested'); assert.deepEqual(long.covered_intervals, [huge]); assert.equal(long.gap_count, 0);
  }
  // disjoint intervals preserve exact gaps despite full-range extrema or watermark
  {
   const intervals = [span('2026-10-01T10:10:00.000Z', '2026-10-01T10:30:00.000Z'), span('2026-10-01T11:00:00.000Z', '2026-10-01T11:45:00.000Z')];
      const projection = projectTimeline({window, captures: [capture('gap', 'support', coverage(intervals))], evidence: []}), source = projection.sources[1]!;
      assert.equal(source.status, 'partial'); assert.deepEqual(source.covered_intervals, intervals); assert.deepEqual(source.gaps, [span(window.start, '2026-10-01T10:10:00.000Z'), span('2026-10-01T10:30:00.000Z', '2026-10-01T11:00:00.000Z'), span('2026-10-01T11:45:00.000Z', window.end)]); assert.equal(source.gap_count, 3); assert.ok(source.limitations.some(value => value.includes('do not establish absence')));
      assert.ok(projection.limitations.includes('support has 3 uncovered intervals; missing records there do not establish absence of events.')); assert.ok(projection.limitations.includes('analytics has no usable declared event-time coverage for this interval; collection and event absence are unknown.'));
  }
  // distinct logical sources cannot fill each other's missing intervals to establish complete capture
  {
   const middle = '2026-10-01T11:00:00.000Z', captures = [capture('first', 'analytics', coverage([span(window.start, middle)]), 'source-a'), capture('second', 'analytics', coverage([span(middle, window.end)]), 'source-b')];
      const result = projectTimeline({window, captures, evidence: []}), source = result.sources[0]!; assert.equal(source.status, 'partial'); assert.deepEqual(source.source_ids, ['source-a', 'source-b']); assert.deepEqual(source.covered_intervals, [window]); assert.equal(source.gap_count, 0); assert.ok(result.limitations.some(value => value.includes('distinct logical sources cannot fill one another\'s uncaptured intervals')));
      const sameSource = projectTimeline({window, captures: captures.map(value => ({...value, source_id: 'source-a'})), evidence: []}); assert.equal(sameSource.sources[0]!.status, 'complete_attested'); assert.deepEqual(sameSource.sources[0]!.source_ids, ['source-a']); assert.notEqual(result.coverage_hash, sameSource.coverage_hash);
  }
 });

 test("timeline coverage distinguishes empty, uncaptured, provisional and immature inputs", () => {
  // declared known-empty timeline differs from uncaptured, none-basis and received-only data
  {
   const empty = projectTimeline({window, captures: [capture()], evidence: []}); assert.deepEqual(empty.known_occurrence, []); assert.equal(empty.sources[0]!.status, 'complete_attested'); assert.equal(empty.sources[0]!.gap_count, 0);
      for (const captures of [[], [capture('none', 'analytics', coverage([window], {basis: 'none'}))], [capture('received', 'analytics', coverage([], {received_time_intervals: [window]}))], [capture('outside', 'analytics', coverage([span('2026-10-01T12:00:00.000Z', '2026-10-01T13:00:00.000Z')]))]]) {
        const source = projectTimeline({window, captures, evidence: []}).sources[0]!; assert.equal(source.status, 'unavailable'); assert.deepEqual(source.covered_intervals, []); assert.equal(source.covered_interval_count, 0); assert.deepEqual(source.gaps, [window]); assert.equal(source.gap_count, 1); assert.ok(source.limitations.some(value => value.includes('unknown')));
      }
  }
  // partial/unknown extraction never becomes complete; lateness remains provisional with full union
  {
   for (const extraction_status of ['partial', 'unknown'] as const) {const source = projectTimeline({window, captures: [capture('incomplete', 'analytics', coverage([window], {extraction_status}))], evidence: []}).sources[0]!; assert.equal(source.status, 'partial'); assert.equal(source.gap_count, 0);}
      const assumed = capture('assumed', 'analytics', coverage([window], {basis: 'lateness_assumption', assumptions: ['Owner-assumed lateness, not source proof']})), guaranteed = capture('guaranteed', 'analytics', coverage([window], {basis: 'source_guarantee'}));
      assert.equal(projectTimeline({window, captures: [assumed], evidence: []}).sources[0]!.status, 'provisional'); assert.equal(projectTimeline({window, captures: [assumed, guaranteed], evidence: []}).sources[0]!.status, 'provisional'); assert.equal(projectTimeline({window, captures: [guaranteed], evidence: []}).sources[0]!.status, 'complete_attested');
      assert.equal(projectTimeline({window, captures: [assumed, capture('partial', 'analytics', coverage([window], {extraction_status: 'partial'}))], evidence: []}).sources[0]!.status, 'partial');
  }
  // watermarks bound mature coverage and absent basis qualifications cannot receive complete-attested status
  {
   const missing = projectTimeline({window, captures: [capture('missing-watermark', 'analytics', coverage([window], {event_watermark: null}))], evidence: []});
      assert.equal(missing.sources[0]!.status, 'unavailable'); assert.deepEqual(missing.sources[0]!.covered_intervals, []); assert.deepEqual(missing.sources[0]!.gaps, [window]); assert.ok(missing.limitations.some(value => value.includes('have no event watermark')));
      const early = '2026-10-01T11:30:00.000Z', tail = span(early, window.end), projected = projectTimeline({window, captures: [capture('early-watermark', 'support', coverage([window], {event_watermark: early}))], evidence: []});
      assert.equal(projected.sources[1]!.status, 'partial'); assert.deepEqual(projected.sources[1]!.covered_intervals, [span(window.start, early)]); assert.deepEqual(projected.sources[1]!.gaps, [tail]); assert.ok(projected.limitations.some(value => value.includes('early event watermark'))); assert.ok(projected.limitations.includes('support has 1 uncovered intervals; missing records there do not establish absence of events.'));
      const missingStatements: Partial<FaultlineCoverage>[] = [{attestation: '   '}, {basis: 'lateness_assumption', attestation: '', assumptions: []}];
      for (const patch of missingStatements) {
        const result = projectTimeline({window, captures: [capture('missing-statement', 'analytics', coverage([window], patch))], evidence: []}); assert.equal(result.sources[0]!.status, 'partial'); assert.equal(result.sources[0]!.gap_count, 0); assert.ok(result.limitations.some(value => value.includes('statement is missing')));
      }
      assert.equal(projectTimeline({window, captures: [capture('attested-lateness', 'analytics', coverage([window], {basis: 'lateness_assumption', assumptions: [], attestation: 'Declared 24-hour lateness assumption'}))], evidence: []}).sources[0]!.status, 'provisional');
  }
 });

 test("timeline bounds and canonical hashes retain every limitation and immutable declaration", () => {
  // union/gap display overflow is explicit and status uses all declarations rather than returned prefix
  {
   const start = Date.parse('2026-10-01T00:00:00.000Z'), at = (ms: number) => new Date(start + ms).toISOString(), bounds = span(at(0), at(301));
      const intervals = Array.from({length: 150}, (_, n) => span(at(2 * n + 1), at(2 * n + 2))), captures = [capture('first', 'analytics', coverage(intervals.slice(0, 100), {covered_start: bounds.start, covered_end: bounds.end})), capture('second', 'analytics', coverage(intervals.slice(100), {covered_start: bounds.start, covered_end: bounds.end}))];
      const source = projectTimeline({window: bounds, captures, evidence: []}).sources[0]!; assert.equal(source.status, 'partial'); assert.equal(source.covered_interval_count, 150); assert.equal(source.covered_intervals.length, 100); assert.equal(source.covered_intervals_truncated, true); assert.equal(source.gap_count, 151); assert.equal(source.gaps.length, 100); assert.equal(source.gaps_truncated, true); assert.deepEqual(source.covered_intervals[99], intervals[99]); assert.deepEqual(source.gaps[0], span(at(0), at(1))); assert.ok(source.limitations.some(value => value.includes('status use every')));
  }
  // finite bounds reject oversized, malformed, duplicate and unsafe wire inputs
  {
   const captures = Array.from({length: 100}, (_, n) => capture('capture-' + n)), rows = Array.from({length: 100}, (_, n) => evidence('evidence-' + n, unknown));
      assert.equal(projectTimeline({window, captures, evidence: rows}).unknown_occurrence.length, 100);
      assert.throws(() => projectTimeline({window, captures: [...captures, capture('extra')], evidence: []}), code('TIMELINE_LIMIT')); assert.throws(() => projectTimeline({window, captures: [], evidence: [...rows, evidence('extra', unknown)]}), code('TIMELINE_LIMIT'));
      for (const input of [{window, captures: [capture(), capture()], evidence: []}, {window, captures: [], evidence: [rows[0]!, rows[0]!]}]) assert.throws(() => projectTimeline(input), code('TIMELINE_DUPLICATE_INPUT'));
      assert.throws(() => projectTimeline({window: {start: window.end, end: window.start}, captures: [], evidence: []}), code('TIMELINE_INTERVAL'));
      assert.throws(() => projectTimeline({window: {...window, start: '2026-10-01T10:00:00.000000Z'}, captures: [], evidence: []}), code('INVALID_TIMESTAMP'));
      assert.throws(() => projectTimeline({window, captures: [capture('invalid', 'analytics', coverage([span(window.end, window.start)]))], evidence: []}), code('TIMELINE_INTERVAL'));
      assert.throws(() => projectTimeline({window, captures: [capture('invalid', 'analytics', coverage([], {received_time_intervals: [span(window.end, window.start)]}))], evidence: []}), code('TIMELINE_INTERVAL'));
      assert.throws(() => projectTimeline({window, captures: [], evidence: [evidence('invalid', {kind: 'range', start: '2026-10-01T11:00:00.000000Z', end: '2026-10-01T10:00:00.000000Z'})]}), code('TIMELINE_INTERVAL'));
      assert.throws(() => projectTimeline({window, captures: [{...capture(), source_kind: 'human_note' as any}], evidence: []}), code('TIMELINE_CAPTURE'));
      assert.throws(() => projectTimeline({window, captures: [{...capture(), content_hash: 'not-a-hash'}], evidence: []}), code('TIMELINE_CAPTURE'));
      assert.throws(() => projectTimeline({window, captures: [{...capture(), source_id: '../../untrusted'}], evidence: []}), code('TIMELINE_CAPTURE'));
      assert.throws(() => projectTimeline({window, captures: [], evidence: [], transform: 'execute()'} as any), code('TIMELINE_INPUT'));
      assert.throws(() => projectTimeline({window, captures: Array(1), evidence: []}), code('TIMELINE_INPUT'));
      assert.throws(() => projectTimeline({window, captures: [capture('deep', 'analytics', coverage(Array.from({length: 101}, () => window)))], evidence: []}));
  }
  // coverage hash is canonical, ordering-independent and binds selected window and exact immutable declarations without exposing raw attestation
  {
   const secretDeclaration = 'RAW_ATTESTATION_DO_NOT_PROJECT <script>untrusted()</script>', captures = [capture('z', 'release', coverage([window], {attestation: secretDeclaration})), capture('a')], input = {window, captures, evidence: []};
      const result = projectTimeline(input); assert.equal(result.coverage_hash, digest({window, captures: [captures[1], captures[0]], sources: result.sources})); assert.equal(result.coverage_hash, projectTimeline({...input, captures: [...captures].reverse()}).coverage_hash); assert.equal(JSON.stringify(result).includes(secretDeclaration), false);
      for (const changed of [{...input, window: {...window, end: '2026-10-01T11:59:59.999Z'}}, {...input, captures: [captures[0]!, {...captures[1]!, content_hash: 'b'.repeat(64)}]}, {...input, captures: [captures[0]!, {...captures[1]!, coverage: {...captures[1]!.coverage, attestation: 'Changed declaration'}}]}]) assert.notEqual(projectTimeline(changed).coverage_hash, result.coverage_hash);
      assert.ok(result.limitations.length <= 20); assert.equal(new Set(result.limitations).size, result.limitations.length); assert.ok(result.limitations.every(value => value.length > 0 && value.length <= 2000)); assert.ok(result.sources.every(source => source.limitations.every(value => result.limitations.includes(value)))); assert.ok(result.limitations.some(value => value.includes('aggregate causal effect are not established')));
      const before = JSON.stringify(input); result.sources[0]!.snapshot_ids.push('cannot-mutate-input'); assert.equal(JSON.stringify(input), before);
  }
  // all source qualification, watermark, exclusion and truncated-gap warnings remain in the bounded shared limitations
  {
   const start = Date.parse('2026-10-01T00:00:00.000Z'), at = (ms: number) => new Date(start + ms).toISOString(), bounds = span(at(0), at(301)), intervals = Array.from({length: 150}, (_, n) => span(at(2 * n + 1), at(2 * n + 2)));
      const captures = (['analytics', 'support', 'release'] as const).flatMap(kind => {
        const patch: Partial<FaultlineCoverage> = {covered_start: bounds.start, covered_end: bounds.end, extraction_status: 'partial', basis: 'lateness_assumption', attestation: '', assumptions: [], event_watermark: at(200)};
        return [capture(kind + '-first', kind, coverage(intervals.slice(0, 100), patch)), capture(kind + '-second', kind, coverage(intervals.slice(100), patch)), capture(kind + '-missing', kind, coverage([bounds], {...patch, event_watermark: null}))];
      });
      const result = projectTimeline({window: bounds, captures, evidence: []}); assert.equal(result.limitations.length, 18); assert.equal(new Set(result.limitations).size, 18); assert.ok(result.limitations.every(value => value.length <= 2000));
      for (const source of result.sources) {assert.equal(source.status, 'partial'); assert.equal(source.gap_count, 101); assert.equal(source.gaps_truncated, true); assert.equal(source.limitations.length, 5); assert.ok(source.limitations.every(value => result.limitations.includes(value)));}
  }
 });

}

// mix adjustment
{
 const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
 
 test("baseline adjustment rejects invalid populations, incomplete data and stale source bindings", () => {
  // forged populations and additional fields are rejected before calculation
  {
   for(const input of [{standard_population:'comparison'},{standard_population:'baseline',weights:{mobile:1}},{}])assert.throws(()=>baselineAdjustment({},input as never),error=>error instanceof Error&&'code'in error&&error.code==='INVALID_POPULATION');
  }
  // incomplete comparison preserves unknown standardization rather than a passing status
  {
   const events=normalizeAnalytics(fs.readFileSync('fixtures/mix-shift/events.csv'),'csv','synthetic-analytics').events,result=computeComparison(events,read('fixtures/mix-shift/metric.json'),{...read('fixtures/mix-shift/coverage.json'),basis:'none'}),mix=baselineAdjustment(result,{standard_population:'baseline'});
     assert.equal(mix.status,'inconclusive');assert.equal(mix.reason,'incomplete_comparison');assert.equal(mix.standardized_rate,null);assert.equal(mix.within_component_pp,null);assert.equal(mix.composition_component_pp,null);
  }
  // stale revision, hash changes and nonsucceeded source jobs cannot authorize standardization
  {
   const bound={comparison_revision_id:'r',current_revision_id:'r',comparison_metric_hash:'m',current_metric_hash:'m',comparison_snapshot_hash:'s',current_snapshot_hash:'s',source_job_status:'succeeded'};assert.doesNotThrow(()=>requireCurrentMixBinding(bound));
     for(const patch of [{current_revision_id:'old'},{current_metric_hash:'other'},{current_snapshot_hash:'other'},...['running','failed','cancelled','waiting_for_input'].map(source_job_status=>({source_job_status}))])assert.throws(()=>requireCurrentMixBinding({...bound,...patch}),error=>error instanceof Error&&'code'in error&&error.code==='STALE_INPUTS');
  }
 });

}
