import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import type {FaultlineCoverage, FaultlineEvidence} from '../../../contracts/src/generated.js';
import {DomainError} from '../errors.js';
import {projectTimeline, type TimelineCapture, type TimelineWindow} from './timeline.js';

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

test('exact occurrence includes the half-open UTC6 edges and never uses capture time', () => {
  const rows = [evidence('before', exact('2026-10-01T09:59:59.999999Z')), evidence('start', exact('2026-10-01T10:00:00.000000Z')), evidence('last', exact('2026-10-01T11:59:59.999999Z')), evidence('end', exact('2026-10-01T12:00:00.000000Z'))];
  const result = projectTimeline({window, captures: [], evidence: rows.reverse()});
  assert.deepEqual(result.known_occurrence.map(row => row.id), ['start', 'last']); assert.equal(result.unknown_occurrence.length, 0);
  const saved = result.known_occurrence[1]!; assert.deepEqual(saved.event_time, exact('2026-10-01T11:59:59.999999Z')); assert.equal(saved.captured_at, '2026-10-10T15:00:00.000Z'); assert.equal(saved.content_hash, 'e'.repeat(64)); assert.equal(saved.snapshot_id, 'snapshot-a'); assert.equal(saved.source_ref, 'authored:last'); assert.equal(saved.redaction_status, 'restricted'); assert.equal(saved.evidence_status, 'user_attested'); assert.equal(saved.temporal_relation, 'overlaps_selected_interval'); assert.equal(saved.cohort_relation, 'not_established'); assert.equal(saved.text, rows.find(row => row.id === 'last')!.text);
});

test('ranges overlap by actual UTC6 half-open occurrence while unknowns remain separate even outside capture window', () => {
  const enclosing = {kind: 'range', start: '2026-10-01T09:00:00.000001Z', end: '2026-10-01T13:00:00.000002Z'} as const;
  const result = projectTimeline({window, captures: [], evidence: [evidence('encloses', enclosing), evidence('touch-left', {kind: 'range', start: '2026-10-01T09:00:00.000000Z', end: '2026-10-01T10:00:00.000000Z'}), evidence('touch-right', {kind: 'range', start: '2026-10-01T12:00:00.000000Z', end: '2026-10-01T13:00:00.000000Z'}), evidence('one-micro-overlap', {kind: 'range', start: '2026-10-01T09:59:59.999999Z', end: '2026-10-01T10:00:00.000001Z'}), evidence('unknown-inside-capture', unknown, {captured_at: window.start}), evidence('unknown-late-capture', unknown)]});
  assert.deepEqual(result.known_occurrence.map(row => row.id), ['encloses', 'one-micro-overlap']); assert.deepEqual(result.known_occurrence[0]!.event_time, enclosing, 'Keep the original uncertain range, not the clipped display window.'); assert.deepEqual(result.unknown_occurrence.map(row => row.id), ['unknown-inside-capture', 'unknown-late-capture']);
  assert.ok(result.unknown_occurrence.every(row => row.event_time.kind === 'unknown' && row.temporal_relation === 'occurrence_unknown' && row.cohort_relation === 'not_established'));
});

test('withdrawn records are excluded; finite source filter affects evidence but preserves all three coverage categories', () => {
  const captures = [capture('analytics'), capture('release', 'release')], rows = [evidence('support', exact('2026-10-01T10:00:00.000000Z')), evidence('release', unknown, {source_kind: 'release'}), evidence('withdrawn', exact('2026-10-01T11:00:00.000000Z'), {source_kind: 'release', redaction_status: 'withdrawn'}), evidence('human', unknown, {source_kind: 'human_note', snapshot_id: null})];
  const result = projectTimeline({window, captures, evidence: rows, source_kind: 'release'});
  assert.deepEqual(result.known_occurrence, []); assert.deepEqual(result.unknown_occurrence.map(row => row.id), ['release']); assert.deepEqual(result.sources.map(row => row.source_kind), ['analytics', 'support', 'release']); assert.equal(result.sources[0]!.status, 'complete_attested'); assert.equal(result.sources[1]!.status, 'unavailable'); assert.equal(result.sources[2]!.status, 'complete_attested'); assert.equal(result.coverage_hash, projectTimeline({window, captures, evidence: rows}).coverage_hash);
  assert.throws(() => projectTimeline({window, captures, evidence: rows, source_kind: 'https://untrusted.test' as any}), code('TIMELINE_SOURCE_KIND'));
});

test('touching, overlapping and out-of-window declarations union and clamp without day-by-day loops', () => {
  const captures = [capture('z', 'analytics', coverage([span('2026-10-01T11:00:00.000Z', '2026-10-01T13:00:00.000Z')])), capture('a', 'analytics', coverage([span('2026-10-01T09:00:00.000Z', '2026-10-01T11:00:00.000Z'), span('2026-10-01T10:30:00.000Z', '2026-10-01T11:30:00.000Z')]))];
  const source = projectTimeline({window, captures, evidence: []}).sources[0]!;
  assert.equal(source.status, 'complete_attested'); assert.deepEqual(source.covered_intervals, [window]); assert.equal(source.covered_interval_count, 1); assert.equal(source.covered_intervals_truncated, false); assert.deepEqual(source.gaps, []); assert.equal(source.gap_count, 0); assert.equal(source.gaps_truncated, false); assert.deepEqual(source.snapshot_ids, ['a', 'z']); assert.deepEqual(source.basis, ['operator_attestation']);
  const huge = {start: '0001-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.999Z'};
  const long = projectTimeline({window: huge, captures: [capture('long', 'analytics', coverage([huge], {covered_start: huge.start, covered_end: huge.end, event_watermark: huge.end}))], evidence: []}).sources[0]!;
  assert.equal(long.status, 'complete_attested'); assert.deepEqual(long.covered_intervals, [huge]); assert.equal(long.gap_count, 0);
});

test('disjoint intervals preserve exact gaps despite full-range extrema or watermark', () => {
  const intervals = [span('2026-10-01T10:10:00.000Z', '2026-10-01T10:30:00.000Z'), span('2026-10-01T11:00:00.000Z', '2026-10-01T11:45:00.000Z')];
  const projection = projectTimeline({window, captures: [capture('gap', 'support', coverage(intervals))], evidence: []}), source = projection.sources[1]!;
  assert.equal(source.status, 'partial'); assert.deepEqual(source.covered_intervals, intervals); assert.deepEqual(source.gaps, [span(window.start, '2026-10-01T10:10:00.000Z'), span('2026-10-01T10:30:00.000Z', '2026-10-01T11:00:00.000Z'), span('2026-10-01T11:45:00.000Z', window.end)]); assert.equal(source.gap_count, 3); assert.ok(source.limitations.some(value => value.includes('do not establish absence')));
  assert.ok(projection.limitations.includes('support has 3 uncovered intervals; missing records there do not establish absence of events.')); assert.ok(projection.limitations.includes('analytics has no usable declared event-time coverage for this interval; collection and event absence are unknown.'));
});

test('distinct logical sources cannot fill each other\'s missing intervals to establish complete capture', () => {
  const middle = '2026-10-01T11:00:00.000Z', captures = [capture('first', 'analytics', coverage([span(window.start, middle)]), 'source-a'), capture('second', 'analytics', coverage([span(middle, window.end)]), 'source-b')];
  const result = projectTimeline({window, captures, evidence: []}), source = result.sources[0]!; assert.equal(source.status, 'partial'); assert.deepEqual(source.source_ids, ['source-a', 'source-b']); assert.deepEqual(source.covered_intervals, [window]); assert.equal(source.gap_count, 0); assert.ok(result.limitations.some(value => value.includes('distinct logical sources cannot fill one another\'s uncaptured intervals')));
  const sameSource = projectTimeline({window, captures: captures.map(value => ({...value, source_id: 'source-a'})), evidence: []}); assert.equal(sameSource.sources[0]!.status, 'complete_attested'); assert.deepEqual(sameSource.sources[0]!.source_ids, ['source-a']); assert.notEqual(result.coverage_hash, sameSource.coverage_hash);
});

test('declared known-empty timeline differs from uncaptured, none-basis and received-only data', () => {
  const empty = projectTimeline({window, captures: [capture()], evidence: []}); assert.deepEqual(empty.known_occurrence, []); assert.equal(empty.sources[0]!.status, 'complete_attested'); assert.equal(empty.sources[0]!.gap_count, 0);
  for (const captures of [[], [capture('none', 'analytics', coverage([window], {basis: 'none'}))], [capture('received', 'analytics', coverage([], {received_time_intervals: [window]}))], [capture('outside', 'analytics', coverage([span('2026-10-01T12:00:00.000Z', '2026-10-01T13:00:00.000Z')]))]]) {
    const source = projectTimeline({window, captures, evidence: []}).sources[0]!; assert.equal(source.status, 'unavailable'); assert.deepEqual(source.covered_intervals, []); assert.equal(source.covered_interval_count, 0); assert.deepEqual(source.gaps, [window]); assert.equal(source.gap_count, 1); assert.ok(source.limitations.some(value => value.includes('unknown')));
  }
});

test('partial/unknown extraction never becomes complete; lateness remains provisional with full union', () => {
  for (const extraction_status of ['partial', 'unknown'] as const) {const source = projectTimeline({window, captures: [capture('incomplete', 'analytics', coverage([window], {extraction_status}))], evidence: []}).sources[0]!; assert.equal(source.status, 'partial'); assert.equal(source.gap_count, 0);}
  const assumed = capture('assumed', 'analytics', coverage([window], {basis: 'lateness_assumption', assumptions: ['Owner-assumed lateness, not source proof']})), guaranteed = capture('guaranteed', 'analytics', coverage([window], {basis: 'source_guarantee'}));
  assert.equal(projectTimeline({window, captures: [assumed], evidence: []}).sources[0]!.status, 'provisional'); assert.equal(projectTimeline({window, captures: [assumed, guaranteed], evidence: []}).sources[0]!.status, 'provisional'); assert.equal(projectTimeline({window, captures: [guaranteed], evidence: []}).sources[0]!.status, 'complete_attested');
  assert.equal(projectTimeline({window, captures: [assumed, capture('partial', 'analytics', coverage([window], {extraction_status: 'partial'}))], evidence: []}).sources[0]!.status, 'partial');
});

test('watermarks bound mature coverage and absent basis qualifications cannot receive complete-attested status', () => {
  const missing = projectTimeline({window, captures: [capture('missing-watermark', 'analytics', coverage([window], {event_watermark: null}))], evidence: []});
  assert.equal(missing.sources[0]!.status, 'unavailable'); assert.deepEqual(missing.sources[0]!.covered_intervals, []); assert.deepEqual(missing.sources[0]!.gaps, [window]); assert.ok(missing.limitations.some(value => value.includes('have no event watermark')));
  const early = '2026-10-01T11:30:00.000Z', tail = span(early, window.end), projected = projectTimeline({window, captures: [capture('early-watermark', 'support', coverage([window], {event_watermark: early}))], evidence: []});
  assert.equal(projected.sources[1]!.status, 'partial'); assert.deepEqual(projected.sources[1]!.covered_intervals, [span(window.start, early)]); assert.deepEqual(projected.sources[1]!.gaps, [tail]); assert.ok(projected.limitations.some(value => value.includes('early event watermark'))); assert.ok(projected.limitations.includes('support has 1 uncovered intervals; missing records there do not establish absence of events.'));
  const missingStatements: Partial<FaultlineCoverage>[] = [{attestation: '   '}, {basis: 'lateness_assumption', attestation: '', assumptions: []}];
  for (const patch of missingStatements) {
    const result = projectTimeline({window, captures: [capture('missing-statement', 'analytics', coverage([window], patch))], evidence: []}); assert.equal(result.sources[0]!.status, 'partial'); assert.equal(result.sources[0]!.gap_count, 0); assert.ok(result.limitations.some(value => value.includes('statement is missing')));
  }
  assert.equal(projectTimeline({window, captures: [capture('attested-lateness', 'analytics', coverage([window], {basis: 'lateness_assumption', assumptions: [], attestation: 'Declared 24-hour lateness assumption'}))], evidence: []}).sources[0]!.status, 'provisional');
});

test('union/gap display overflow is explicit and status uses all declarations rather than returned prefix', () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z'), at = (ms: number) => new Date(start + ms).toISOString(), bounds = span(at(0), at(301));
  const intervals = Array.from({length: 150}, (_, n) => span(at(2 * n + 1), at(2 * n + 2))), captures = [capture('first', 'analytics', coverage(intervals.slice(0, 100), {covered_start: bounds.start, covered_end: bounds.end})), capture('second', 'analytics', coverage(intervals.slice(100), {covered_start: bounds.start, covered_end: bounds.end}))];
  const source = projectTimeline({window: bounds, captures, evidence: []}).sources[0]!; assert.equal(source.status, 'partial'); assert.equal(source.covered_interval_count, 150); assert.equal(source.covered_intervals.length, 100); assert.equal(source.covered_intervals_truncated, true); assert.equal(source.gap_count, 151); assert.equal(source.gaps.length, 100); assert.equal(source.gaps_truncated, true); assert.deepEqual(source.covered_intervals[99], intervals[99]); assert.deepEqual(source.gaps[0], span(at(0), at(1))); assert.ok(source.limitations.some(value => value.includes('status use every')));
});

test('finite bounds reject oversized, malformed, duplicate and unsafe wire inputs', () => {
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
});

test('coverage hash is canonical, ordering-independent and binds selected window and exact immutable declarations without exposing raw attestation', () => {
  const secretDeclaration = 'RAW_ATTESTATION_DO_NOT_PROJECT <script>untrusted()</script>', captures = [capture('z', 'release', coverage([window], {attestation: secretDeclaration})), capture('a')], input = {window, captures, evidence: []};
  const result = projectTimeline(input); assert.equal(result.coverage_hash, digest({window, captures: [captures[1], captures[0]], sources: result.sources})); assert.equal(result.coverage_hash, projectTimeline({...input, captures: [...captures].reverse()}).coverage_hash); assert.equal(JSON.stringify(result).includes(secretDeclaration), false);
  for (const changed of [{...input, window: {...window, end: '2026-10-01T11:59:59.999Z'}}, {...input, captures: [captures[0]!, {...captures[1]!, content_hash: 'b'.repeat(64)}]}, {...input, captures: [captures[0]!, {...captures[1]!, coverage: {...captures[1]!.coverage, attestation: 'Changed declaration'}}]}]) assert.notEqual(projectTimeline(changed).coverage_hash, result.coverage_hash);
  assert.ok(result.limitations.length <= 20); assert.equal(new Set(result.limitations).size, result.limitations.length); assert.ok(result.limitations.every(value => value.length > 0 && value.length <= 2000)); assert.ok(result.sources.every(source => source.limitations.every(value => result.limitations.includes(value)))); assert.ok(result.limitations.some(value => value.includes('aggregate causal effect are not established')));
  const before = JSON.stringify(input); result.sources[0]!.snapshot_ids.push('cannot-mutate-input'); assert.equal(JSON.stringify(input), before);
});

test('all source qualification, watermark, exclusion and truncated-gap warnings remain in the bounded shared limitations', () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z'), at = (ms: number) => new Date(start + ms).toISOString(), bounds = span(at(0), at(301)), intervals = Array.from({length: 150}, (_, n) => span(at(2 * n + 1), at(2 * n + 2)));
  const captures = (['analytics', 'support', 'release'] as const).flatMap(kind => {
    const patch: Partial<FaultlineCoverage> = {covered_start: bounds.start, covered_end: bounds.end, extraction_status: 'partial', basis: 'lateness_assumption', attestation: '', assumptions: [], event_watermark: at(200)};
    return [capture(kind + '-first', kind, coverage(intervals.slice(0, 100), patch)), capture(kind + '-second', kind, coverage(intervals.slice(100), patch)), capture(kind + '-missing', kind, coverage([bounds], {...patch, event_watermark: null}))];
  });
  const result = projectTimeline({window: bounds, captures, evidence: []}); assert.equal(result.limitations.length, 18); assert.equal(new Set(result.limitations).size, 18); assert.ok(result.limitations.every(value => value.length <= 2000));
  for (const source of result.sources) {assert.equal(source.status, 'partial'); assert.equal(source.gap_count, 101); assert.equal(source.gaps_truncated, true); assert.equal(source.limitations.length, 5); assert.ok(source.limitations.every(value => result.limitations.includes(value)));}
});
