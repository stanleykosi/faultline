type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const states=new Set(['proposed','accepted','rejected','needs_evidence']);

/** Preserve human-reviewed state independently of any successful queue job or
 * analytic check. Missing state stays unknown; a result never promotes it. */
export function explanationStateFacts(values:readonly unknown[]){
 return values.flatMap(value=>{
  if(!record(value)||typeof value.id!=='string')return [];
  return [{id:value.id,state:typeof value.status==='string'&&states.has(value.status)?value.status:'unknown'}];
 });
}

/** Called only after the server's analytic freshness gate; no truth is inferred
 * from a completed job, result presence or an absent outcome. */
export function analyticCheckFacts(row:{id:unknown;plan_id?:unknown;value?:Row}){
 const value=row.value??{};
 return {id:row.id,kind:'analytic',hypothesis_id:value.hypothesis_id??null,plan_id:row.plan_id??null,result_hash:value.result_hash??null,outcome:value.outcome??'unknown',freshness:'fresh',test_type:value.kind??null};
}
