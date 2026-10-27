import {demand} from '../errors.js';

export type PolicyObjectState = 'pending' | 'removed' | 'retained_shared' | 'failed';
export interface PolicyObjectReceipt {object_key:string;status:PolicyObjectState;error_code?:string|null;}

/**
 * Apply the filesystem half of a policy-expiry cleanup. The caller persists each
 * state change in the same database transaction that holds the exact expiry
 * fence. `remove` must be idempotent: a process can stop after unlink and before
 * the transaction commits, so a retry may observe an already absent file.
 */
export async function cleanPolicyObjects(input:{keys:readonly string[];existing:readonly PolicyObjectReceipt[];sharedKeys:ReadonlySet<string>;remove:(key:string)=>Promise<unknown>;record:(key:string,status:PolicyObjectState,errorCode:string|null)=>Promise<void>}):Promise<{status:'complete'|'pending';removed:number;retained_shared:number;failed:number}> {
  demand(Array.isArray(input.keys)&&input.keys.length<=20&&input.keys.every(key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key))&&new Set(input.keys).size===input.keys.length,'RETENTION_OBJECT_SCOPE_INVALID','Policy cleanup requires at most20 exact unique object hashes.',409);
  const expected=new Set(input.keys),existing=new Map<string,PolicyObjectReceipt>();
  for(const row of input.existing){demand(expected.has(row.object_key)&&!existing.has(row.object_key)&&['pending','removed','retained_shared','failed'].includes(row.status),'RETENTION_OBJECT_JOURNAL_INVALID','Policy cleanup journal differs from the exact reviewed object set.',409);existing.set(row.object_key,row);}
  let removed=0,retained_shared=0,failed=0;
  for(const key of input.keys){
    const prior=existing.get(key);
    if(prior?.status==='removed'){removed++;continue;}
    if(prior?.status==='retained_shared'){retained_shared++;continue;}
    if(input.sharedKeys.has(key)){
      await input.record(key,'retained_shared',null);retained_shared++;continue;
    }
    await input.record(key,'pending',null);
    try{await input.remove(key);await input.record(key,'removed',null);removed++;}
    catch{await input.record(key,'failed','PRIVATE_OBJECT_PURGE_FAILED');failed++;}
  }
  return {status:failed===0?'complete':'pending',removed,retained_shared,failed};
}
