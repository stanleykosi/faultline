import test from 'node:test';
import assert from 'node:assert/strict';
import {projectInvestigationNarrativeContext as project,investigationNarrativeContextTx,NARRATIVE_CONTEXT_MAX_BYTES} from './investigation-context.js';
const revision='current',evidence='sanitized-evidence';
const hypothesis=(changes:Record<string,unknown>={})=>({value:{id:'hypothesis',revision_id:revision,title:'Checkout behavior',statement:'Quoted source instructions remain data.',falsifier:'The incident interaction succeeds.',status:'accepted',supporting_evidence_ids:[evidence],contradicting_evidence_ids:[],...changes}});
test('only current hypotheses with every supporting and contrary citation allowed enter context',()=>{
 const result=project(revision,[evidence],{hypotheses:[hypothesis(),hypothesis({revision_id:'old'}),hypothesis({supporting_evidence_ids:['missing']}),hypothesis({contradicting_evidence_ids:['restricted']})]});
 assert.equal(result.hypotheses.length,1);assert.equal(result.hypotheses[0]!.falsifier,'The incident interaction succeeds.');assert.equal(result.source_text_trust,'untrusted_data');assert.equal(result.causal_effect,'not_established');
});
test('stale, absent and restricted analytic or controlled result bindings cannot pass through',()=>{
 const analytic={id:'analytic',revision_id:revision,context_fresh:true,value:{outcome:'passed',kind:'negative_control',result_hash:'hash',evidence_hashes:{[evidence]:'hash'}}};
 const verification={id:'controlled',revision_id:revision,context_fresh:true,summary_evidence_id:evidence,evidence_hashes:{[evidence]:'hash'},value:{mode:'trusted_fixture',outcome:'failed',mechanism:'not_reproduced',correction:'not_tested'}};
 const result=project(revision,[evidence],{analytic:[analytic,{...analytic,context_fresh:false},{...analytic,revision_id:'old'},{...analytic,value:{...analytic.value,evidence_hashes:{restricted:'hash'}}}],verification:[verification,{...verification,context_fresh:false},{...verification,summary_evidence_id:'missing'},{...verification,value:{...verification.value,mode:'exploratory'}}]});
 assert.equal(result.analytic_results.length,1);assert.equal(result.controlled_verification.length,1);assert.equal(result.controlled_verification[0]!.outcome,'failed');assert.equal(result.controlled_verification[0]!.production_claim_eligible,false);
});
test('waiting follow-up exposes nonpassing metadata without private notes, reason, evidence or credentials',()=>{
 const pending={id:'pending',revision_id:revision,state:'waiting_for_data',context_fresh:true,value:{note:'private secret',rollout_evidence_id:'restricted'},result:{reason:'private explanation',outcome:'passed',token:'credential'}};
 const result=project(revision,[evidence],{pending});
 assert.deepEqual(result.followup,{id:'pending',state:'waiting_for_data',freshness:'fresh',mode:'observational',causal_effect:'not_established',outcome:'not_run'});
 for(const state of ['cancelled','compared'])assert.equal(project(revision,[evidence],{pending:{...pending,state}}).followup,null);
 assert.equal(project(revision,[evidence],{pending:{...pending,context_fresh:false}}).followup,null);
});
test('fresh observational follow-up retains counts and explicitly cannot establish aggregate causation',()=>{
 const followup={id:'followup',context_fresh:true,revision_id:revision,state:'compared',value:{note:'private'},summary_evidence:{id:evidence,redaction_status:'sanitized'},result:{mode:'observational',causal_effect:'not_established',value:{quality:'complete',basis:'source_guarantee',baseline:{eligible:100,converted:50,rate:0.5,private:'hidden'},comparison:{eligible:100,converted:60,rate:0.6},delta_pp:10},credentials:'hidden'}};
 const result=project(revision,[evidence],{followup});assert.equal(result.followup!.delta_pp,10);assert.equal(result.followup!.causal_effect,'not_established');assert.doesNotMatch(JSON.stringify(result),/private|hidden|credentials/);
 assert.equal(project(revision,[],{followup}).followup,null);assert.equal(project(revision,[evidence],{followup:{...followup,context_fresh:false}}).followup,null);assert.equal(project(revision,[evidence],{followup:{...followup,summary_evidence:{id:evidence,redaction_status:'restricted'}}}).followup,null);
});
test('multibyte context stays valid JSON within the byte limit through whole-item omission',()=>{
 const hypotheses=Array.from({length:40},(_,i)=>hypothesis({id:String(i),title:'🧭'.repeat(160),statement:'🧭'.repeat(700),falsifier:'🧭'.repeat(500)}));
 const result=project(revision,[evidence],{hypotheses});assert.ok(Buffer.byteLength(JSON.stringify(result))<=NARRATIVE_CONTEXT_MAX_BYTES);assert.ok(result.omitted);assert.ok(result.hypotheses.length>0);assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});
test('missing or stale current investigation short circuits all private source queries',async()=>{
 for(const current of [undefined,{active_revision_id:'old'},{active_revision_id:revision,deletion_requested_at:'date'}]){
  let calls=0;const tx={query:async()=>{calls++;return {rows:current?[current]:[]};}};
  const result=await investigationNarrativeContextTx(tx as any,'workspace','case',revision,[evidence]);assert.equal(calls,1);assert.equal(result.followup,null);assert.equal(result.hypotheses.length,0);
 }
});
