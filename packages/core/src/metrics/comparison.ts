import {hash} from '../canonical.js';
import {demand} from '../errors.js';
import {eventMicros, metadataMicros} from '../imports/time.js';
import {validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineCanonicalEvent, FaultlineCoverage, FaultlineMetric, FaultlineMetricResult} from '../../../contracts/src/generated.js';

export type RateSummary = Pick<NonNullable<FaultlineMetricResult['baseline']>, 'eligible' | 'converted' | 'rate' | 'interval'>;
export type WindowSummary = NonNullable<FaultlineMetricResult['baseline']>;
export interface CountedSession {session_id: string; entry_event_id: string; entry_at: string; device: string; excluded: boolean; converted: boolean; success_event_id: string | null;}
export interface ComparisonPreview {baseline: WindowSummary; comparison: WindowSummary; samples: {baseline: CountedSession[]; comparison: CountedSession[]}; limitations: string[];}
const HORIZON = 1_800_000_000n;
const MAX_WINDOW = 31n * 24n * 60n * 60n * 1_000_000n;
const safeCohort = /^[A-Za-z0-9_-]{1,64}$/;

export function validateMetric(value: unknown): FaultlineMetric {
  const metric = validateContract<FaultlineMetric>('metric', value);
  for (const cohort of metric.cohorts) demand(safeCohort.test(cohort) && !['__proto__', 'constructor', 'prototype'].includes(cohort), 'INVALID_COHORT', 'Cohorts must be safe explicit category names');
  const b = metric.windows.baseline, c = metric.windows.comparison;
  const bs = metadataMicros(b.start), be = metadataMicros(b.end), cs = metadataMicros(c.start), ce = metadataMicros(c.end);
  demand(bs < be && cs < ce && be <= cs, 'INVALID_WINDOWS', 'Baseline must precede comparison; windows must be positive and nonoverlapping');
  demand(be - bs <= MAX_WINDOW && ce - cs <= MAX_WINDOW, 'WINDOW_LIMIT', 'Each metric window must be no more than 31 days');
  return metric;
}
export function summarizeRate(eligible: number, converted: number): RateSummary {
  demand(Number.isSafeInteger(eligible) && Number.isSafeInteger(converted) && eligible >= 0 && converted >= 0 && converted <= eligible, 'INVALID_COUNTS', 'Invalid conversion numerator/denominator');
  if (eligible === 0) return {eligible, converted, rate: null, interval: null};
  const rate = converted / eligible, z = 1.959963984540054, z2 = z * z;
  const denominator = 1 + z2 / eligible;
  const center = (rate + z2 / (2 * eligible)) / denominator;
  const width = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * eligible)) / eligible) / denominator;
  return {eligible, converted, rate, interval: {low: Math.max(0, center - width), high: Math.min(1, center + width), level: 0.95, method: 'wilson_descriptive'}};
}
interface TimedEvent {event:FaultlineCanonicalEvent;time:bigint;}
function indexEvents(events:readonly FaultlineCanonicalEvent[],metric:FaultlineMetric){
 const sources=new Map<string,Map<string,FaultlineCanonicalEvent>>(),baseline=new Map<string,TimedEvent>(),comparison=new Map<string,TimedEvent>(),successes=new Map<string,TimedEvent[]>();
 const windows=[{start:metadataMicros(metric.windows.baseline.start),end:metadataMicros(metric.windows.baseline.end),entries:baseline},{start:metadataMicros(metric.windows.comparison.start),end:metadataMicros(metric.windows.comparison.end),entries:comparison}];
 for(const value of events){const event=validateContract<FaultlineCanonicalEvent>('canonical-event',value),time=eventMicros(event.occurred_at);let records=sources.get(event.source_id);if(!records){records=new Map();sources.set(event.source_id,records);}const p=records.get(event.event_id);
  if(p){demand(p.session_id===event.session_id&&p.event_name===event.event_name&&p.occurred_at===event.occurred_at&&p.device===event.device&&p.excluded===event.excluded&&p.release_id===event.release_id,'CONFLICTING_DUPLICATE','Conflicting source/event content prevents a trusted comparison');continue;}records.set(event.event_id,event);if(event.source_id!==metric.source_id)continue;
  if(event.event_name===metric.entry_event)for(const window of windows)if(time>=window.start&&time<window.end){const prior=window.entries.get(event.session_id);if(!prior||time<prior.time||time===prior.time&&event.event_id<prior.event.event_id)window.entries.set(event.session_id,{event,time});}
  if(event.event_name===metric.success_event){const list=successes.get(event.session_id)??[];list.push({event,time});successes.set(event.session_id,list);}
 }
 return{baseline,comparison,successes};
}
function countWindow(entries:ReadonlyMap<string,TimedEvent>,successes:ReadonlyMap<string,TimedEvent[]>,metric:FaultlineMetric,sampleLimit:number):{summary:WindowSummary;samples:CountedSession[]} {
  const counts = Object.fromEntries(metric.cohorts.map(c => [c, {eligible: 0, converted: 0}])) as Record<string, {eligible: number; converted: number}>;
  let eligible = 0, converted = 0, unknown = 0;
  const samples: CountedSession[] = [];
  const selected=sampleLimit>0?[...entries.values()].sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:a.event.event_id<b.event.event_id?-1:a.event.event_id>b.event.event_id?1:0):entries.values();
  for (const timed of selected) {
    const entry=timed.event,instant=timed.time,upper=instant+HORIZON;
    let success:TimedEvent|undefined;for(const candidate of successes.get(entry.session_id)??[])if(candidate.time>=instant&&candidate.time<=upper&&(!success||candidate.time<success.time||candidate.time===success.time&&candidate.event.event_id<success.event.event_id))success=candidate;
    if (samples.length < sampleLimit) samples.push({session_id: entry.session_id, entry_event_id: entry.event_id, entry_at: entry.occurred_at, device: entry.device, excluded: entry.excluded, converted: !entry.excluded && Boolean(success), success_event_id: !entry.excluded && success ? success.event.event_id : null});
    if (entry.excluded) continue;
    eligible++; if (success) converted++;
    const stratum = counts[entry.device];
    if (stratum && Object.hasOwn(counts, entry.device)) {stratum.eligible++; if (success) stratum.converted++;}
    else unknown++;
  }
  return {summary: {...summarizeRate(eligible, converted), strata: Object.fromEntries(metric.cohorts.map(c => [c, summarizeRate(counts[c]!.eligible, counts[c]!.converted)])), unknown_cohort_count: unknown}, samples};
}
export function previewComparison(events: readonly FaultlineCanonicalEvent[], metricValue: unknown, sampleLimit = 20): ComparisonPreview {
  demand(Number.isSafeInteger(sampleLimit) && sampleLimit >= 0 && sampleLimit <= 100, 'INVALID_SAMPLE_LIMIT', 'Preview samples must be bounded to 100');
  const metric=validateMetric(metricValue),index=indexEvents(events,metric),baseline=countWindow(index.baseline,index.successes,metric,sampleLimit),comparison=countWindow(index.comparison,index.successes,metric,sampleLimit);
  const limitations = ['Diagnostic counts do not establish event-time completeness.', 'Wilson intervals describe observed session outcomes under a working independence assumption.'];
  if (baseline.summary.unknown_cohort_count || comparison.summary.unknown_cohort_count) limitations.push('Unknown entry-time cohorts block authoritative comparison until the mapping is corrected.');
  return {baseline: baseline.summary, comparison: comparison.summary, samples: {baseline: baseline.samples, comparison: comparison.samples}, limitations};
}
export function intervalUnionCovers(intervals: readonly {start: string; end: string}[], start: bigint, end: bigint): boolean {
  const spans = intervals.map(i => {const s = metadataMicros(i.start), e = metadataMicros(i.end); demand(s < e, 'INVALID_COVERAGE', 'Coverage intervals must be positive'); return {s, e};}).sort((a, b) => a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
  let through = start;
  for (const span of spans) {
    if (span.e <= through) continue;
    if (span.s > through) return false;
    through = span.e;
    if (through >= end) return true;
  }
  return false;
}
export function assessCoverage(metricValue: unknown, coverageValue: unknown): {quality: FaultlineMetricResult['quality']; reason?: string} {
  const metric = validateMetric(metricValue), coverage = validateContract<FaultlineCoverage>('coverage', coverageValue);
  // Validate every declared interval, including those outside the selected metric windows.
  for (const interval of [...coverage.event_time_intervals, ...(coverage.received_time_intervals ?? [])]) demand(metadataMicros(interval.start) < metadataMicros(interval.end), 'INVALID_COVERAGE', 'Coverage intervals must be positive');
  if (coverage.extraction_status !== 'complete') return {quality: 'incomplete', reason: 'extraction_not_complete'};
  if (coverage.basis === 'none') return {quality: 'incomplete', reason: 'no_completeness_basis'};
  if (coverage.basis === 'operator_attestation' && !coverage.attestation.trim()) return {quality: 'incomplete', reason: 'missing_operator_attestation'};
  if (coverage.basis === 'lateness_assumption' && !(coverage.assumptions?.some(a => a.trim()) || coverage.attestation.trim())) return {quality: 'incomplete', reason: 'missing_lateness_assumption'};
  if (coverage.covered_start === null || coverage.covered_end === null || coverage.event_watermark === null) return {quality: 'incomplete', reason: 'missing_event_time_coverage'};
  const coveredStart = metadataMicros(coverage.covered_start), coveredEnd = metadataMicros(coverage.covered_end), watermark = metadataMicros(coverage.event_watermark);
  demand(coveredStart < coveredEnd, 'INVALID_COVERAGE', 'Coverage summary range must be positive');
  for (const window of [metric.windows.baseline, metric.windows.comparison]) {
    const start = metadataMicros(window.start), tail = metadataMicros(window.end) + HORIZON;
    if (coveredStart > start || coveredEnd < tail || watermark < tail) return {quality: 'incomplete', reason: 'missing_window_or_observation_tail'};
    if (!intervalUnionCovers(coverage.event_time_intervals, start, tail)) return {quality: 'incomplete', reason: 'event_time_coverage_gap'};
  }
  return {quality: coverage.basis === 'lateness_assumption' ? 'provisional' : 'complete_attested'};
}
export function computeComparison(events:readonly FaultlineCanonicalEvent[],metricValue:unknown,coverageValue:unknown):FaultlineMetricResult{const metric=validateMetric(metricValue);return computeCountedComparison(previewComparison(events,metric,0),metric,coverageValue);}
export function computeCountedComparison(preview:Pick<ComparisonPreview,'baseline'|'comparison'>,metricValue:unknown,coverageValue:unknown): FaultlineMetricResult {
  const metric = validateMetric(metricValue), coverage = validateContract<FaultlineCoverage>('coverage', coverageValue);
  const assessment=assessCoverage(metric,coverage);
  const base = {metric_hash: hash(metric), quality: assessment.quality, basis: coverage.basis};
  const incomplete = (reason: string) => validateContract<FaultlineMetricResult>('metric-result', {...base, quality: 'incomplete', baseline: null, comparison: null, delta_pp: null, relative_change: null, reason});
  if (assessment.quality === 'incomplete') return incomplete(assessment.reason!);
  if (preview.baseline.unknown_cohort_count || preview.comparison.unknown_cohort_count) return incomplete('unknown_entry_cohort');
  const b = preview.baseline.rate, c = preview.comparison.rate;
  const result: FaultlineMetricResult = {...base, baseline: preview.baseline, comparison: preview.comparison, delta_pp: b === null || c === null ? null : 100 * (c - b), relative_change: b === null || b === 0 || c === null ? null : c / b - 1};
  if (b === null || c === null) result.reason = 'known_empty_window';
  else if (b === 0) result.reason = 'zero_baseline_rate_relative_change_undefined';
  return validateContract<FaultlineMetricResult>('metric-result', result);
}
export interface MixShiftResult {
  status: 'complete' | 'provisional' | 'inconclusive';
  metric_hash: string; result_hash: string;
  standardized_rate: number | null; within_component_pp: number | null; composition_component_pp: number | null;
  baseline_weights: Record<string, number>;
  missing_comparison_strata: string[];
  comparison_only_strata: string[];
  limitations: string[];
  reason?: string;
}
/** Display the computed rate with its population/window, never as an unlabeled
 * "standardization" number that can be mistaken for a change or causal effect. */
export function comparisonEvidenceSummary(result:FaultlineMetricResult,mix:MixShiftResult):string {
  const window=(value:FaultlineMetricResult['baseline'])=>value?`${value.converted}/${value.eligible} (rate ${value.rate??'unknown'})`:'unknown';
  return `Session conversion: baseline ${window(result.baseline)}; comparison ${window(result.comparison)}; change ${result.delta_pp??'unknown'} percentage points. Comparison conversion rate at baseline cohort weights: ${mix.standardized_rate??'unknown'} (${mix.status}). Descriptive association; aggregate causal effect not established.`;
}
export function computeMixShift(resultValue: unknown): MixShiftResult {
  const result = validateContract<FaultlineMetricResult>('metric-result', resultValue);
  const base: MixShiftResult = {status: 'inconclusive', metric_hash: result.metric_hash, result_hash: hash(result), standardized_rate: null, within_component_pp: null, composition_component_pp: null, baseline_weights: {}, missing_comparison_strata: [], comparison_only_strata: [], limitations: ['Baseline-mix standardization is a descriptive accounting identity, not a causal contribution.']};
  if (result.quality === 'incomplete' || !result.baseline || !result.comparison) return {...base, reason: 'incomplete_comparison'};
  const b = result.baseline, c = result.comparison;
  for (const side of [b, c]) {
    summarizeRate(side.eligible, side.converted);
    demand(side.converted <= side.eligible && side.unknown_cohort_count === 0 && Object.values(side.strata).reduce((n, s) => n + s.eligible, 0) === side.eligible && Object.values(side.strata).reduce((n, s) => n + s.converted, 0) === side.converted, 'INVALID_METRIC_RESULT', 'Mix shift requires consistent complete strata and aggregate counts');
    for (const stratum of Object.values(side.strata)) {const expected = summarizeRate(stratum.eligible, stratum.converted); demand(stratum.rate === expected.rate, 'INVALID_METRIC_RESULT', 'Stratum rate differs from deterministic counts');}
    demand(side.rate === summarizeRate(side.eligible, side.converted).rate, 'INVALID_METRIC_RESULT', 'Aggregate rate differs from deterministic counts');
  }
  if (b.rate === null || c.rate === null || !b.eligible) return {...base, reason: 'known_empty_window'};
  let standardized = 0;
  for (const [cohort, stratum] of Object.entries(b.strata)) {
    const weight = stratum.eligible / b.eligible;
    base.baseline_weights[cohort] = weight;
    if (!weight) continue;
    const comparison = c.strata[cohort];
    if (!comparison || comparison.rate === null || comparison.eligible === 0) base.missing_comparison_strata.push(cohort);
    else standardized += weight * comparison.rate;
  }
  base.comparison_only_strata = Object.keys(c.strata).filter(k => c.strata[k]!.eligible > 0 && (!b.strata[k] || b.strata[k]!.eligible === 0));
  if (base.missing_comparison_strata.length) return {...base, reason: 'missing_comparison_strata'};
  if (base.comparison_only_strata.length) base.limitations.push('Comparison-only cohorts remain in the observed aggregate and have zero baseline reference weight.');
  return {...base, status: result.quality === 'provisional' ? 'provisional' : 'complete', standardized_rate: standardized, within_component_pp: 100 * (standardized - b.rate), composition_component_pp: 100 * (c.rate - standardized)};
}
