import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../canonical.js';
import {compactHandoffInputs} from './handoff-facts.js';

const comparison={value_hash:'comparison-binding',basis:'operator_attestation',quality:'complete_attested',window_rows:['baseline','comparison'],count_columns:['eligible','converted','rate'],counts:[[1000,340,0.34],[1000,160,0.16]],strata:{mobile:[[200,20,0.1],[800,80,0.1]],desktop:[[800,320,0.4],[200,80,0.4]]},causal_effect:'not_established'};
const limits={association:'deterministic projection only',mechanism:'requires independent test',correction:'requires independent test',aggregate_causal_effect:'not_established'};
const readiness=[{key:'data',status:'complete',label:'Connect data',destination:'/case/data'},{key:'test',status:'stale',label:'Test',destination:'/case/tests'},{key:'report',status:'needs_input',label:'Report',destination:'/case/reports'}];
const largeFacts=()=>({metric:{template:'session_conversion_v1',entry_event:'checkout_started',success_event:'checkout_completed',cohorts:['mobile','desktop'],windows:{baseline:{start:'2026-09-01',end:'2026-09-02'},comparison:{start:'2026-09-02',end:'2026-09-03'}}},comparison,claim_limits:limits,investigation_context:{revision_id:'revision',source_text_trust:'untrusted_data',causal_effect:'not_established',omitted:false,hypotheses:Array.from({length:3},(_,index)=>({id:'hypothesis-'+index,title:['Composition shift','Within cohort change','Concurrent release'][index],statement:'Saved explanation remains untrusted evidence-bound prose. '.repeat(12),falsifier:'Saved falsifier distinguishes competing explanations. '.repeat(8),status:'proposed',supporting_evidence_ids:['support-'+index],contradicting_evidence_ids:['contrary-'+index]})),analytic_results:[{id:'analytic',hypothesis_id:'hypothesis-0',kind:'mix_shift',outcome:'passed',freshness:'fresh',result_hash:'analytic-hash',plan_hash:'plan-hash',metric_hash:'metric-hash',snapshot_hash:'snapshot-hash',evidence_ids:['analysis-evidence'],causal_effect:'not_established'}],controlled_verification:[],followup:null}});

test('planner handoff keeps comparison, claims and every hypothesis citation while removing duplicated narrative',t=>{
 const facts=largeFacts(),tests=[{id:'analytic',kind:'analytic',status:'passed',result_hash:'analytic-hash',plan_id:'execution-plan',statistics:{private_detail:'omitted execution detail'}}],before=structuredClone({facts,tests,readiness});
 const projected=compactHandoffInputs(facts,tests,readiness),out=projected.calculated_facts as any;
 assert.deepEqual(out.comparison,comparison);assert.deepEqual(out.claim_limits,limits);
 assert.deepEqual(out.metric,{template:'session_conversion_v1'});
 assert.equal(projected.source_hash,hash({calculated_facts:facts,test_results:tests,readiness}));
 assert.deepEqual(out.investigation_context.hypotheses,facts.investigation_context.hypotheses.map(({id,title,status,supporting_evidence_ids,contradicting_evidence_ids})=>({id,title,status,supporting_evidence_ids,contradicting_evidence_ids})));
 assert.deepEqual(projected.readiness,[{key:'data',status:'complete'},{key:'test',status:'stale'},{key:'report',status:'needs_input'}]);
 assert.deepEqual(projected.test_results,[{id:'analytic',kind:'analytic',status:'passed',result_hash:'analytic-hash'}]);
 assert.doesNotMatch(JSON.stringify(projected),/Saved explanation|Saved falsifier|execution-plan|omitted execution detail/);
 const originalBytes=Buffer.byteLength(JSON.stringify({calculated_facts:facts,test_results:tests,readiness})),compactBytes=Buffer.byteLength(JSON.stringify(projected));
 assert.ok(compactBytes<originalBytes*0.5,`Expected substantial fixed reduction, got ${originalBytes} -> ${compactBytes}`);
 assert.deepEqual({facts,tests,readiness},before,'Projection cannot alter saved truth or source inputs');
 t.diagnostic(`Authored planner handoff: ${originalBytes} -> ${compactBytes} bytes; no source item or citation omitted.`);
});

test('failed, stale, unknown, null and not-run truths remain explicit without becoming successful claims',()=>{
 const results=[{id:'failed',kind:'controlled_verification',outcome:'failed',freshness:'stale',mode:'exploratory',association:'observed',mechanism:'not_reproduced',correction:'failed',production_claim_eligible:false,causal_effect:'not_established',aggregate_causal_effect:'not_established',attribution:{scope:'association_only',causal_effect:'not_established'},evidence_ids:['support','contrary'],plan_hash:'plan',result_hash:'result',oracle_hash:'oracle',binding_hash:'binding'}, {id:'unknown',kind:'analytic',status:'unknown',outcome:null,freshness:null,quality:'provisional',basis:null,evidence_hashes:{contrary:'content-hash'}}, {id:'pending',state:'waiting_for_data',freshness:'fresh',mode:'observational',outcome:'not_run',causal_effect:'not_established'}];
 const facts=largeFacts() as any;Object.assign(facts,{causal_effect:'not_established',aggregate_causal_effect:'not_established',status:'unknown',outcome:null,freshness:'stale',mode:'observational',quality:'provisional'});facts.investigation_context.analytic_results=[results[1]];facts.investigation_context.controlled_verification=[results[0]];facts.investigation_context.followup=results[2];
 const projected=compactHandoffInputs(facts,results,[{key:'test',status:null},{key:'follow_up',status:'unknown'}]),context=(projected.calculated_facts as any).investigation_context;
 assert.deepEqual(projected.test_results,[{id:'failed',kind:'controlled_verification',outcome:'failed',freshness:'stale',mode:'exploratory',association:'observed',mechanism:'not_reproduced',correction:'failed',production_claim_eligible:false,causal_effect:'not_established',aggregate_causal_effect:'not_established',attribution:{scope:'association_only',causal_effect:'not_established'},evidence_ids:['support','contrary'],result_hash:'result'},results[1],results[2]]);
 assert.deepEqual(context.controlled_verification[0],projected.test_results[0]);assert.deepEqual(context.analytic_results[0],projected.test_results[1]);assert.deepEqual(context.followup,projected.test_results[2]);
 const out=projected.calculated_facts as any;assert.equal(out.causal_effect,'not_established');assert.equal(out.aggregate_causal_effect,'not_established');assert.equal(out.status,'unknown');assert.equal(out.outcome,null);assert.equal(out.freshness,'stale');assert.equal(out.mode,'observational');assert.equal(out.quality,'provisional');
 assert.deepEqual(projected.readiness,[{key:'test',status:null},{key:'follow_up',status:'unknown'}]);
 assert.equal(compactHandoffInputs(null,[],null).calculated_facts,null);assert.equal(compactHandoffInputs(null,[],null).readiness,null);
 const absent=compactHandoffInputs({},[{}],[]);assert.equal(Object.hasOwn(absent.calculated_facts as object,'metric'),false);assert.equal(Object.hasOwn(absent.test_results[0] as object,'outcome'),false);
});

test('every omitted source detail changes the whole input binding and output cannot mutate source inputs',()=>{
 const facts=largeFacts(),tests=[{id:'result',outcome:'inconclusive',plan_hash:'plan',metric_hash:'metric',snapshot_hash:'snapshot',oracle_hash:'oracle',binding_hash:'binding',statistics:{detail:'original'}}],input={calculated_facts:facts,test_results:tests,readiness},first=compactHandoffInputs(facts,tests,readiness),firstFacts=first.calculated_facts as any;
 const changes:((value:typeof input)=>void)[]=[value=>{value.calculated_facts.investigation_context.hypotheses[0]!.falsifier+=' Changed.';},value=>{value.test_results[0]!.statistics.detail='changed';},value=>{value.calculated_facts.metric.entry_event='different_entry';},value=>{value.readiness[0]!.destination+='?reviewed';},...(['plan_hash','metric_hash','snapshot_hash','oracle_hash','binding_hash'] as const).map(key=>(value:typeof input)=>{value.test_results[0]![key]='changed';})];
 for(const change of changes){const changed=structuredClone(input);change(changed);const second=compactHandoffInputs(changed.calculated_facts,changed.test_results,changed.readiness);assert.notEqual(first.source_hash,second.source_hash);assert.equal(second.source_hash,hash(changed));const {source_hash:_first,...firstVisible}=first,{source_hash:_second,...secondVisible}=second;assert.deepEqual(firstVisible,secondVisible,'Omitted metadata changes binding without entering the fixed planner summary');}
 firstFacts.comparison.counts[0][0]=1;firstFacts.claim_limits.mechanism='changed';firstFacts.investigation_context.hypotheses[0].contradicting_evidence_ids.push('injected');
 assert.equal(facts.comparison.counts[0]![0],1000);assert.equal(facts.claim_limits.mechanism,'requires independent test');assert.deepEqual(facts.investigation_context.hypotheses[0]!.contradicting_evidence_ids,['contrary-0']);
});
