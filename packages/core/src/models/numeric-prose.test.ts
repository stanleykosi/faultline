import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {FaultlineModelResponse} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {DomainError} from '../errors.js';
import {assertNumberFreeModelProse,assertNumberFreeModelText,NUMBER_FREE_MODEL_TEXT_PATTERN,ModelNumericProseError} from './numeric-prose.js';

const response: FaultlineModelResponse = {
  schema_version: 1, kind: 'hypotheses', revision_id: 'revision-2026-20-11', input_hash: '0123456789abcdef'.repeat(4),
  hypotheses: [{title: 'Checkout control mismatch', statement: 'The checkout interaction may explain a within-cohort decline; inspect the cited comparison.', supporting_evidence_ids: ['evidence-20-11-99'], contradicting_evidence_ids: ['evidence-2500'], missing_evidence: ['Independent denominator review is unavailable.'], falsifier: 'A protected comparison showing unchanged checkout behavior would contradict the proposed mechanism.', proposed_test_kinds: ['data_quality', 'mechanism']}],
  draft_sentences: [{text: 'The recorded association is observational; quantitative values belong to the deterministic comparison.', evidence_ids: ['evidence-1234567890'], qualification: 'observed'}],
  questions: ['Is the denominator complete?', 'Could changed traffic composition account for the direction of the observed change?'],
  limitations: ['A captured release does not establish deployment or aggregate causation.']
};
const fresh = (): FaultlineModelResponse => structuredClone(response);
function freeze(value: unknown): void {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}}
function rejected(value: FaultlineModelResponse): DomainError {
  let error: unknown; try {assertNumberFreeModelProse(value);} catch (caught) {error = caught;}
  assert.ok(error instanceof DomainError); assert.equal(error.code, 'MODEL_NUMERIC_CLAIM_UNSUPPORTED'); assert.equal(error.status, 422); return error;
}

test('qualitative direction and denominator questions pass while numeric IDs, hashes and structural schema fields remain untouched', () => {
  for (const kind of ['hypotheses', 'critique', 'diagnosis_draft'] as const) {
    const value = {...fresh(), kind}; validateContract('model-response', value); const before = JSON.stringify(value); freeze(value); assert.equal(assertNumberFreeModelProse(value), undefined); assert.equal(JSON.stringify(value), before);
  }
  const value = fresh(); value.draft_sentences[0]!.text = 'Someone should inspect the standalone checkout control, the height of the modal and the stone-colored button.'; assert.doesNotThrow(() => assertNumberFreeModelProse(value));
});

test('explicit incorrect rates, denominators, signed values and scientific literals are rejected with no echoed model text', () => {
  for (const prose of ['Conversion fell from 20% to 11%, so the observed conversion is 99%.', 'The denominator was 2500 sessions.', 'The delta is -9.5 percentage points.', 'The effect is −0.09.', 'Eligible sessions total 2.5e3.', '<script>claim(99)</script>', 'CONFIDENTIAL_AUTHORED_MARKER: 1234 sessions']) {
    const value = fresh(); value.draft_sentences[0]!.text = prose; const before = JSON.stringify(value); freeze(value); const error = rejected(value); assert.equal(error.message, 'Model prose must be number-free. Use deterministic metric panels and cited evidence for quantitative values.'); assert.ok(!error.message.includes(prose)); assert.ok(!error.message.includes('CONFIDENTIAL_AUTHORED_MARKER')); assert.equal(JSON.stringify(value), before);
  }
});

test('Unicode numeric categories, compatibility spellings and percentage/per-mille symbols cannot evade the finite guard', () => {
  for (const prose of ['９９％ conversion', '٩٩٪ conversion', '९९ sessions', '² samples', '⑳ records', 'Ⅷ sessions', '¼ of the sessions', '𝟚𝟝𝟘𝟘 eligible', 'Conversion ‰', 'Conversion ‱', 'Conversion ﹪', '𝕥𝕨𝕖𝕟𝕥𝕪 sessions', 'ﬁrst cohort', 'twen\u200bty sessions']) {
    const value = fresh(); value.questions = [prose]; rejected(value);
  }
});

test('finite English cardinal, ordinal, fraction and multiplier spellings reject amounts regardless of punctuation or case', () => {
  for (const prose of ['zero conversion', 'ONE session', 'nineteen converted', 'twenty-one sessions', 'Thirty eligible', 'ninety records', 'a hundred sessions', 'Thousands of entries', 'million records', 'billion events', 'trillion entries', 'FIRST cohort', 'the tenth observation', 'eleventh cohort', 'twentieth observation', 'hundredth entry', 'a half of the sessions', 'a quarter of traffic', 'three-quarters converted', 'two thirds converted', 'dozens of records', 'conversion doubled', 'a TWICE measured effect']) {
    const value = fresh(); value.limitations = [prose]; rejected(value);
  }
});

test('each declared prose field is independently checked; an optional mechanism field receives no schema authority', () => {
  const writers: {name: string; write: (value: FaultlineModelResponse) => void}[] = [
    {name: 'hypothesis title', write: value => {value.hypotheses[0]!.title = '99 sessions';}},
    {name: 'hypothesis statement', write: value => {value.hypotheses[0]!.statement = '99 sessions';}},
    {name: 'hypothesis falsifier', write: value => {value.hypotheses[0]!.falsifier = '99 sessions';}},
    {name: 'missing evidence', write: value => {value.hypotheses[0]!.missing_evidence = ['99 sessions'];}},
    {name: 'draft sentence', write: value => {value.draft_sentences[0]!.text = '99 sessions';}},
    {name: 'question', write: value => {value.questions = ['99 sessions'];}},
    {name: 'limitation', write: value => {value.limitations = ['99 sessions'];}}
  ];
  for (const {name, write} of writers) {const value = fresh(); write(value); validateContract('model-response', value); assert.equal(rejected(value).code, 'MODEL_NUMERIC_CLAIM_UNSUPPORTED', name);}
  const value = fresh(); Object.assign(value.hypotheses[0]!, {mechanism_description: '99 sessions'}); rejected(value); assert.throws(() => validateContract('model-response', value), 'The leaf does not authorize a new model-response schema field.');
});

test('a number-free passage does not gain factual, causal or protected-verification authority from passing this lexical policy', () => {
  const value = fresh(); value.draft_sentences[0]!.text = 'The release definitely caused the entire decline and the correction is validated.';
  assert.doesNotThrow(() => assertNumberFreeModelProse(value), 'This boundary must not masquerade as a universal semantic truth verifier; independent claim protection remains mandatory.');
});

test('provider text pattern rejects numeric symbols and case variants of complete finite number words',()=>{
 const pattern=new RegExp(NUMBER_FREE_MODEL_TEXT_PATTERN,'u');
 for(const text of ['20% conversion','٩ sessions','Ⅷ samples','FIRST cohort','fIrSt cohort','One alternative','twenty-one sessions','A half of traffic','TWICE measured','Conversion doubled','dozens of entries','trillionth observation'])assert.equal(pattern.test(text),false,text);
 for(const text of ['The device mix changed while cohort conversion held steady.','Someone should review the baseline.','The mechanism remains untested.','Follow-up is observational; aggregate causation is not established.'])assert.equal(pattern.test(text),true,text);
 assert.equal(pattern.test('twen\u200bty sessions'),true,'Wire pattern is supplementary, not a replacement for normalization.');
 assert.throws(()=>assertNumberFreeModelText('twen\u200bty sessions'),{code:'MODEL_NUMERIC_CLAIM_UNSUPPORTED'});
});

test('numeric diagnostics contain only a finite category and known forbidden word, never provider prose',()=>{
 try{assertNumberFreeModelText('PRIVATE_PROVIDER_MARKER: the FIRST cohort changed.');assert.fail('Expected rejection');}catch(error){assert.ok(error instanceof ModelNumericProseError);assert.deepEqual(error.issue,{kind:'number_word',word:'first'});assert.ok(Object.isFrozen(error.issue));assert.doesNotMatch(JSON.stringify(error.issue),/PRIVATE_PROVIDER_MARKER|cohort/);}
 assert.deepEqual(new ModelNumericProseError('number_word','PRIVATE_PROVIDER_MARKER').issue,{kind:'number_symbol'});
 assert.deepEqual(new ModelNumericProseError('number_symbol').issue,{kind:'number_symbol'});
});
