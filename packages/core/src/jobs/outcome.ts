import {demand} from '../errors.js';
type JobBinding={kind:string;input:Record<string,unknown>};
export function deterministicJobOutcome(job:JobBinding,result:unknown):{status:'succeeded'|'waiting_for_input';errorCode:string|null}{
 // Only the deterministic follow-up service can produce this supported checkpoint.
 // Model text and arbitrary result.status fields cannot control queue truth.
 if(job.kind==='followup_due'){
  demand(result!==null&&typeof result==='object'&&!Array.isArray(result),'INVALID_WORKER_OUTCOME','Follow-up handler returned an invalid checkpoint.');
  const value=result as Record<string,unknown>;
  demand(typeof job.input.followup_id==='string'&&value.id===job.input.followup_id,'INVALID_WORKER_OUTCOME','Follow-up outcome changed its frozen resource binding.');
  demand(value.state==='compared'||value.state==='waiting_for_data','INVALID_WORKER_OUTCOME','Follow-up handler returned an unknown outcome.');
  if(value.state==='waiting_for_data')return {status:'waiting_for_input',errorCode:'FOLLOWUP_DATA_REQUIRED'};
 }
 return {status:'succeeded',errorCode:null};
}
