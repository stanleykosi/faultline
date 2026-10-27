import {demand} from '../errors.js';
import defaults from '../../../../config/defaults.json' with {type:'json'};

export type ExtensionInput={additional_calls:number;reason:string};
export function extensionInput(value:ExtensionInput,cap:number):ExtensionInput {
 demand(Number.isSafeInteger(cap)&&cap>=0&&cap<=4,'INVALID_BUDGET_CONFIGURATION','Manual call grant ceiling must be 0..4.',503);
 demand(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['additional_calls','reason'].includes(key)),'INVALID_INPUT','Supply additional_calls and reason only.',400);
 demand(Number.isSafeInteger(value.additional_calls)&&value.additional_calls>=1&&value.additional_calls<=cap,'INVALID_ALLOWANCE','Choose 1..4 additional model calls within the installation ceiling.',400);
 demand(typeof value.reason==='string'&&value.reason.trim().length>=1&&value.reason.length<=2000,'INVALID_REASON','Record a reason of 1..2000 characters.',400);
 return {additional_calls:value.additional_calls,reason:value.reason.trim()};
}

/** This increases only the call ceiling; token, repair, time and work gates remain separate. */
export function callAllowance(automaticCeiling:number,ownerGrantedCalls:number,cap:number) {
 demand(Number.isSafeInteger(automaticCeiling)&&automaticCeiling>=0&&automaticCeiling<=defaults.ai.maxCalls,'INVALID_BUDGET_CONFIGURATION',`Automatic call ceiling must be 0..${defaults.ai.maxCalls}.`,503);
 demand(Number.isSafeInteger(cap)&&cap>=0&&cap<=4,'INVALID_BUDGET_CONFIGURATION','Manual call grant ceiling must be 0..4.',503);
 demand(Number.isSafeInteger(ownerGrantedCalls)&&ownerGrantedCalls>=0&&ownerGrantedCalls<=cap,'INVALID_BUDGET_METADATA','Recorded manual call allowance exceeds its installation ceiling.',503);
 return {automatic_calls:automaticCeiling,owner_granted_calls:ownerGrantedCalls,total_calls:automaticCeiling+ownerGrantedCalls};
}
export function requireExtensionCapacity(existing:number,additional:number,cap:number) {
 callAllowance(0,existing,cap);
 demand(Number.isSafeInteger(additional)&&additional>=1&&additional<=cap,'INVALID_ALLOWANCE','Choose a finite additional call allowance.',400);
 demand(existing+additional<=cap,'OWNER_CALL_GRANT_LIMIT','The revision already reaches the installation manual call grant ceiling.',409);
}
