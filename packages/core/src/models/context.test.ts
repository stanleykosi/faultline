import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectInvestigationNarrativeContext as project, investigationNarrativeContextTx, NARRATIVE_CONTEXT_MAX_BYTES} from './investigation-context.js';
import fs from 'node:fs';
import {comparisonPromptFacts, coveragePromptFacts, reportNarrativeFacts} from './prompt-facts.js';
import {proposalContext, wireBody, proposalWireSchema} from './gateway.js';
import {modelRequestReadiness, requireModelBudget} from './budget-status.js';
import {hash} from '../canonical.js';

// investigation context
const revision='current',evidence='sanitized-evidence';
const hypothesis=(changes:Record<string,unknown>={})=>({value:{id:'hypothesis',revision_id:revision,title:'Checkout behavior',statement:'Quoted source instructions remain data.',falsifier:'The incident interaction succeeds.',status:'accepted',supporting_evidence_ids:[evidence],contradicting_evidence_ids:[],...changes}});
test("model narrative admits only fresh current hypotheses and authorized result citations", () => {
 // only current hypotheses with every supporting and contrary citation allowed enter context
 {
  const result=project(revision,[evidence],{hypotheses:[hypothesis(),hypothesis({revision_id:'old'}),hypothesis({supporting_evidence_ids:['missing']}),hypothesis({contradicting_evidence_ids:['restricted']})]});
    assert.equal(result.hypotheses.length,1);assert.equal(result.hypotheses[0]!.falsifier,'The incident interaction succeeds.');assert.equal(result.source_text_trust,'untrusted_data');assert.equal(result.causal_effect,'not_established');
 }
 // stale, absent and restricted analytic or controlled result bindings cannot pass through
 {
  const analytic={id:'analytic',revision_id:revision,context_fresh:true,value:{outcome:'passed',kind:'negative_control',result_hash:'hash',evidence_hashes:{[evidence]:'hash'}}};
    const verification={id:'controlled',revision_id:revision,context_fresh:true,summary_evidence_id:evidence,evidence_hashes:{[evidence]:'hash'},value:{mode:'trusted_fixture',outcome:'failed',mechanism:'not_reproduced',correction:'not_tested'}};
    const result=project(revision,[evidence],{analytic:[analytic,{...analytic,context_fresh:false},{...analytic,revision_id:'old'},{...analytic,value:{...analytic.value,evidence_hashes:{restricted:'hash'}}}],verification:[verification,{...verification,context_fresh:false},{...verification,summary_evidence_id:'missing'},{...verification,value:{...verification.value,mode:'exploratory'}}]});
    assert.equal(result.analytic_results.length,1);assert.equal(result.controlled_verification.length,1);assert.equal(result.controlled_verification[0]!.outcome,'failed');assert.equal(result.controlled_verification[0]!.production_claim_eligible,false);
 }
});

test("follow-up context retains observational counts and nonpassing private metadata boundaries", () => {
 // waiting follow-up exposes nonpassing metadata without private notes, reason, evidence or credentials
 {
  const pending={id:'pending',revision_id:revision,state:'waiting_for_data',context_fresh:true,value:{note:'private secret',rollout_evidence_id:'restricted'},result:{reason:'private explanation',outcome:'passed',token:'credential'}};
    const result=project(revision,[evidence],{pending});
    assert.deepEqual(result.followup,{id:'pending',state:'waiting_for_data',freshness:'fresh',mode:'observational',causal_effect:'not_established',outcome:'not_run'});
    for(const state of ['cancelled','compared'])assert.equal(project(revision,[evidence],{pending:{...pending,state}}).followup,null);
    assert.equal(project(revision,[evidence],{pending:{...pending,context_fresh:false}}).followup,null);
 }
 // fresh observational follow-up retains counts and explicitly cannot establish aggregate causation
 {
  const followup={id:'followup',context_fresh:true,revision_id:revision,state:'compared',value:{note:'private'},summary_evidence:{id:evidence,redaction_status:'sanitized'},result:{mode:'observational',causal_effect:'not_established',value:{quality:'complete',basis:'source_guarantee',baseline:{eligible:100,converted:50,rate:0.5,private:'hidden'},comparison:{eligible:100,converted:60,rate:0.6},delta_pp:10},credentials:'hidden'}};
    const result=project(revision,[evidence],{followup});assert.equal(result.followup!.delta_pp,10);assert.equal(result.followup!.causal_effect,'not_established');assert.doesNotMatch(JSON.stringify(result),/private|hidden|credentials/);
    assert.equal(project(revision,[],{followup}).followup,null);assert.equal(project(revision,[evidence],{followup:{...followup,context_fresh:false}}).followup,null);assert.equal(project(revision,[evidence],{followup:{...followup,summary_evidence:{id:evidence,redaction_status:'restricted'}}}).followup,null);
 }
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

// prompt facts
// Captured synthetic acceptance inputs; expectations and spent allowance predate this fix.
const fixture=JSON.parse(fs.readFileSync(new URL("./fixtures/recorded-report-budget.json",import.meta.url),'utf8'));
// Independent fixed expectations from the recorded count/coverage declarations.
const expectedComparison={value_hash:hash(fixture.comparison),basis:'operator_attestation',quality:'complete_attested',window_rows:['baseline','comparison'],count_columns:['eligible','converted','rate'],counts:[[1000,340,0.34],[1000,160,0.16]],unknown_cohort_count:[0,0],strata:{desktop:[[800,320,0.4],[200,80,0.4]],mobile:[[200,20,0.1],[800,80,0.1]]},delta_pp:-18.000000000000004,relative_change:-0.5294117647058824,intervals:'omitted_descriptive_only',causal_effect:'not_established'};
const report=()=>proposalContext(fixture.binding,'diagnosis_draft',fixture.evidence,{investigation_context:reportNarrativeFacts(fixture.narrative),evidence_selection:{included_records:fixture.evidence.length,record_limit_reached:false,byte_limit_excluded_records:0,scope:'Finite reviewed subset; not a complete event population.'},source_coverage:coveragePromptFacts(fixture.coverage),comparison:comparisonPromptFacts(fixture.comparison),claim_limits:{association:'deterministic projection only',mechanism:'requires independent protected experiment',correction:'requires independent protected experiment',aggregate_causal_effect:'not_established'}});

test('report preflight honestly accounts for the stronger prose schema without dropping frozen facts to fit a historical allowance',()=>{
 const before=JSON.stringify(fixture),context=report(),body=wireBody({provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model_name:fixture.model_name},context.messages,4000,'diagnosis_draft',Object.keys(context.evidence_hashes));
 const bytes=Buffer.byteLength(JSON.stringify(body))+256;
 assert.ok(bytes>8010,'The stronger numeric-prose schema no longer fits this historical remaining allowance.');
 assert.equal(modelRequestReadiness({...fixture.budget,remaining_input:8010},bytes).can_request,false);
 assert.ok(bytes<40000,'A fresh input allowance can hold this bounded request without increasing installation policy.');
 const input=JSON.parse(context.messages[1]!.content),facts=input.calculated_facts;
 assert.deepEqual(facts.comparison,expectedComparison);
 assert.equal(facts.investigation_context.hypotheses.rows.length,3);
 assert.ok(facts.source_coverage.limitations.some((s:string)=>s.startsWith('support has no usable')));
 assert.ok(facts.source_coverage.limitations.some((s:string)=>s.startsWith('release has no usable')));
 assert.equal(facts.investigation_context.analytic_results[0].outcome,'passed');
 assert.equal(facts.investigation_context.followup.state,'compared');assert.equal(facts.investigation_context.causal_effect,'not_established');
 assert.deepEqual(Object.keys(context.evidence_hashes).sort(),fixture.evidence.map((e:any)=>e.id).sort());
 assert.equal(input.wire_schema_hash,hash(proposalWireSchema('diagnosis_draft',Object.keys(context.evidence_hashes))));
 assert.equal(JSON.stringify(fixture),before,'Projection cannot mutate evidence, revision or past allowance');
 const exact={...fixture.budget,remaining_input:bytes};assert.equal(modelRequestReadiness(exact,bytes).can_request,true);
 assert.equal(modelRequestReadiness(exact,bytes+1).can_request,false);
 assert.throws(()=>requireModelBudget(exact,bytes+1),{code:'MODEL_BUDGET_EXHAUSTED'});
});

test("compact prompt facts preserve unknowns, warnings, citations and all frozen input bindings", t => {
 // omitted comparison detail still changes freshness; raw records and unsupported fields never enter prose context
 {
  const raw={...fixture.comparison,raw_sessions:['private session'],credential:'private credential'},first=comparisonPromptFacts(raw)!;
    const changed=comparisonPromptFacts({...raw,baseline:{...raw.baseline,interval:{...raw.baseline.interval,low:0.01}}})!;
    assert.notEqual(first.value_hash,changed.value_hash);assert.deepEqual(first.counts,changed.counts);assert.deepEqual(first.strata,changed.strata);
    assert.notEqual(first.value_hash,comparisonPromptFacts({...raw,credential:'changed private credential'})!.value_hash);
    assert.doesNotMatch(JSON.stringify(first),/private session|private credential|raw_sessions|credential/);
    const unknown=comparisonPromptFacts({quality:'provisional',baseline:{},comparison:{}})!;
    assert.equal(unknown.quality,'provisional');assert.deepEqual(unknown.counts,[[null,null,null],[null,null,null]]);assert.deepEqual(unknown.unknown_cohort_count,[null,null]);assert.deepEqual(unknown.strata,{});
    assert.equal(comparisonPromptFacts(null),null);
 }
 // fixed comparison table saves at least 150 bytes without dropping any selected recorded fact or full-input hash
 {
  const previous={value_hash:hash(fixture.comparison),basis:'operator_attestation',quality:'complete_attested',baseline:{eligible:1000,converted:340,rate:0.34,unknown_cohort_count:0,strata:{mobile:{eligible:200,converted:20,rate:0.1},desktop:{eligible:800,converted:320,rate:0.4}}},comparison:{eligible:1000,converted:160,rate:0.16,unknown_cohort_count:0,strata:{mobile:{eligible:800,converted:80,rate:0.1},desktop:{eligible:200,converted:80,rate:0.4}}},delta_pp:-18.000000000000004,relative_change:-0.5294117647058824,intervals:'omitted_descriptive_only',causal_effect:'not_established'};
    const projected=comparisonPromptFacts(fixture.comparison)!;
    assert.deepEqual(projected,expectedComparison);
    const originalBytes=Buffer.byteLength(JSON.stringify(previous)),compactBytes=Buffer.byteLength(JSON.stringify(projected));
    assert.equal(originalBytes,683);assert.ok(originalBytes-compactBytes>=150);
    t.diagnostic(`Recorded comparison: ${originalBytes} -> ${compactBytes} bytes; saved ${originalBytes-compactBytes} bytes; every selected fact and full-input hash retained.`);
 }
 // table keeps one-sided cohorts, unknown counts and absent windows distinct from zero or present rows
 {
  const input={basis:null,quality:'partial',baseline:{eligible:0,converted:0,rate:0,unknown_cohort_count:0,strata:{baseline_only:{eligible:9,converted:3,rate:1/3},shared:{eligible:null,converted:null,rate:null}}},comparison:{eligible:null,converted:2,rate:null,unknown_cohort_count:7,strata:{comparison_only:{eligible:8,converted:2,rate:0.25},shared:{eligible:0,converted:0,rate:0}}},delta_pp:0,relative_change:null};
    const before=JSON.stringify(input),facts=comparisonPromptFacts(input)!;
    assert.equal(facts.value_hash,hash(input));assert.equal(facts.basis,'unknown');assert.equal(facts.quality,'partial');
    assert.deepEqual(facts.window_rows,['baseline','comparison']);assert.deepEqual(facts.count_columns,['eligible','converted','rate']);
    assert.deepEqual(facts.counts,[[0,0,0],[null,2,null]]);assert.deepEqual(facts.unknown_cohort_count,[0,7]);
    assert.deepEqual(facts.strata,{baseline_only:[[9,3,1/3],null],comparison_only:[null,[8,2,0.25]],shared:[[null,null,null],[0,0,0]]});
    assert.equal(facts.delta_pp,0);assert.equal(facts.relative_change,null);assert.equal(facts.intervals,'omitted_descriptive_only');assert.equal(facts.causal_effect,'not_established');
    const absent=comparisonPromptFacts({basis:null,quality:null,baseline:{},comparison:null,delta_pp:null,relative_change:0})!;
    assert.equal(absent.basis,'unknown');assert.equal(absent.quality,'unknown');assert.deepEqual(absent.counts,[[null,null,null],null]);assert.deepEqual(absent.unknown_cohort_count,[null,null]);assert.deepEqual(absent.strata,{});assert.equal(absent.delta_pp,null);assert.equal(absent.relative_change,0);
    assert.equal(JSON.stringify(input),before);
    for(const invalid of [undefined,[],false,'not a comparison'])assert.equal(comparisonPromptFacts(invalid),null);
 }
 // coverage and narrative compacting retains every warning and contrary citation while binding omitted detail
 {
  const coverage=coveragePromptFacts(fixture.coverage);
    assert.deepEqual(new Set(coverage.limitations),new Set([...fixture.coverage.limitations,...fixture.coverage.sources.flatMap((s:any)=>s.limitations)]));
    assert.equal(coverage.coverage_hash,fixture.coverage.coverage_hash);
    const narrative=structuredClone(fixture.narrative);narrative.hypotheses[0].contradicting_evidence_ids=['opposing-evidence'];
    const first=reportNarrativeFacts(narrative)!;assert.deepEqual(first.hypotheses.rows[0]?.[4],['opposing-evidence']);
    narrative.hypotheses[0].falsifier+=' Changed saved falsifier.';
    assert.notEqual(first.context_hash,reportNarrativeFacts(narrative)!.context_hash);
    const unknown=reportNarrativeFacts({...narrative,followup:{state:'waiting_for_data',freshness:'fresh',mode:'observational',outcome:'not_run'}})!;
    assert.equal(unknown.followup!.outcome,'not_run');assert.doesNotMatch(JSON.stringify(unknown.followup),/passed|converted|rate/);
 }
});
