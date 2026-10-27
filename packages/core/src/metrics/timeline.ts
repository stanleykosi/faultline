import type {FaultlineCoverage, FaultlineEvidence} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {hash} from '../canonical.js';
import {demand} from '../errors.js';
import {eventMicros, metadataMicros} from '../imports/time.js';

export interface TimelineCapture {id: string; source_id: string; content_hash: string; source_kind: 'analytics' | 'support' | 'release'; coverage: FaultlineCoverage;}
export interface TimelineWindow {start: string; end: string;}
export type EvidenceProjection = Pick<FaultlineEvidence, 'id' | 'snapshot_id' | 'source_kind' | 'source_ref' | 'event_time' | 'captured_at' | 'text' | 'content_hash' | 'redaction_status' | 'evidence_status'> & {
  temporal_relation: 'overlaps_selected_interval' | 'occurrence_unknown';
  cohort_relation: 'not_established';
};
export interface SourceCoverage {
  source_kind: TimelineCapture['source_kind'];
  status: 'complete_attested' | 'provisional' | 'partial' | 'unavailable';
  basis: string[];
  snapshot_ids: string[];
  source_ids: string[];
  covered_intervals: TimelineWindow[];
  covered_interval_count: number;
  covered_intervals_truncated: boolean;
  gaps: TimelineWindow[];
  gap_count: number;
  gaps_truncated: boolean;
  limitations: string[];
}
export interface TimelineProjection {
  window: TimelineWindow;
  known_occurrence: EvidenceProjection[];
  unknown_occurrence: EvidenceProjection[];
  sources: SourceCoverage[];
  limitations: string[];
  coverage_hash: string;
}
const sourceKinds = ['analytics', 'support', 'release'] as const;
const evidenceKinds: readonly FaultlineEvidence['source_kind'][] = [...sourceKinds, 'deployment', 'test', 'human_note'];
const id = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/, sha = /^[a-f0-9]{64}$/, displayLimit = 100;
interface Span {start: bigint; end: bigint;}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function shape(value: unknown, keys: readonly string[], required: readonly string[]) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'TIMELINE_INPUT', 'Use a finite timeline object.');
  const actual = Object.keys(value); demand(actual.every(key => keys.includes(key)) && required.every(key => actual.includes(key)), 'TIMELINE_INPUT', 'Use only the declared timeline fields.');
}
function metadataSpan(value: TimelineWindow): Span {
  shape(value, ['start', 'end'], ['start', 'end']);
  const start = metadataMicros(value.start), end = metadataMicros(value.end);
  demand(start < end, 'TIMELINE_INTERVAL', 'Timeline and declared coverage intervals must be positive and half-open.'); return {start, end};
}
// Only UTC3 coverage/window endpoints reach this conversion. Occurrence UTC6
// values remain their exact strings and are compared as integer microseconds.
const displaySpan = (span: Span): TimelineWindow => ({start: new Date(Number(span.start / 1000n)).toISOString(), end: new Date(Number(span.end / 1000n)).toISOString()});
function union(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0), result: Span[] = [];
  for (const span of sorted) {const previous = result.at(-1); if (previous && span.start <= previous.end) {if (span.end > previous.end) previous.end = span.end;} else result.push({...span});} return result;
}
function sourceCoverage(kind: TimelineCapture['source_kind'], captures: TimelineCapture[], window: Span): SourceCoverage {
  const selected = captures.filter(capture => capture.source_kind === kind), spans: Span[] = [], usable: TimelineCapture[] = [];
  const sourceIds = [...new Set(selected.map(capture => capture.source_id))].sort(order), distinctSources = sourceIds.length > 1;
  let missingWatermarks = 0, earlyWatermarks = 0;
  for (const capture of selected) {
    if (capture.coverage.basis === 'none') continue;
    if (capture.coverage.event_watermark === null) {missingWatermarks++; continue;}
    const watermark = metadataMicros(capture.coverage.event_watermark);
    const declared = capture.coverage.event_time_intervals.map(metadataSpan).map(span => ({start: span.start > window.start ? span.start : window.start, end: span.end < window.end ? span.end : window.end})).filter(span => span.start < span.end);
    if (declared.some(span => span.end > watermark)) earlyWatermarks++;
    const clipped = declared.map(span => ({start: span.start, end: span.end < watermark ? span.end : watermark})).filter(span => span.start < span.end);
    if (clipped.length) {usable.push(capture); spans.push(...clipped);}
  }
  const covered = union(spans), gaps: Span[] = []; let cursor = window.start;
  for (const span of covered) {if (cursor < span.start) gaps.push({start: cursor, end: span.start}); cursor = span.end;} if (cursor < window.end) gaps.push({start: cursor, end: window.end});
  const incompleteExtraction = usable.some(capture => capture.coverage.extraction_status !== 'complete'), assumed = usable.some(capture => capture.coverage.basis === 'lateness_assumption');
  const missingBasisStatement = usable.some(({coverage}) => coverage.basis === 'operator_attestation' && !coverage.attestation.trim() || coverage.basis === 'lateness_assumption' && !(coverage.attestation.trim() || coverage.assumptions?.some(statement => statement.trim())));
  const status: SourceCoverage['status'] = !covered.length ? 'unavailable' : gaps.length || incompleteExtraction || missingBasisStatement || distinctSources ? 'partial' : assumed ? 'provisional' : 'complete_attested';
  const limitations: string[] = [];
  if (!covered.length) limitations.push(`${kind} has no usable declared event-time coverage for this interval; collection and event absence are unknown.`);
  else if (gaps.length) limitations.push(`${kind} has ${gaps.length} uncovered intervals; missing records there do not establish absence of events.`);
  // Group qualifications so all three sources plus global limitations remain
  // within the report's finite 20-statement limit without discarding warnings.
  const qualifications: string[] = [];
  if (incompleteExtraction) qualifications.push('partial or unknown extraction does not prove a complete event population');
  if (assumed) qualifications.push('a lateness assumption cannot receive complete-attested status');
  if (missingBasisStatement) qualifications.push('a required operator attestation or lateness assumption statement is missing');
  if (distinctSources) qualifications.push('distinct logical sources cannot fill one another\'s uncaptured intervals; the displayed union does not establish complete source-category capture');
  if (qualifications.length) limitations.push(`${kind}: ${qualifications.join('; ')}.`);
  const watermarkWarnings: string[] = [];
  if (missingWatermarks) watermarkWarnings.push(`${missingWatermarks} snapshots have no event watermark and supply no mature coverage`);
  if (earlyWatermarks) watermarkWarnings.push(`${earlyWatermarks} snapshots have an early event watermark; their declared tails are excluded from mature coverage`);
  if (watermarkWarnings.length) limitations.push(`${kind}: ${watermarkWarnings.join('; ')}.`);
  if (usable.length < selected.length) limitations.push(`${kind} excludes ${selected.length - usable.length} snapshots without usable mature event-time declarations in this interval; received time cannot fill those declarations.`);
  if (covered.length > displayLimit || gaps.length > displayLimit) limitations.push(`${kind} display is truncated to 100 covered intervals and 100 gaps. Total counts and status use every bounded declared interval.`);
  return {source_kind: kind, status, basis: [...new Set(selected.map(capture => capture.coverage.basis))].sort(order), snapshot_ids: selected.map(capture => capture.id).sort(order), source_ids: sourceIds, covered_intervals: covered.slice(0, displayLimit).map(displaySpan), covered_interval_count: covered.length, covered_intervals_truncated: covered.length > displayLimit, gaps: gaps.slice(0, displayLimit).map(displaySpan), gap_count: gaps.length, gaps_truncated: gaps.length > displayLimit, limitations};
}
function projectEvidence(value: FaultlineEvidence, temporal_relation: EvidenceProjection['temporal_relation']): EvidenceProjection {
  return {id: value.id, snapshot_id: value.snapshot_id, source_kind: value.source_kind, source_ref: value.source_ref, event_time: {...value.event_time}, captured_at: value.captured_at, text: value.text, content_hash: value.content_hash, redaction_status: value.redaction_status, evidence_status: value.evidence_status, temporal_relation, cohort_relation: 'not_established'};
}
/** Pure bounded projection; current authorization/freshness belongs to the caller. */
export function projectTimeline(input: {window: TimelineWindow; captures: TimelineCapture[]; evidence: FaultlineEvidence[]; source_kind?: FaultlineEvidence['source_kind']}): TimelineProjection {
  shape(input, ['window', 'captures', 'evidence', 'source_kind'], ['window', 'captures', 'evidence']);
  demand(Array.isArray(input.captures) && input.captures.length <= 100 && Array.isArray(input.evidence) && input.evidence.length <= 100, 'TIMELINE_LIMIT', 'Select at most 100 captures and 100 evidence records.');
  demand(input.source_kind === undefined || evidenceKinds.includes(input.source_kind), 'TIMELINE_SOURCE_KIND', 'Select one finite evidence source kind.');
  const window = metadataSpan(input.window), windowValue = {...input.window};
  const captures = Array.from(input.captures, capture => {
    shape(capture, ['id', 'source_id', 'content_hash', 'source_kind', 'coverage'], ['id', 'source_id', 'content_hash', 'source_kind', 'coverage']);
    demand(typeof capture.id === 'string' && id.test(capture.id) && typeof capture.source_id === 'string' && id.test(capture.source_id) && typeof capture.content_hash === 'string' && sha.test(capture.content_hash) && sourceKinds.includes(capture.source_kind), 'TIMELINE_CAPTURE', 'Capture identity, logical source identity, content hash and source kind must be canonical.');
    const coverage = validateContract<FaultlineCoverage>('coverage', capture.coverage);
    for (const interval of [...coverage.event_time_intervals, ...(coverage.received_time_intervals ?? [])]) metadataSpan(interval);
    for (const instant of [coverage.covered_start, coverage.covered_end, coverage.event_watermark]) if (instant !== null) metadataMicros(instant);
    if (coverage.covered_start !== null && coverage.covered_end !== null) demand(metadataMicros(coverage.covered_start) < metadataMicros(coverage.covered_end), 'TIMELINE_INTERVAL', 'Coverage extrema must be positive when supplied.');
    return {...capture, coverage};
  }).sort((a, b) => order(a.id, b.id));
  demand(new Set(captures.map(capture => capture.id)).size === captures.length && new Set(input.evidence.map(value => value?.id)).size === input.evidence.length, 'TIMELINE_DUPLICATE_INPUT', 'Capture and evidence identities must be distinct within the selection.');
  const known: {value: EvidenceProjection; start: bigint}[] = [], unknown: EvidenceProjection[] = [];
  for (const raw of input.evidence) {
    const value = validateContract<FaultlineEvidence>('evidence', raw); metadataMicros(value.captured_at);
    let occurrence: Span | undefined;
    if (value.event_time.kind === 'exact') {const at = eventMicros(value.event_time.at); occurrence = {start: at, end: at};}
    if (value.event_time.kind === 'range') {const start = eventMicros(value.event_time.start), end = eventMicros(value.event_time.end); demand(start < end, 'TIMELINE_INTERVAL', 'Known occurrence ranges must be positive.'); occurrence = {start, end};}
    if (value.redaction_status === 'withdrawn' || input.source_kind !== undefined && value.source_kind !== input.source_kind) continue;
    if (!occurrence) {unknown.push(projectEvidence(value, 'occurrence_unknown')); continue;}
    const overlaps = value.event_time.kind === 'exact' ? occurrence.start >= window.start && occurrence.start < window.end : occurrence.start < window.end && occurrence.end > window.start;
    if (overlaps) known.push({value: projectEvidence(value, 'overlaps_selected_interval'), start: occurrence.start});
  }
  const sources = sourceKinds.map(kind => sourceCoverage(kind, captures, window));
  const limitations = [...new Set(['Occurrence-time alignment is temporal association only; cohort membership and aggregate causal effect are not established.', 'Unknown occurrence time stays separate. Capture or received time is not substituted for event time.', 'Coverage describes provided snapshot declarations only. Missing, partial or provisional coverage cannot establish absence of events.', ...sources.flatMap(source => source.limitations)])];
  return {window: windowValue, known_occurrence: known.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : order(a.value.id, b.value.id)).map(row => row.value), unknown_occurrence: unknown.sort((a, b) => order(a.id, b.id)), sources, limitations, coverage_hash: hash({window: windowValue, captures, sources})};
}
