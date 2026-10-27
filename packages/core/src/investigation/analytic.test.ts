import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hash} from '../canonical.js';
import {DomainError} from '../errors.js';
import {normalizeAnalytics} from '../imports/parser.js';
import {computeComparison, type MixShiftResult} from '../metrics/comparison.js';
import {strictBody, validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineAnalyticPlan, FaultlineCoverage, FaultlineEvidence, FaultlineMetric} from '../../../contracts/src/generated.js';
import {analyticResultSchema, createManualHypothesis, evaluateAnalyticPlan, type AnalyticInputs, type CohortObservation, type InvestigationBinding, type ManualHypothesisFields, type TemporalDetails} from './analytic.js';

const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const kinds: ManualHypothesisFields['proposed_test_kinds'] = ['data_quality', 'cohort_change', 'mix_shift', 'temporal_alignment', 'negative_control'];
const close = (actual: number | null, expected: number) => {assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} differs from fixture expectation ${expected}`);};
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function inputs(fixture: string): AnalyticInputs {
  const events = normalizeAnalytics(fs.readFileSync(`fixtures/${fixture}/events.csv`), 'csv', 'synthetic-analytics').events;
  const definition = validateContract<FaultlineMetric>('metric', read(`fixtures/${fixture}/metric.json`));
  const metric_result = computeComparison(events, definition, read(`fixtures/${fixture}/coverage.json`) as FaultlineCoverage);
  const binding: InvestigationBinding = {workspace_id: 'workspace-fixture', case_id: `case-${fixture}`, revision_id: 'revision-1', metric_hash: hash(definition), snapshot_hash: hash({events, coverage: read(`fixtures/${fixture}/coverage.json`)})};
  const evidence = [validateContract<FaultlineEvidence>('evidence', {...read('fixtures/contracts/evidence.example.json'), case_id: binding.case_id, source_kind: 'release', source_ref: `validation-fixture:${fixture}:release`, text: 'Supplied validation fixture reports a release at the comparison boundary. This does not establish external deployment exposure.', event_time: {kind: 'exact', at: '2026-09-02T00:00:00.000000Z'}})];
  const hypothesis = createManualHypothesis('hyp-manual', binding, {title: 'Finite manual comparison', statement: 'Mobile conversion falls, or the aggregate change is accounted for by cohort composition.', mechanism_description: 'This analytic proposal distinguishes a within-cohort pattern from a composition pattern; it does not assert a reproduced mechanism.', falsifier: 'The selected cohort rates contradict the declared prediction or a composition-only account leaves a nonzero within-cohort component.', proposed_test_kinds: kinds, supporting_evidence_ids: ['evidence-1']}, evidence);
  const plan = makePlan(binding, 'data_quality');
  return {hypothesis, plan, metric_result, events, evidence, binding, metric_definition: definition};
}
function makePlan(binding: InvestigationBinding, kind: FaultlineAnalyticPlan['kind'], cohorts: string[] = [], expected_direction: FaultlineAnalyticPlan['expected_direction'] = 'unknown', minimum_denominator = 30): FaultlineAnalyticPlan {
  return validateContract<FaultlineAnalyticPlan>('analytic-plan', {schema_version: 1, id: `plan-${kind}`, ...binding, hypothesis_id: 'hyp-manual', kind, evidence_ids: ['evidence-1'], cohorts, expected_direction, minimum_denominator, purpose: 'Predeclared deterministic validation fixture comparison, association only.'});
}

test('manual model-none workflow evaluates all five analytic kinds against the two independent numerical fixtures', () => {
  for (const fixture of ['regression', 'mix-shift']) {
    const input = inputs(fixture), expected = read(`fixtures/${fixture}/expected.json`);
    assert.equal(input.hypothesis.origin, 'human'); assert.equal(input.hypothesis.status, 'proposed');
    const evaluate = (kind: FaultlineAnalyticPlan['kind'], cohorts: string[] = [], direction: FaultlineAnalyticPlan['expected_direction'] = 'unknown') => {
      const result = evaluateAnalyticPlan({...input, plan: makePlan(input.binding, kind, cohorts, direction)});
      strictBody(analyticResultSchema, result);
      assert.equal(result.freshness, 'fresh'); assert.deepEqual(result.attribution, {scope: 'association_only', causal_effect: 'not_established'});
      assert.equal(result.metric_hash, input.binding.metric_hash); assert.equal(result.snapshot_hash, input.binding.snapshot_hash);
      assert.equal(result.snapshot_events_hash, hash(input.events)); assert.equal(result.evidence_hashes['evidence-1'], hash(input.evidence[0]));
      const {result_hash, ...body} = result; assert.equal(result_hash, hash(body));
      assert.equal(input.hypothesis.status, 'proposed');
      return result;
    };
    assert.equal(evaluate('data_quality').outcome, 'passed');
    const mobile = evaluate('cohort_change', ['mobile'], fixture === 'regression' ? 'decrease' : 'unchanged');
    assert.equal(mobile.outcome, 'passed');
    const mobileRow = (mobile.details as {cohorts: CohortObservation[]}).cohorts[0]!;
    close(mobileRow.baseline_rate, expected.mobile_before); close(mobileRow.comparison_rate, expected.mobile_after);
    const control = evaluate('negative_control', ['desktop'], 'unchanged'); assert.equal(control.outcome, 'passed');
    const desktopRow = (control.details as {cohorts: CohortObservation[]}).cohorts[0]!;
    close(desktopRow.baseline_rate, expected.desktop_before); close(desktopRow.comparison_rate, expected.desktop_after);
    const mix = evaluate('mix_shift', ['mobile', 'desktop'], 'decrease');
    assert.equal(mix.outcome, fixture === 'mix-shift' ? 'passed' : 'failed');
    const mixDetails = mix.details as MixShiftResult;
    close(mixDetails.standardized_rate, expected.standardized_rate); close(mixDetails.within_component_pp, expected.within_component_pp); close(mixDetails.composition_component_pp, expected.composition_component_pp);
    const temporal = evaluate('temporal_alignment', [], 'decrease'); assert.equal(temporal.outcome, 'passed');
    assert.equal((temporal.details as TemporalDetails).entries[0]!.relation, 'at_comparison_boundary');
    assert.equal((temporal.details as TemporalDetails).deployment_exposure_established, false);
    assert.deepEqual(evaluateAnalyticPlan({...input, plan: makePlan(input.binding, 'mix_shift', ['mobile', 'desktop'], 'decrease')}), mix, 'Frozen inputs must produce identical results and hashes');
  }
});

test('stale, sparse, missing and untrusted analytic inputs cannot produce a passing claim', () => {
  const input = inputs('regression'), cohort = makePlan(input.binding, 'cohort_change', ['mobile'], 'decrease');
  const stale = evaluateAnalyticPlan({...input, plan: cohort, binding: {...input.binding, revision_id: 'revision-2'}});
  assert.equal(stale.outcome, 'blocked'); assert.equal(stale.freshness, 'stale');
  assert.equal(evaluateAnalyticPlan({...input, plan: {...cohort, minimum_denominator: 1001}}).outcome, 'inconclusive');
  assert.equal(evaluateAnalyticPlan({...input, plan: cohort, evidence: []}).outcome, 'blocked');
  const temporal = makePlan(input.binding, 'temporal_alignment', [], 'decrease');
  assert.equal(evaluateAnalyticPlan({...input, plan: temporal, metric_definition: undefined}).outcome, 'blocked');
  const unknown = {...input.evidence[0]!, event_time: {kind: 'unknown' as const, raw_description: 'Release occurrence unavailable'}};
  assert.equal(evaluateAnalyticPlan({...input, plan: temporal, evidence: [unknown]}).outcome, 'inconclusive');
  const forged = structuredClone(input.metric_result); forged.baseline!.rate = 0.99;
  assert.throws(() => evaluateAnalyticPlan({...input, plan: cohort, metric_result: forged}), errorCode('INVALID_METRIC_RESULT'));
  assert.throws(() => evaluateAnalyticPlan({...input, plan: {...cohort, sql: 'SELECT 1'} as FaultlineAnalyticPlan}), errorCode('INVALID_INPUT'));
  assert.throws(() => evaluateAnalyticPlan({...input, plan: cohort, evidence: [{...input.evidence[0]!, workspace_id: 'other-workspace'}]}), errorCode('EVIDENCE_NOT_ACCESSIBLE'));
  assert.throws(() => createManualHypothesis('unsafe', input.binding, {...input.hypothesis, origin: 'model'} as unknown as ManualHypothesisFields, input.evidence), errorCode('INVALID_MANUAL_HYPOTHESIS'));
  const failedPrediction = evaluateAnalyticPlan({...input, plan: {...cohort, expected_direction: 'increase'}});
  assert.equal(failedPrediction.outcome, 'failed'); assert.equal(failedPrediction.attribution.causal_effect, 'not_established');
  assert.throws(() => strictBody(analyticResultSchema, {...failedPrediction, executable: 'arbitrary script'}), errorCode('INVALID_INPUT'));
});
