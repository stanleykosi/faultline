import {hash} from '../canonical.js';
import type {TimelineProjection} from '../metrics/timeline.js';

type Row=Record<string,any>;
const count=(v:Row|null|undefined)=>v?[v.eligible??null,v.converted??null,v.rate??null]:null;
/** Fixed, task-independent selection. Never select facts based on remaining budget:
 * reservations change that budget while a frozen request is executing. */
export function comparisonPromptFacts(input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const value=input as Row;
 const windows:(Row|null|undefined)[]=[value.baseline,value.comparison];
 const cohorts=[...new Set(windows.flatMap(v=>Object.keys(v?.strata??{})))].sort();
 // Each counts/unknown-cohort/stratum array follows window_rows. Null rows
 // distinguish absent windows/cohorts from present rows with unknown counts.
 return {value_hash:hash(value),basis:value.basis??'unknown',quality:value.quality??'unknown',window_rows:['baseline','comparison'],count_columns:['eligible','converted','rate'],counts:windows.map(count),unknown_cohort_count:windows.map(v=>v?.unknown_cohort_count??null),strata:Object.fromEntries(cohorts.map(cohort=>[cohort,windows.map(v=>Object.hasOwn(v?.strata??{},cohort)?count(v!.strata[cohort]):null)])),delta_pp:value.delta_pp??null,relative_change:value.relative_change??null,intervals:'omitted_descriptive_only',causal_effect:'not_established'};
}
/** Report prose needs explanations, opposing citations and actual outcomes.
 * Execution bindings and falsifiers remain in saved records and the full hash. */
export function reportNarrativeFacts(input:Row|null){
 if(!input)return null;
 const result=(r:Row)=>Object.fromEntries(['kind','outcome','freshness','mechanism','correction','mode','production_claim_eligible','evidence_ids'].filter(key=>r[key]!==undefined).map(key=>[key,r[key]]));
 return {context_hash:hash(input),causal_effect:'not_established',omitted:input.omitted,hypothesis_falsifiers:'see_saved_hypotheses',hypotheses:{columns:['title','statement','status','supporting_evidence_ids','contradicting_evidence_ids'],rows:input.hypotheses.map((h:Row)=>[h.title,h.statement,h.status,h.supporting_evidence_ids,h.contradicting_evidence_ids])},analytic_results:input.analytic_results.map(result),controlled_verification:input.controlled_verification.map(result),followup:input.followup?{state:input.followup.state,freshness:input.followup.freshness,mode:input.followup.mode,...(input.followup.outcome!==undefined?{outcome:input.followup.outcome}:{}),evidence_ids:input.followup.evidence_ids??[]}:null};
}
export function coveragePromptFacts(value:TimelineProjection){
 return {window:value.window,coverage_hash:value.coverage_hash,sources:{columns:['source_kind','status','basis','covered_interval_count','gap_count'],rows:value.sources.map(s=>[s.source_kind,s.status,s.basis,s.covered_interval_count,s.gap_count])},limitations:[...new Set([...value.limitations,...value.sources.flatMap(s=>s.limitations)])]};
}
