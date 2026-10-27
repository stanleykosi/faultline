import {hash} from '../canonical.js';
import {demand} from '../errors.js';
import {eventMicros, metadataMicros} from '../imports/time.js';
import {computeMixShift, summarizeRate, validateMetric, type MixShiftResult} from '../metrics/comparison.js';
import {strictBody, validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineAnalyticPlan, FaultlineCanonicalEvent, FaultlineEvidence, FaultlineHypothesis, FaultlineMetric, FaultlineMetricResult} from '../../../contracts/src/generated.js';
export function analyticEvidenceIds(plan:Pick<FaultlineAnalyticPlan,'evidence_ids'>,hypothesis:Pick<FaultlineHypothesis,'supporting_evidence_ids'|'contradicting_evidence_ids'>):string[]{return [...new Set([...plan.evidence_ids,...hypothesis.supporting_evidence_ids,...hypothesis.contradicting_evidence_ids])];}

export interface InvestigationBinding {workspace_id: string; case_id: string; revision_id: string; metric_hash: string; snapshot_hash: string;}
export interface AnalyticInputs {
  hypothesis: FaultlineHypothesis; plan: FaultlineAnalyticPlan; metric_result: FaultlineMetricResult;
  events: readonly FaultlineCanonicalEvent[]; evidence: readonly FaultlineEvidence[];
  binding: InvestigationBinding; metric_definition?: FaultlineMetric;
}
export type ManualHypothesisFields = Pick<FaultlineHypothesis, 'title' | 'statement' | 'mechanism_description' | 'falsifier' | 'proposed_test_kinds'> & Partial<Pick<FaultlineHypothesis, 'supporting_evidence_ids' | 'contradicting_evidence_ids' | 'missing_evidence' | 'priority'>>;
export type Direction = 'increase' | 'decrease' | 'unchanged' | 'unknown';
export interface CohortObservation {cohort: string; baseline_eligible: number; baseline_converted: number; comparison_eligible: number; comparison_converted: number; baseline_rate: number | null; comparison_rate: number | null; delta_pp: number | null; direction: Direction;}
export interface QualityDetails {quality: FaultlineMetricResult['quality']; basis: FaultlineMetricResult['basis']; event_count: number; distinct_events: number; identical_duplicates: number; conflicting_duplicates: number; logical_sources: string[]; unknown_cohort_count: number;}
export interface TemporalDetails {aggregate_direction: Direction; comparison_start: string | null; entries: {evidence_id: string; time_kind: 'exact' | 'range' | 'unknown'; relation: 'at_comparison_boundary' | 'before_comparison' | 'during_comparison' | 'after_comparison' | 'uncertain'; at: string | null}[]; deployment_exposure_established: false;}
export type AnalyticDetails = QualityDetails | {expected_direction: Direction; cohorts: CohortObservation[]} | MixShiftResult | TemporalDetails;
export interface AnalyticResult {
  schema_version: 1; algorithm_version: 'faultline_analytic_v1'; kind: FaultlineAnalyticPlan['kind'];
  plan_id: string; hypothesis_id: string; workspace_id: string; case_id: string; revision_id: string;
  metric_hash: string; snapshot_hash: string; plan_hash: string; hypothesis_hash: string;
  metric_result_hash: string; snapshot_events_hash: string; evidence_hashes: Record<string, string>;
  input_hash: string; result_hash: string;
  outcome: 'passed' | 'failed' | 'blocked' | 'inconclusive'; freshness: 'fresh' | 'stale';
  reasons: string[]; limitations: string[];
  attribution: {scope: 'association_only'; causal_effect: 'not_established'};
  details: AnalyticDetails;
}
const hashField = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const shortString = {type: 'string', minLength: 1, maxLength: 500};
const countField = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const nullableNumber = {anyOf: [{type: 'number'}, {type: 'null'}]};
const directionField = {enum: ['increase', 'decrease', 'unchanged', 'unknown']};
const stringArray = (max: number) => ({type: 'array', items: shortString, maxItems: max});
const strictObject = (properties: Record<string, object>, optional: string[] = []) => ({type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(k => !optional.includes(k))});
const rateDetails = strictObject({expected_direction: directionField, cohorts: {type: 'array', maxItems: 8, items: strictObject({cohort: shortString, baseline_eligible: countField, baseline_converted: countField, comparison_eligible: countField, comparison_converted: countField, baseline_rate: nullableNumber, comparison_rate: nullableNumber, delta_pp: nullableNumber, direction: directionField})}});
const qualityDetails = strictObject({quality: {enum: ['complete_attested', 'provisional', 'incomplete']}, basis: {enum: ['source_guarantee', 'operator_attestation', 'lateness_assumption', 'none']}, event_count: countField, distinct_events: countField, identical_duplicates: countField, conflicting_duplicates: countField, logical_sources: stringArray(100), unknown_cohort_count: countField});
const mixDetails = strictObject({status: {enum: ['complete', 'provisional', 'inconclusive']}, metric_hash: hashField, result_hash: hashField, standardized_rate: nullableNumber, within_component_pp: nullableNumber, composition_component_pp: nullableNumber, baseline_weights: {type: 'object', maxProperties: 8, additionalProperties: {type: 'number', minimum: 0, maximum: 1}}, missing_comparison_strata: stringArray(8), comparison_only_strata: stringArray(8), limitations: stringArray(10), reason: shortString}, ['reason']);
const temporalDetails = strictObject({aggregate_direction: directionField, comparison_start: {anyOf: [{type: 'string', format: 'date-time'}, {type: 'null'}]}, entries: {type: 'array', maxItems: 100, items: strictObject({evidence_id: shortString, time_kind: {enum: ['exact', 'range', 'unknown']}, relation: {enum: ['at_comparison_boundary', 'before_comparison', 'during_comparison', 'after_comparison', 'uncertain']}, at: {anyOf: [{type: 'string', format: 'date-time'}, {type: 'null'}]}})}, deployment_exposure_established: {const: false}});
/** The pack has no analytic-result schema. This strict local DTO is an explicit integration contract. */
export const analyticResultSchema = {
  ...strictObject({schema_version: {const: 1}, algorithm_version: {const: 'faultline_analytic_v1'}, kind: {enum: ['data_quality', 'cohort_change', 'mix_shift', 'temporal_alignment', 'negative_control']}, plan_id: shortString, hypothesis_id: shortString, workspace_id: shortString, case_id: shortString, revision_id: shortString, metric_hash: hashField, snapshot_hash: hashField, plan_hash: hashField, hypothesis_hash: hashField, metric_result_hash: hashField, snapshot_events_hash: hashField, evidence_hashes: {type: 'object', maxProperties: 200, additionalProperties: hashField}, input_hash: hashField, result_hash: hashField, outcome: {enum: ['passed', 'failed', 'blocked', 'inconclusive']}, freshness: {enum: ['fresh', 'stale']}, reasons: stringArray(30), limitations: stringArray(10), attribution: strictObject({scope: {const: 'association_only'}, causal_effect: {const: 'not_established'}}), details: {oneOf: [qualityDetails, rateDetails, mixDetails, temporalDetails]}}),
  allOf: [
    {if: {properties: {kind: {const: 'data_quality'}}}, then: {properties: {details: qualityDetails}}},
    {if: {properties: {kind: {enum: ['cohort_change', 'negative_control']}}}, then: {properties: {details: rateDetails}}},
    {if: {properties: {kind: {const: 'mix_shift'}}}, then: {properties: {details: mixDetails}}},
    {if: {properties: {kind: {const: 'temporal_alignment'}}}, then: {properties: {details: temporalDetails}}},
  ],
};
function referenceMap(evidence: readonly FaultlineEvidence[], binding: InvestigationBinding): Map<string, FaultlineEvidence> {
  const result = new Map<string, FaultlineEvidence>();
  demand(evidence.length <= 200, 'EVIDENCE_LIMIT', 'Analytic input evidence is bounded to 200 records');
  for (const value of evidence) {
    const item = validateContract<FaultlineEvidence>('evidence', value);
    demand(item.workspace_id === binding.workspace_id && item.case_id === binding.case_id, 'EVIDENCE_NOT_ACCESSIBLE', 'Evidence reference is inaccessible or absent', 404);
    demand(!result.has(item.id), 'DUPLICATE_EVIDENCE_REFERENCE', 'Evidence revision identities must be unique'); result.set(item.id, item);
  }
  return result;
}
function scopeMatches(value: {workspace_id: string; case_id: string}, binding: InvestigationBinding): void {
  demand(value.workspace_id === binding.workspace_id && value.case_id === binding.case_id, 'INVESTIGATION_NOT_ACCESSIBLE', 'Investigation reference is inaccessible or absent', 404);
}
export function validateHypothesis(value: unknown, binding: InvestigationBinding, evidence: readonly FaultlineEvidence[]): FaultlineHypothesis {
  const hypothesis = validateContract<FaultlineHypothesis>('hypothesis', value); scopeMatches(hypothesis, binding);
  demand(hypothesis.revision_id === binding.revision_id, 'STALE_HYPOTHESIS_REVISION', 'Manual edit requires the current investigation revision', 409);
  const references = referenceMap(evidence, binding);
  for (const ids of [hypothesis.supporting_evidence_ids, hypothesis.contradicting_evidence_ids]) {
    demand(new Set(ids).size === ids.length, 'DUPLICATE_EVIDENCE_REFERENCE', 'Hypothesis evidence links must be unique');
    for (const id of ids) demand(references.has(id) && references.get(id)!.redaction_status !== 'withdrawn', 'EVIDENCE_NOT_ACCESSIBLE', 'Evidence reference is inaccessible, withdrawn or absent', 404);
  }
  demand(new Set(hypothesis.proposed_test_kinds).size === hypothesis.proposed_test_kinds.length, 'DUPLICATE_TEST_KIND', 'Proposed finite test kinds must be unique');
  return hypothesis;
}
export function validateManualHypothesis(value: unknown, binding: InvestigationBinding, evidence: readonly FaultlineEvidence[]): FaultlineHypothesis {
 const hypothesis=validateHypothesis(value,binding,evidence);
 demand(hypothesis.origin==='human','INVALID_HYPOTHESIS_ORIGIN','Manual hypothesis must retain human authorship');return hypothesis;
}
/** Editing a proposal records human review while preserving its original authorship. */
export function reviseHypothesis(old:FaultlineHypothesis,fields:Record<string,unknown>,binding:InvestigationBinding,evidence:readonly FaultlineEvidence[]):FaultlineHypothesis {
 const allowed=['title','statement','mechanism_description','falsifier','proposed_test_kinds','supporting_evidence_ids','contradicting_evidence_ids','missing_evidence','priority','status'];
 demand(Object.keys(fields).every(k=>allowed.includes(k)),'PROTECTED_HYPOTHESIS_FIELD','Edits cannot replace authorship, identity or verification fields.');
 scopeMatches(old,binding);
 return validateHypothesis({...old,...fields,origin:old.origin,revision_id:binding.revision_id},binding,evidence);
}
export function createManualHypothesis(id: string, binding: InvestigationBinding, fields: ManualHypothesisFields, evidence: readonly FaultlineEvidence[] = []): FaultlineHypothesis {
  const allowed = ['title', 'statement', 'mechanism_description', 'falsifier', 'proposed_test_kinds', 'supporting_evidence_ids', 'contradicting_evidence_ids', 'missing_evidence', 'priority'];
  demand(fields && typeof fields === 'object' && Object.keys(fields).every(k => allowed.includes(k)), 'INVALID_MANUAL_HYPOTHESIS', 'Manual fields cannot supply an origin, verdict, confidence or executable operation');
  return validateManualHypothesis({...fields, schema_version: 1, id, workspace_id: binding.workspace_id, case_id: binding.case_id, revision_id: binding.revision_id, supporting_evidence_ids: fields.supporting_evidence_ids ?? [], contradicting_evidence_ids: fields.contradicting_evidence_ids ?? [], missing_evidence: fields.missing_evidence ?? [], priority: fields.priority ?? 'normal', status: 'proposed', origin: 'human'}, binding, evidence);
}
function rateDirection(b: {eligible: number; converted: number}, c: {eligible: number; converted: number}): Direction {
  if (!b.eligible || !c.eligible) return 'unknown';
  const difference = BigInt(c.converted) * BigInt(b.eligible) - BigInt(b.converted) * BigInt(c.eligible);
  return difference > 0n ? 'increase' : difference < 0n ? 'decrease' : 'unchanged';
}
function checkedResult(value: FaultlineMetricResult): FaultlineMetricResult {
  const result = validateContract<FaultlineMetricResult>('metric-result', value);
  for (const period of [result.baseline, result.comparison]) if (period) {
    demand(period.rate === summarizeRate(period.eligible, period.converted).rate, 'INVALID_METRIC_RESULT', 'Metric rates must derive from their frozen numerator/denominator');
    for (const stratum of Object.values(period.strata)) demand(stratum.rate === summarizeRate(stratum.eligible, stratum.converted).rate, 'INVALID_METRIC_RESULT', 'Cohort rates must derive from their frozen counts');
    if (period.unknown_cohort_count === 0) demand(Object.values(period.strata).reduce((n, s) => n + s.eligible, 0) === period.eligible && Object.values(period.strata).reduce((n, s) => n + s.converted, 0) === period.converted, 'INVALID_METRIC_RESULT', 'Frozen cohort counts must reconcile to the aggregate');
  }
  if (result.baseline && result.comparison) {
    const b = result.baseline.rate, c = result.comparison.rate, delta = b === null || c === null ? null : 100 * (c - b), relative = b === null || c === null || b === 0 ? null : c / b - 1;
    demand(result.delta_pp === delta && result.relative_change === relative, 'INVALID_METRIC_RESULT', 'Metric change must derive from the frozen rates');
  }
  return result;
}
function quality(events: readonly FaultlineCanonicalEvent[], result: FaultlineMetricResult): QualityDetails {
  demand(events.length <= 100_000, 'SNAPSHOT_EVENT_LIMIT', 'Frozen analytic input exceeds the configured event ceiling');
  const seen = new Map<string, string>(), sources = new Set<string>(); let duplicate = 0, conflict = 0;
  for (const value of events) {
    const event = validateContract<FaultlineCanonicalEvent>('canonical-event', value); eventMicros(event.occurred_at); sources.add(event.source_id);
    const identity = JSON.stringify([event.source_id, event.event_id]), content = hash(event), old = seen.get(identity);
    if (old === content) duplicate++; else if (old) conflict++; else seen.set(identity, content);
  }
  return {quality: result.quality, basis: result.basis, event_count: events.length, distinct_events: seen.size, identical_duplicates: duplicate, conflicting_duplicates: conflict, logical_sources: [...sources].sort(), unknown_cohort_count: (result.baseline?.unknown_cohort_count ?? 0) + (result.comparison?.unknown_cohort_count ?? 0)};
}
export function evaluateAnalyticPlan(input: AnalyticInputs): AnalyticResult {
  const plan = validateContract<FaultlineAnalyticPlan>('analytic-plan', input.plan), hypothesis = validateContract<FaultlineHypothesis>('hypothesis', input.hypothesis), metric = checkedResult(input.metric_result);
  scopeMatches(plan, input.binding); scopeMatches(hypothesis, input.binding);
  demand(plan.hypothesis_id === hypothesis.id && hypothesis.proposed_test_kinds.includes(plan.kind), 'HYPOTHESIS_TEST_BINDING_MISMATCH', 'Typed plan must address its frozen hypothesis and declared finite test kind');
  demand(new Set(plan.cohorts).size === plan.cohorts.length && new Set(plan.evidence_ids).size === plan.evidence_ids.length, 'DUPLICATE_ANALYTIC_PARAMETER', 'Finite cohorts and evidence identities must be unique');
  const references = referenceMap(input.evidence, input.binding), diagnostic = quality(input.events, metric);
  const selected = plan.cohorts.length ? plan.cohorts : Object.keys(metric.baseline?.strata ?? metric.comparison?.strata ?? {});
  const rows: CohortObservation[] = selected.map(cohort => {
    const b = metric.baseline?.strata[cohort], c = metric.comparison?.strata[cohort];
    return {cohort, baseline_eligible: b?.eligible ?? 0, baseline_converted: b?.converted ?? 0, comparison_eligible: c?.eligible ?? 0, comparison_converted: c?.converted ?? 0, baseline_rate: b?.rate ?? null, comparison_rate: c?.rate ?? null, delta_pp: b?.rate == null || c?.rate == null ? null : 100 * (c.rate - b.rate), direction: b && c ? rateDirection(b, c) : 'unknown'};
  });
  const mix = plan.kind === 'mix_shift' ? computeMixShift(metric) : undefined;
  let definition: FaultlineMetric | undefined;
  if (input.metric_definition) {definition = validateMetric(input.metric_definition); demand(hash(definition) === plan.metric_hash, 'METRIC_DEFINITION_BINDING_MISMATCH', 'Metric definition must match the frozen analytic plan');}
  const temporal: TemporalDetails = {aggregate_direction: metric.baseline && metric.comparison ? rateDirection(metric.baseline, metric.comparison) : 'unknown', comparison_start: definition?.windows.comparison.start ?? null, entries: [], deployment_exposure_established: false};
  if (plan.kind === 'temporal_alignment') for (const id of plan.evidence_ids) {
    const evidence = references.get(id); if (!evidence || !['release', 'deployment'].includes(evidence.source_kind)) continue;
    const time = evidence.event_time;
    let relation: TemporalDetails['entries'][number]['relation'] = 'uncertain';
    if (definition && time.kind === 'exact') {
      const at = eventMicros(time.at), start = metadataMicros(definition.windows.comparison.start), end = metadataMicros(definition.windows.comparison.end);
      relation = at === start ? 'at_comparison_boundary' : at < start ? 'before_comparison' : at < end ? 'during_comparison' : 'after_comparison';
    }
    temporal.entries.push({evidence_id: id, time_kind: time.kind, relation, at: time.kind === 'exact' ? time.at : null});
  }
  const details: AnalyticDetails = plan.kind === 'data_quality' ? diagnostic : plan.kind === 'mix_shift' ? mix! : plan.kind === 'temporal_alignment' ? temporal : {expected_direction: plan.expected_direction, cohorts: rows};
  const evidence_hashes = Object.fromEntries([...references].map(([id, value]) => [id, hash(value)]));
  const base = {schema_version: 1 as const, algorithm_version: 'faultline_analytic_v1' as const, kind: plan.kind, plan_id: plan.id, hypothesis_id: hypothesis.id, workspace_id: plan.workspace_id, case_id: plan.case_id, revision_id: plan.revision_id, metric_hash: plan.metric_hash, snapshot_hash: plan.snapshot_hash, plan_hash: hash(plan), hypothesis_hash: hash(hypothesis), metric_result_hash: hash(metric), snapshot_events_hash: hash(input.events), evidence_hashes, details,
    attribution: {scope: 'association_only' as const, causal_effect: 'not_established' as const}, limitations: ['Descriptive analytic checks do not establish aggregate causality or reproduce an application mechanism.']};
  const input_hash = hash({binding: input.binding, plan_hash: base.plan_hash, hypothesis_hash: base.hypothesis_hash, metric_result_hash: base.metric_result_hash, snapshot_events_hash: base.snapshot_events_hash, evidence_hashes, metric_definition_hash: definition ? hash(definition) : null});
  const finish = (outcome: AnalyticResult['outcome'], reasons: string[], freshness: AnalyticResult['freshness'] = 'fresh'): AnalyticResult => {
    const body = {...base, input_hash, outcome, freshness, reasons};
    return strictBody<AnalyticResult>(analyticResultSchema, {...body, result_hash: hash(body)});
  };
  if (plan.revision_id !== input.binding.revision_id || hypothesis.revision_id !== input.binding.revision_id || plan.metric_hash !== input.binding.metric_hash || metric.metric_hash !== input.binding.metric_hash || plan.snapshot_hash !== input.binding.snapshot_hash) return finish('blocked', ['frozen_input_binding_changed'], 'stale');
  const cited = analyticEvidenceIds(plan,hypothesis);
  if (cited.some(id => !references.has(id) || references.get(id)!.redaction_status === 'withdrawn')) return finish('blocked', ['evidence_reference_unavailable_or_withdrawn']);
  if (diagnostic.conflicting_duplicates || diagnostic.unknown_cohort_count) return finish('failed', ['conflicting_identity_or_unknown_cohort']);
  if (plan.kind === 'data_quality') {
    if (diagnostic.logical_sources.length > 1 && !definition) return finish('inconclusive', ['multiple_sources_require_explicit_metric_source']);
    return finish(metric.quality === 'complete_attested' ? 'passed' : 'inconclusive', metric.quality === 'complete_attested' ? [] : ['incomplete_or_provisional_event_population']);
  }
  if (metric.quality !== 'complete_attested' || !metric.baseline || !metric.comparison) return finish('inconclusive', ['incomplete_or_provisional_event_population']);
  if (plan.kind === 'cohort_change' || plan.kind === 'negative_control') {
    if (plan.kind === 'negative_control') demand(plan.expected_direction === 'unchanged' && plan.cohorts.length > 0, 'INVALID_NEGATIVE_CONTROL_PLAN', 'Negative control must name an explicit unaffected cohort and expect an unchanged rate');
    if (!rows.length || rows.some(r => r.baseline_eligible < plan.minimum_denominator || r.comparison_eligible < plan.minimum_denominator)) return finish('inconclusive', ['cohort_denominator_below_declared_minimum']);
    if (plan.expected_direction === 'unknown') return finish('inconclusive', ['no_predeclared_direction']);
    return finish(rows.every(r => r.direction === plan.expected_direction) ? 'passed' : 'failed', rows.every(r => r.direction === plan.expected_direction) ? [] : ['observed_cohort_direction_contradicts_prediction']);
  }
  if (plan.kind === 'mix_shift') {
    const positive = Object.keys(metric.baseline.strata).filter(k => metric.baseline!.strata[k]!.eligible > 0);
    if (mix!.status !== 'complete' || positive.some(k => !selected.includes(k) || metric.baseline!.strata[k]!.eligible < plan.minimum_denominator || (metric.comparison!.strata[k]?.eligible ?? 0) < plan.minimum_denominator)) return finish('inconclusive', ['standardization_has_missing_or_sparse_strata']);
    if (plan.expected_direction === 'unknown') return finish('inconclusive', ['no_predeclared_direction']);
    const matches = Math.abs(mix!.within_component_pp!) <= 1e-12 && temporal.aggregate_direction === plan.expected_direction;
    return finish(matches ? 'passed' : 'failed', matches ? [] : ['composition_alone_does_not_match_declared_aggregate_pattern']);
  }
  if (!definition) return finish('blocked', ['frozen_metric_windows_required_for_temporal_alignment']);
  if (!temporal.entries.length || !temporal.entries.some(e => e.time_kind === 'exact')) return finish('inconclusive', ['precise_release_occurrence_time_unavailable']);
  if (metric.baseline.eligible < plan.minimum_denominator || metric.comparison.eligible < plan.minimum_denominator || plan.expected_direction === 'unknown') return finish('inconclusive', ['denominator_or_predeclared_direction_unavailable']);
  const aligns = temporal.entries.some(e => e.relation === 'at_comparison_boundary') && temporal.aggregate_direction === plan.expected_direction;
  return finish(aligns ? 'passed' : 'failed', aligns ? [] : ['reported_release_time_does_not_match_declared_boundary_pattern']);
}
