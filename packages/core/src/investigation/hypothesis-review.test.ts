import test from 'node:test';
import assert from 'node:assert/strict';
import {createManualHypothesis,reviseHypothesis,validateManualHypothesis,type InvestigationBinding} from './analytic.js';
import {DomainError} from '../errors.js';
const binding:InvestigationBinding={workspace_id:'workspace-review',case_id:'case-review',revision_id:'revision-original',metric_hash:'a'.repeat(64),snapshot_hash:'b'.repeat(64)};
const fields={title:'Competing mechanism',statement:'A mobile failure could explain the selected symptom.',mechanism_description:'A form could reject the expected input.',falsifier:'The incident arm accepts the same input.',proposed_test_kinds:['mechanism'] as const};
function original(){return createManualHypothesis('hypothesis-review',binding,{...fields,proposed_test_kinds:[...fields.proposed_test_kinds]});}
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
test('accepted model proposal can be revised, dismissed and reopened while its original authorship and old value remain immutable',()=>{
 const old={...original(),origin:'model' as const},before=JSON.stringify(old),current={...binding,revision_id:'revision-current'};
 const edited=reviseHypothesis(old,{statement:'A competing source-quality explanation remains open.',status:'rejected'},current,[]);
 assert.equal(edited.origin,'model');assert.equal(edited.status,'rejected');assert.equal(edited.id,old.id);assert.equal(edited.revision_id,current.revision_id);assert.equal(JSON.stringify(old),before);
 const reopened=reviseHypothesis(edited,{status:'needs_evidence',missing_evidence:['An independently reviewed incident comparison.']},current,[]);
 assert.equal(reopened.origin,'model');assert.equal(reopened.status,'needs_evidence');assert.deepEqual(reopened.missing_evidence,['An independently reviewed incident comparison.']);
});
test('authorship, identity, verified fields and cross-case edits cannot be injected into either authorship path',()=>{
 for(const origin of ['human','model'] as const){const old={...original(),origin};for(const field of ['origin','id','workspace_id','case_id','revision_id','schema_version','claim','confidence'])assert.throws(()=>reviseHypothesis(old,{[field]:'invented'},binding,[]),code('PROTECTED_HYPOTHESIS_FIELD'));}
 assert.throws(()=>reviseHypothesis(original(),{title:'Changed'},{...binding,case_id:'other-case'},[]),code('INVESTIGATION_NOT_ACCESSIBLE'));
 assert.throws(()=>createManualHypothesis('new',binding,{...fields,proposed_test_kinds:[...fields.proposed_test_kinds],origin:'model'} as any),code('INVALID_MANUAL_HYPOTHESIS'));
 assert.throws(()=>validateManualHypothesis({...original(),origin:'model'},binding,[]),code('INVALID_HYPOTHESIS_ORIGIN'));
});
test('reviewed model authorship never relaxes finite test kinds, citations or canonical status',()=>{
 const old={...original(),origin:'model' as const};
 assert.throws(()=>reviseHypothesis(old,{supporting_evidence_ids:['absent-evidence']},binding,[]),code('EVIDENCE_NOT_ACCESSIBLE'));
 assert.throws(()=>reviseHypothesis(old,{proposed_test_kinds:['mechanism','mechanism']},binding,[]),code('DUPLICATE_TEST_KIND'));
 assert.throws(()=>reviseHypothesis(old,{status:'verified'},binding,[]));
 const human=reviseHypothesis(original(),{status:'needs_evidence'},binding,[]);assert.equal(human.origin,'human');
});
