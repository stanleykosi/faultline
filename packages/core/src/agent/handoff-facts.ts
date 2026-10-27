import {hash} from '../canonical.js';

type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const copy=(value:unknown)=>structuredClone(value);
const pick=(value:Row,keys:readonly string[]):Row=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,copy(value[key])]));
const mapPresent=(value:Row,key:string,project:(item:unknown)=>unknown):Row=>Object.hasOwn(value,key)?{[key]:Array.isArray(value[key])?value[key].map(project):copy(value[key])}:{};

// These are saved truth/provenance fields, not a new claim projection. Missing,
// null, failed, unknown and stale values are copied without reinterpretation.
const resultKeys=['id','hypothesis_id','kind','test_type','status','outcome','state','freshness','mode','association','mechanism','correction','production_claim_eligible','causal_effect','aggregate_causal_effect','attribution','quality','basis','result_hash','evidence_ids','evidence_hashes'] as const;
const result=(value:unknown):unknown=>record(value)?pick(value,resultKeys):copy(value);
const hypothesis=(value:unknown):unknown=>record(value)?pick(value,['id','title','status','supporting_evidence_ids','contradicting_evidence_ids']):copy(value);

function narrative(value:unknown):unknown {
 if(!record(value))return copy(value);
 return {...pick(value,['revision_id','source_text_trust','causal_effect','aggregate_causal_effect','status','outcome','freshness','mode','quality','omitted']),...mapPresent(value,'hypotheses',hypothesis),...mapPresent(value,'analytic_results',result),...mapPresent(value,'controlled_verification',result),...(Object.hasOwn(value,'followup')?{followup:result(value.followup)}:{})};
}

/** Fixed planner-only handoff. Report drafting still receives its full narrative.
 * No remaining allowance, result status or array position selects source items;
 * One full source hash binds every omitted execution binding, statistic, prose
 * field and readiness detail. Server freshness/access gates use the originals. */
export function compactHandoffInputs(calculatedFacts:unknown,testResults:unknown[],readiness:unknown):{source_hash:string;calculated_facts:unknown;test_results:unknown[];readiness:unknown} {
 const source_hash=hash({calculated_facts:calculatedFacts,test_results:testResults,readiness});
 let facts:unknown=copy(calculatedFacts);
 if(record(calculatedFacts)){
  facts={...pick(calculatedFacts,['comparison','claim_limits','causal_effect','aggregate_causal_effect','status','outcome','freshness','mode','quality']),...(Object.hasOwn(calculatedFacts,'metric')?{metric:record(calculatedFacts.metric)?pick(calculatedFacts.metric,['kind','template']):copy(calculatedFacts.metric)}:{}),...(Object.hasOwn(calculatedFacts,'investigation_context')?{investigation_context:narrative(calculatedFacts.investigation_context)}:{})};
 }
 return {source_hash,calculated_facts:facts,test_results:testResults.map(result),readiness:Array.isArray(readiness)?readiness.map(item=>record(item)?pick(item,['key','status']):copy(item)):copy(readiness)};
}
