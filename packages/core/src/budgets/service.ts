import defaults from '../../../../config/defaults.json' with {type:'json'};
import type {Tx} from '../../../database/src/client.js';
import {command,access,audit,expected} from '../workspaces/service.js';
import {getCaseTx} from '../cases/service.js';
import {policyTx} from '../controls/service.js';
import {demand} from '../errors.js';
import {newId} from '../canonical.js';
import {callAllowance,extensionInput,requireExtensionCapacity,type ExtensionInput} from './allowance.js';

export async function revisionCallAllowanceTx(tx:Tx,wid:string,cid:string,rid:string,automaticCeiling:number) {
 const row=(await tx.query('SELECT COALESCE(sum(additional_calls),0) AS granted FROM faultline.model_budget_extensions WHERE workspace_id=$1 AND case_id=$2 AND revision_id=$3',[wid,cid,rid])).rows[0];
 return callAllowance(automaticCeiling,Number(row.granted),defaults.ai.maxOwnerGrantedCalls);
}

export async function extendRevisionBudget(wid:string,pid:string,key:string,cid:string,rid:string,input:ExtensionInput,match:string) {
 const accepted=extensionInput(input,defaults.ai.maxOwnerGrantedCalls);
 return command(wid,pid,'revision.budget.extend',key,{cid,rid,input,match},async tx=>{
  // command() serializes the workspace, including concurrent distinct owner keys.
  await access(tx,wid,pid,['owner']);
  const item=await getCaseTx(tx,wid,pid,cid,true);expected(match,item.revision);
  demand((await tx.query('SELECT id FROM faultline.case_revisions WHERE workspace_id=$1 AND case_id=$2 AND id=$3',[wid,cid,rid])).rowCount,'NOT_FOUND','Revision unavailable.',404);
  demand(item.active_revision_id===rid,'STALE_INPUTS','Only the current active revision can receive a call allowance.',409);
  const policy=(await policyTx(tx,wid)).value,automaticCeiling=Math.min(defaults.ai.maxCalls,policy.max_automatic_model_calls);
  const previous=await revisionCallAllowanceTx(tx,wid,cid,rid,automaticCeiling);
  requireExtensionCapacity(previous.owner_granted_calls,accepted.additional_calls,defaults.ai.maxOwnerGrantedCalls);
  const row=(await tx.query('INSERT INTO faultline.model_budget_extensions(id,workspace_id,case_id,revision_id,additional_calls,reason,actor_id,case_resource_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[newId(),wid,cid,rid,accepted.additional_calls,accepted.reason,pid,item.revision])).rows[0];
  await audit(tx,wid,pid,'revision.budget.extend',{case_id:cid,revision_id:rid,extension_id:row.id,additional_calls:accepted.additional_calls,owner_granted_calls:previous.owner_granted_calls+accepted.additional_calls,token_allowance_increased:false});
  return {...row,allowance:callAllowance(automaticCeiling,previous.owner_granted_calls+accepted.additional_calls,defaults.ai.maxOwnerGrantedCalls),token_allowance_increased:false};
 },['owner'],async tx=>{
  await access(tx,wid,pid,['owner']);
  const current=await getCaseTx(tx,wid,pid,cid);
  demand(current.active_revision_id===rid,'STALE_INPUTS','This call allowance belongs to a historical revision.',409);
 });
}
