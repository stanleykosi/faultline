import {demand} from '../errors.js';

/** Product-owned instructions. Case text and optional user context never replace them. */
export const AGENT_PROMPT_VERSION='faultline-case-agent-v21';
export const CONTINUE_INVESTIGATION='Continue the investigation from the current saved evidence, results and outstanding decisions.';

export function optionalAgentContext(value:unknown,max:number,code:string):string|undefined {
 if(value===undefined)return undefined;
 demand(typeof value==='string'&&value.length<=max,code,'Enter bounded text.',400);
 return value.trim()||undefined;
}

export function investigationObjective(value:{title?:unknown;question?:unknown;affected_flow?:unknown},focus?:string){
 if(focus)return focus;
 const context=[['Investigation',value.title],['Business question',value.question],['Affected flow',value.affected_flow]]
  .filter(([,text])=>typeof text==='string'&&text.trim()).map(([label,text])=>`${label}: ${String(text).trim()}`);
 return ['Investigate the saved case, compare supported explanations, and identify the next evidence-backed step.',...context].join('\n').slice(0,2000);
}

/** Use immutable completed-turn records so reflection hashing does not depend
 * on the action status which is committed after its reflection is queued. */
export function investigationHistory(rows:{message_kind?:string;user_message?:string;response?:{actions?:{kind:string}[]}|null}[]){
 const history:{kind:string;status:string}[]=[];
 for(const row of rows){
  for(const action of row.response?.actions??[])history.push({kind:action.kind,status:'previously_proposed'});
  if(row.message_kind==='tool'&&row.user_message?.startsWith('Approved tool result: ')){
   try{const result=JSON.parse(row.user_message.slice('Approved tool result: '.length));if(typeof result.kind==='string'&&typeof result.status==='string')history.push({kind:result.kind,status:result.status});}catch{/* A truncated quoted result is not a known tool outcome. */}
  }
 }
 return history.slice(-20);
}

const missions={
 setup:'Inspect what data is missing. Request an import or an approved configured source through open_data or gather_related_evidence. Ask only for missing business facts or permissions. With no accepted data, do not invent findings, hypotheses, evidence or a completed measurement.',
 measure:'Inspect the saved snapshot and metric. Use review_metric to collect or review missing event definitions, cohorts, time windows and completeness, then freeze reviewed inputs and run the deterministic comparison in the measurement task. Do not infer business definitions or claim a comparison ran before its saved result exists.',
 explain:'Inspect cohort composition and within-cohort rates. analysis.hypotheses=[]. Use generate_hypotheses, or gather_related_evidence for missing approved context. Draft success awaits human review; never repeat it or claim acceptance.',
 test:'Review the current hypotheses, contrary evidence and fresh independent test results. Propose an appropriate bounded data check or browser plan through draft_test_plan or the corresponding review task. Missing test inputs and exact browser scope require human input. Inspect failed, cancelled and stale outcomes as such; do not repeat completed work without a stated unresolved reason.',
 report:'Set analysis.hypotheses to an empty array. Use draft_report; the tool owns prose, including failed, blocked, cancelled and inconclusive checks. Success awaits human sentence review, with no repeat drafting action. Never publish or assert causation.',
 follow_up:'Inspect saved report/follow-up freshness and outcome. Set analysis.hypotheses to an empty array. Use open_follow_up or schedule_follow_up for reviewed measurement. Stop with an honest summary when no supported step remains.'
} as const;

export function investigationMission(stage:keyof typeof missions){
 return 'User conversation is optional; never request an analysis prompt. Saved artifacts establish completion; readiness is availability. '+missions[stage]+' Checks never change saved explanation states. Passed supports its prediction only; failed means prediction unsupported. Blocked/cancelled/inconclusive/unknown/not-run never pass. After an approved tool result, inspect actual status/history. Every action needs explicit review. Stop for missing data, permission or budget.';
}

