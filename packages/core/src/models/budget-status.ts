import type {Tx} from '../../../database/src/client.js';
import {policyTx} from '../controls/service.js';
import {revisionCallAllowanceTx} from '../budgets/service.js';
import {demand} from '../errors.js';
import {modelRevisionLimits,type ModelPolicyLimits} from './limits.js';

export const MINIMUM_STRUCTURED_OUTPUT=1024;
export function modelBudgetStatus(policy:ModelPolicyLimits,usage:Record<string,unknown>,totalCalls:number){
 const amount=(key:string)=>{if(!usage||typeof usage!=='object'||Array.isArray(usage))return Number.MAX_SAFE_INTEGER;if(!Object.hasOwn(usage,key))return 0;const raw=usage[key],value=typeof raw==='number'?raw:typeof raw==='string'&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):NaN;return Number.isSafeInteger(value)&&value>=0?value:Number.MAX_SAFE_INTEGER;};
 const limits=modelRevisionLimits(policy),calls=Number.isSafeInteger(totalCalls)&&totalCalls>=0&&totalCalls<=limits.automatic_calls+limits.owner_calls?totalCalls:0;
 const remaining_calls=Math.max(0,calls-amount('calls_spent')-amount('calls_reserved'));
 const remaining_input=Math.max(0,limits.input-amount('input_spent')-amount('input_reserved'));
 const remaining_output=Math.max(0,limits.output-amount('output_spent')-amount('output_reserved'));
 const can_request=limits.automatic_calls>0&&remaining_calls>0&&remaining_input>0&&remaining_output>=MINIMUM_STRUCTURED_OUTPUT;
 return {remaining_calls,remaining_input,remaining_output,can_request,reason_code:can_request?null:'MODEL_BUDGET_EXHAUSTED'};
}
export async function modelBudgetStatusTx(tx:Tx,wid:string,cid:string,revision:string){
 const policy=(await policyTx(tx,wid)).value,allowance=await revisionCallAllowanceTx(tx,wid,cid,revision,modelRevisionLimits(policy).automatic_calls);
 const usage=(await tx.query('SELECT calls_spent,calls_reserved,input_spent,input_reserved,output_spent,output_reserved FROM faultline.model_budgets WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[wid,cid,revision])).rows[0]??{};
 return modelBudgetStatus(policy,usage,allowance.total_calls);
}
export function requireModelBudget(status:ReturnType<typeof modelBudgetStatus>,inputBytes:number){
 demand(modelRequestReadiness(status,inputBytes).can_request,'MODEL_BUDGET_EXHAUSTED','This agent request exceeds the remaining allowance. Your saved work remains available.',429);
}
/** The same serialized wire bytes and margin used by reservation, never a token estimate. */
export function modelRequestReadiness(status:ReturnType<typeof modelBudgetStatus>,inputBytes:number){
 const can_request=status.can_request&&Number.isSafeInteger(inputBytes)&&inputBytes>0&&inputBytes<=status.remaining_input;
 return {...status,input_required:inputBytes,can_request,reason_code:can_request?null:'MODEL_BUDGET_EXHAUSTED'};
}
