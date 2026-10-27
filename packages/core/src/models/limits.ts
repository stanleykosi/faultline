import defaults from '../../../../config/defaults.json' with {type:'json'};
import {demand} from '../errors.js';

export interface ModelPolicyLimits {max_automatic_model_calls:number;max_input_tokens:number;max_output_tokens:number;}
const limit=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0;

/** Workspace policy may tighten the configured revision ceiling, never raise it. */
export function modelRevisionLimits(policy:ModelPolicyLimits){
 return {automatic_calls:Math.min(limit(policy?.max_automatic_model_calls),limit(defaults.ai.maxCalls)),input:Math.min(limit(policy?.max_input_tokens),limit(defaults.ai.maxInputTokens)),output:Math.min(limit(policy?.max_output_tokens),limit(defaults.ai.maxOutputTokens)),owner_calls:limit(defaults.ai.maxOwnerGrantedCalls)};
}

/** Shared by planner and proposal reservations. The larger revision allowance
 * never expands a single model response or refunds spent/reserved output. */
export function modelOutputAllowance(policyLimit:number,reserved:number,spent:number):number {
 demand([policyLimit,reserved,spent].every(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0),'MODEL_BUDGET_EXHAUSTED','Model token allowance is unavailable.',429);
 return Math.max(0,Math.min(4000,Math.min(limit(defaults.ai.maxOutputTokens),policyLimit)-reserved-spent));
}
