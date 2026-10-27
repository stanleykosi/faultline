import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hash} from '../canonical.js';
import {DomainError} from '../errors.js';
import {normalizeAnalytics} from '../imports/parser.js';
import {computeComparison, type MixShiftResult} from '../metrics/comparison.js';
import {strictBody, validateContract} from '../../../contracts/src/validate.js';
import {type FaultlineAnalyticPlan, type FaultlineCoverage, type FaultlineEvidence, type FaultlineMetric, type FaultlineCanonicalEvent} from '../../../contracts/src/generated.js';
import {analyticResultSchema, createManualHypothesis, evaluateAnalyticPlan, type AnalyticInputs, type CohortObservation, type InvestigationBinding, type ManualHypothesisFields, type TemporalDetails, reviseHypothesis, validateManualHypothesis} from './analytic.js';
import asyncFs from 'node:fs/promises';
import {computeFollowupComparison, followupEvidenceBindingFresh} from '../collaboration/service.js';
import {normalizeEventTime, eventMicros} from '../imports/time.js';

// analytic
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

// hypothesis review
const binding:InvestigationBinding={workspace_id:'workspace-review',case_id:'case-review',revision_id:'revision-original',metric_hash:'a'.repeat(64),snapshot_hash:'b'.repeat(64)};
const fields={title:'Competing mechanism',statement:'A mobile failure could explain the selected symptom.',mechanism_description:'A form could reject the expected input.',falsifier:'The incident arm accepts the same input.',proposed_test_kinds:['mechanism'] as const};
function original(){return createManualHypothesis('hypothesis-review',binding,{...fields,proposed_test_kinds:[...fields.proposed_test_kinds]});}
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
test("hypothesis review preserves authorship and rejects forged authority, test kinds or citations", () => {
 // accepted model proposal can be revised, dismissed and reopened while its original authorship and old value remain immutable
 {
  const old={...original(),origin:'model' as const},before=JSON.stringify(old),current={...binding,revision_id:'revision-current'};
    const edited=reviseHypothesis(old,{statement:'A competing source-quality explanation remains open.',status:'rejected'},current,[]);
    assert.equal(edited.origin,'model');assert.equal(edited.status,'rejected');assert.equal(edited.id,old.id);assert.equal(edited.revision_id,current.revision_id);assert.equal(JSON.stringify(old),before);
    const reopened=reviseHypothesis(edited,{status:'needs_evidence',missing_evidence:['An independently reviewed incident comparison.']},current,[]);
    assert.equal(reopened.origin,'model');assert.equal(reopened.status,'needs_evidence');assert.deepEqual(reopened.missing_evidence,['An independently reviewed incident comparison.']);
 }
 // authorship, identity, verified fields and cross-case edits cannot be injected into either authorship path
 {
  for(const origin of ['human','model'] as const){const old={...original(),origin};for(const field of ['origin','id','workspace_id','case_id','revision_id','schema_version','claim','confidence'])assert.throws(()=>reviseHypothesis(old,{[field]:'invented'},binding,[]),code('PROTECTED_HYPOTHESIS_FIELD'));}
    assert.throws(()=>reviseHypothesis(original(),{title:'Changed'},{...binding,case_id:'other-case'},[]),code('INVESTIGATION_NOT_ACCESSIBLE'));
    assert.throws(()=>createManualHypothesis('new',binding,{...fields,proposed_test_kinds:[...fields.proposed_test_kinds],origin:'model'} as any),code('INVALID_MANUAL_HYPOTHESIS'));
    assert.throws(()=>validateManualHypothesis({...original(),origin:'model'},binding,[]),code('INVALID_HYPOTHESIS_ORIGIN'));
 }
 // reviewed model authorship never relaxes finite test kinds, citations or canonical status
 {
  const old={...original(),origin:'model' as const};
    assert.throws(()=>reviseHypothesis(old,{supporting_evidence_ids:['absent-evidence']},binding,[]),code('EVIDENCE_NOT_ACCESSIBLE'));
    assert.throws(()=>reviseHypothesis(old,{proposed_test_kinds:['mechanism','mechanism']},binding,[]),code('DUPLICATE_TEST_KIND'));
    assert.throws(()=>reviseHypothesis(old,{status:'verified'},binding,[]));
    const human=reviseHypothesis(original(),{status:'needs_evidence'},binding,[]);assert.equal(human.origin,'human');
 }
});

// service
test('privileged binding accepts intact restricted evidence without making it eligible for sanitized projection',()=>{
 const expected='a'.repeat(64),other='b'.repeat(64),restricted={redaction_status:'restricted' as const,content_hash:expected},sanitized={redaction_status:'sanitized' as const,content_hash:expected},withdrawn={redaction_status:'withdrawn' as const,content_hash:expected};
 assert.equal(followupEvidenceBindingFresh(sanitized,expected),true);assert.equal(followupEvidenceBindingFresh(restricted,expected),false);assert.equal(followupEvidenceBindingFresh(restricted,expected,true),true);
 for(const privileged of [false,true]){assert.equal(followupEvidenceBindingFresh(withdrawn,expected,privileged),false);assert.equal(followupEvidenceBindingFresh({...restricted,content_hash:other},expected,privileged),false);assert.equal(followupEvidenceBindingFresh({...sanitized,content_hash:other},expected,privileged),false);assert.equal(followupEvidenceBindingFresh(undefined,expected,privileged),false);}
});
test('future-only follow-up retains immutable independent baseline, complete tail and observational counts',async()=>{
 const load=async(name:string)=>JSON.parse(await asyncFs.readFile(new URL("../../../../fixtures/regression/"+name,import.meta.url),'utf8')),metric=await load('metric.json'),originalCoverage=await load('coverage.json'),expected=await load('expected.json'),original:FaultlineCanonicalEvent[]=(await load('events.json')).map((e:FaultlineCanonicalEvent)=>({...e,occurred_at:normalizeEventTime(e.occurred_at)}));
 const window={start:'2026-09-04T00:00:00.000Z',end:'2026-09-05T00:00:00.000Z'},freshCoverage={...originalCoverage,covered_start:window.start,covered_end:'2026-09-05T00:30:00.000Z',event_watermark:'2026-09-05T00:30:00.000Z',event_time_intervals:[{start:window.start,end:'2026-09-05T00:30:00.000Z'}]},fresh=original.filter(e=>e.occurred_at.startsWith('2026-09-01')).map(e=>({...e,event_id:'followup-'+e.event_id,session_id:'followup-'+e.session_id,occurred_at:e.occurred_at.replace('2026-09-01','2026-09-04')}));
 const result=computeFollowupComparison(original,fresh,metric,originalCoverage,freshCoverage,window).value;assert.equal(result.quality,'complete_attested');assert.equal(result.baseline?.eligible,1000);assert.equal(result.baseline?.converted,200);assert.equal(result.baseline?.rate,expected.baseline_rate);assert.equal(result.comparison?.eligible,1000);assert.equal(result.comparison?.converted,200);assert.equal(result.comparison?.rate,expected.baseline_rate);assert.equal(result.delta_pp,0);
 // The fresh watermark and the original watermark each independently constrain their own tail.
 for(const [baseline,later]of [[originalCoverage,{...freshCoverage,event_watermark:window.end}],[{...originalCoverage,event_watermark:metric.windows.baseline.end},freshCoverage],[originalCoverage,{...freshCoverage,extraction_status:'partial'}]] as const)assert.equal(computeFollowupComparison(original,fresh,metric,baseline,later,window).value.quality,'incomplete');
 assert.equal(computeFollowupComparison(original,fresh,metric,originalCoverage,{...freshCoverage,basis:'lateness_assumption',assumptions:['Explicit local fixture lateness assumption.']},window).value.quality,'provisional');
 assert.throws(()=>computeFollowupComparison(original,[{...fresh[0]!,source_id:'other-source'}],metric,originalCoverage,freshCoverage,window),/same logical source/);
 // An inclusive success horizon preserves six fractional digits without Date rounding.
 const entry={...fresh[0]!,event_id:'boundary-entry',session_id:'boundary',occurred_at:'2026-09-04T23:59:59.999999Z'},success={...entry,event_id:'boundary-success',event_name:metric.success_event,occurred_at:'2026-09-05T00:29:59.999999Z'};assert.equal(eventMicros(success.occurred_at)-eventMicros(entry.occurred_at),1_800_000_000n);assert.equal(computeFollowupComparison(original,[entry,success],metric,originalCoverage,freshCoverage,window).value.comparison?.converted,1);
});
