import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {comparisonPromptFacts,coveragePromptFacts,reportNarrativeFacts} from './prompt-facts.js';
import {proposalContext,wireBody,proposalWireSchema} from './gateway.js';
import {modelRequestReadiness,requireModelBudget} from './budget-status.js';
import {hash} from '../canonical.js';

// Captured synthetic acceptance inputs; expectations and spent allowance predate this fix.
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/recorded-report-budget.json',import.meta.url),'utf8'));
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

test('omitted comparison detail still changes freshness; raw records and unsupported fields never enter prose context',()=>{
 const raw={...fixture.comparison,raw_sessions:['private session'],credential:'private credential'},first=comparisonPromptFacts(raw)!;
 const changed=comparisonPromptFacts({...raw,baseline:{...raw.baseline,interval:{...raw.baseline.interval,low:0.01}}})!;
 assert.notEqual(first.value_hash,changed.value_hash);assert.deepEqual(first.counts,changed.counts);assert.deepEqual(first.strata,changed.strata);
 assert.notEqual(first.value_hash,comparisonPromptFacts({...raw,credential:'changed private credential'})!.value_hash);
 assert.doesNotMatch(JSON.stringify(first),/private session|private credential|raw_sessions|credential/);
 const unknown=comparisonPromptFacts({quality:'provisional',baseline:{},comparison:{}})!;
 assert.equal(unknown.quality,'provisional');assert.deepEqual(unknown.counts,[[null,null,null],[null,null,null]]);assert.deepEqual(unknown.unknown_cohort_count,[null,null]);assert.deepEqual(unknown.strata,{});
 assert.equal(comparisonPromptFacts(null),null);
});

test('fixed comparison table saves at least 150 bytes without dropping any selected recorded fact or full-input hash',t=>{
 const previous={value_hash:hash(fixture.comparison),basis:'operator_attestation',quality:'complete_attested',baseline:{eligible:1000,converted:340,rate:0.34,unknown_cohort_count:0,strata:{mobile:{eligible:200,converted:20,rate:0.1},desktop:{eligible:800,converted:320,rate:0.4}}},comparison:{eligible:1000,converted:160,rate:0.16,unknown_cohort_count:0,strata:{mobile:{eligible:800,converted:80,rate:0.1},desktop:{eligible:200,converted:80,rate:0.4}}},delta_pp:-18.000000000000004,relative_change:-0.5294117647058824,intervals:'omitted_descriptive_only',causal_effect:'not_established'};
 const projected=comparisonPromptFacts(fixture.comparison)!;
 assert.deepEqual(projected,expectedComparison);
 const originalBytes=Buffer.byteLength(JSON.stringify(previous)),compactBytes=Buffer.byteLength(JSON.stringify(projected));
 assert.equal(originalBytes,683);assert.ok(originalBytes-compactBytes>=150);
 t.diagnostic(`Recorded comparison: ${originalBytes} -> ${compactBytes} bytes; saved ${originalBytes-compactBytes} bytes; every selected fact and full-input hash retained.`);
});

test('table keeps one-sided cohorts, unknown counts and absent windows distinct from zero or present rows',()=>{
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
});

test('coverage and narrative compacting retains every warning and contrary citation while binding omitted detail',()=>{
 const coverage=coveragePromptFacts(fixture.coverage);
 assert.deepEqual(new Set(coverage.limitations),new Set([...fixture.coverage.limitations,...fixture.coverage.sources.flatMap((s:any)=>s.limitations)]));
 assert.equal(coverage.coverage_hash,fixture.coverage.coverage_hash);
 const narrative=structuredClone(fixture.narrative);narrative.hypotheses[0].contradicting_evidence_ids=['opposing-evidence'];
 const first=reportNarrativeFacts(narrative)!;assert.deepEqual(first.hypotheses.rows[0]?.[4],['opposing-evidence']);
 narrative.hypotheses[0].falsifier+=' Changed saved falsifier.';
 assert.notEqual(first.context_hash,reportNarrativeFacts(narrative)!.context_hash);
 const unknown=reportNarrativeFacts({...narrative,followup:{state:'waiting_for_data',freshness:'fresh',mode:'observational',outcome:'not_run'}})!;
 assert.equal(unknown.followup!.outcome,'not_run');assert.doesNotMatch(JSON.stringify(unknown.followup),/passed|converted|rate/);
});
