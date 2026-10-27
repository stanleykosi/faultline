import {loadKeyring,seal,open} from '../secrets/keyring.js';
import {randomBytes} from 'node:crypto';
import {requireDatabase,transaction,type Tx} from '../../../database/src/client.js';
import {hash,byteHash,newId} from '../canonical.js';
import {demand,DomainError} from '../errors.js';
export type Role='owner'|'analyst'|'viewer';
export type Principal={id:string;email:string;name:string};
export async function access(tx:Tx,wid:string,pid:string,roles:Role[]=['owner','analyst','viewer']){
 const r=await tx.query('SELECT m.role FROM faultline.memberships m JOIN faultline.workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND w.deletion_requested_at IS NULL FOR SHARE OF m',[wid,pid]);
 demand(r.rows[0],'NOT_FOUND','Resource unavailable.',404);
 demand(roles.includes(r.rows[0].role),'FORBIDDEN','This role cannot perform the requested action.',403);return r.rows[0].role as Role;
}
function roleFor(operation:string,replay=false):Role[]{if(operation==='notification.read'||operation==='invitation.claim')return ['owner','analyst','viewer'];if((!replay&&operation==='owner.transfer')||['invite','renameWorkspace','invitation.revoke','member.change','secret.rotate','secret.revoke','policy.update','privacy.update','evidence.redact','source.create','source.probe','source.disconnect','source.declare','model.profile.create','model.probe','model.delete','case.delete','workspace.delete'].includes(operation))return ['owner'];return ['owner','analyst'];}
export function expected(value:unknown,revision:number){demand(String(value)===String(revision),'STALE_INPUTS','The resource revision changed.',409);}
export async function audit(tx:Tx,wid:string,pid:string,operation:string,details:object){const id=newId();await tx.query('INSERT INTO faultline.audit(id,workspace_id,actor_id,operation,details) VALUES($1,$2,$3,$4,$5)',[id,wid,pid,operation,details]);
 const caseId=(details as {case_id?:string}).case_id??null;await tx.query('INSERT INTO faultline.notifications(id,workspace_id,user_id,case_id,type,details,dedupe_key) SELECT gen_random_uuid(),workspace_id,user_id,$2,$3,$4,$5 FROM faultline.memberships WHERE workspace_id=$1 ON CONFLICT DO NOTHING',[wid,caseId,operation,{case_id:caseId},id]);}
export async function command<T>(wid:string,pid:string,operation:string,key:string,body:unknown,fn:(tx:Tx)=>Promise<T>,requiredRoles?:Role[],afterResult?:(tx:Tx,result:T,replayed:boolean)=>Promise<void>):Promise<T>{
 demand(typeof key==='string'&&key.length>=8&&key.length<=160,'IDEMPOTENCY_REQUIRED','Provide an Idempotency-Key.',400);
 return transaction(wid,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[wid+':'+pid+':'+operation+':'+key]);
  if(!['createWorkspace','invitation.claim'].includes(operation))await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);
  const inputHash=hash(body),old=await tx.query('SELECT input_hash,result,case_id FROM faultline.idempotency WHERE workspace_id=$1 AND principal_id=$2 AND operation=$3 AND key=$4',[wid,pid,operation,key]);
  if(old.rows[0]){
   demand(old.rows[0].input_hash===inputHash,'IDEMPOTENCY_CONFLICT','This key was used for different input.',409);
   let replay=old.rows[0].result;
   if(replay?.encrypted)replay=JSON.parse(open(replay.encrypted,wid+':'+pid+':'+operation,await loadKeyring()));
   if(operation==='createWorkspace'){await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[replay.id]);await access(tx,replay.id,pid);}
   else if(['workspace.delete','case.delete'].includes(operation)){const current=(await tx.query('SELECT role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[wid,pid])).rows[0];demand(current?.role==='owner','FORBIDDEN','Current ownership is required to recover a deletion receipt.',403);}
   else await access(tx,wid,pid,requiredRoles??roleFor(operation,true));
   // Historical command receipts carry private case data. Deletion receipts are
   // the explicit exception; every other case-scoped replay needs current access.
   const fields=body as any,record=replay as any;
   const replayCase=old.rows[0].case_id??fields?.caseId??fields?.cid??record?.case_id??record?.value?.case_id??(operation.startsWith('case.')?(fields?.id??record?.id):null);
   if(!['case.delete','workspace.delete'].includes(operation)&&typeof replayCase==='string'&&/^[a-f0-9-]{36}$/i.test(replayCase)){
    demand((await tx.query('SELECT id FROM faultline.cases WHERE workspace_id=$1 AND id=$2 AND deletion_requested_at IS NULL',[wid,replayCase])).rowCount,'NOT_FOUND','Investigation unavailable.',404);
   }
   if(afterResult)await afterResult(tx,replay as T,true);
   return replay as T;
  }
  if(!['createWorkspace','invitation.claim'].includes(operation))await access(tx,wid,pid,requiredRoles??roleFor(operation));
  const result=await fn(tx);
  if(afterResult)await afterResult(tx,result,false);
  const stored=result&&typeof result==='object'&&'token' in result?{encrypted:seal(JSON.stringify(result),wid+':'+pid+':'+operation,await loadKeyring())}:result;
  const fields=body as any,out=result as any,caseScope=fields?.caseId??fields?.cid??out?.case_id??out?.value?.case_id??(operation.startsWith('case.')?(fields?.id??out?.id):null);
  await tx.query('INSERT INTO faultline.idempotency(workspace_id,principal_id,operation,key,input_hash,result,case_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[wid,pid,operation,key,inputHash,JSON.stringify(stored??null),typeof caseScope==='string'&&/^[a-f0-9-]{36}$/i.test(caseScope)?caseScope:null]);return result;
 });
}
export async function listWorkspaces(pid:string){return (await requireDatabase().query('SELECT * FROM faultline.principal_workspaces($1)',[pid])).rows;}
export async function createWorkspace(principal:Principal,name:string,key:string){
 // Principal-scoped stable scope allows identical creates to replay without minting new tenant IDs.
 const scope='00000000-0000-0000-0000-000000000000';
 return command(scope,principal.id,'createWorkspace',key,{name},async tx=>{
  const wid=newId();await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[wid]);
  const row=(await tx.query('INSERT INTO faultline.workspaces(id,name) VALUES($1,$2) RETURNING *',[wid,name])).rows[0];
  await tx.query('INSERT INTO faultline.memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',[wid,principal.id,'owner']);
  await audit(tx,wid,principal.id,'workspace.create',{name});
  await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[scope]);
  return {...row,role:'owner'};
 });
}
export async function getWorkspace(wid:string,pid:string){return transaction(wid,async tx=>{const role=await access(tx,wid,pid);return {...(await tx.query('SELECT * FROM faultline.workspaces WHERE id=$1',[wid])).rows[0],role};});}
export async function renameWorkspace(wid:string,pid:string,key:string,name:string,match:string){return command(wid,pid,'renameWorkspace',key,{name,match},async tx=>{await access(tx,wid,pid,['owner']);const old=(await tx.query('SELECT * FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid])).rows[0];expected(match,old.revision);const row=(await tx.query('UPDATE faultline.workspaces SET name=$2,revision=revision+1 WHERE id=$1 RETURNING *',[wid,name])).rows[0];await audit(tx,wid,pid,'workspace.rename',{name});return {...row,role:'owner'};});}
export async function invite(wid:string,pid:string,key:string,input:{intended_email:string;role:'analyst'|'viewer';expires_at:string}){
 return command(wid,pid,'invite',key,input,async tx=>{
  await access(tx,wid,pid,['owner']);const expires=Date.parse(input.expires_at);demand(expires>Date.now()&&expires<=Date.now()+30*86400000,'INVALID_EXPIRY','Invitation expires within 30 days.');
  const token=randomBytes(32).toString('base64url'),id=newId();
  const row=(await tx.query('INSERT INTO faultline.invitations(id,workspace_id,intended_email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,workspace_id,intended_email,role,expires_at,revision',[id,wid,input.intended_email.toLowerCase(),input.role,byteHash(token),input.expires_at])).rows[0];
  await audit(tx,wid,pid,'invitation.create',{id,role:input.role});
  // Token is returned once; idempotency storage must also protect this capability.
  return {...row,token};
 });
}
export async function claimInvitation(token:string,principal:Principal|null,key:string){
 const tokenHash=byteHash(token);
 const inv=(await requireDatabase().query('SELECT * FROM faultline.invitation_lookup($1)',[tokenHash])).rows[0];
 demand(inv,'INVITATION_UNAVAILABLE','Invitation is expired, revoked, claimed, or invalid.',409);
 if(inv.claimed_by){demand(principal&&inv.claimed_by===principal.id,'INVITATION_UNAVAILABLE','Invitation has been claimed.',409);}
 if(!principal){
  demand(!inv.revoked&&!inv.claimed_by&&Date.parse(inv.expires_at)>Date.now(),'INVITATION_UNAVAILABLE','Invitation is unavailable.',409);
  const capability=randomBytes(32).toString('base64url');
  const keyring=await loadKeyring(),aad='pending:'+tokenHash+':'+key,encrypted=seal(capability,aad,keyring);
  const row=(await requireDatabase().query('SELECT * FROM faultline.prepare_enrollment($1,$2,$3,$4,$5)',[tokenHash,byteHash(capability),key,hash({token_hash:tokenHash}),encrypted])).rows[0];
  return {status:'enrollment_required',workspace_id:row.workspace_id,intended_email:row.intended_email,capability:open(row.result_ciphertext,aad,keyring)};
 }
 demand(!inv.revoked,'INVITATION_UNAVAILABLE','Invitation revoked.',409);
 demand(principal.email.toLowerCase()===inv.intended_email.toLowerCase(),'ACCOUNT_SWITCH_REQUIRED','Sign in with the invited identity.',403);
 return command(inv.workspace_id,principal.id,'invitation.claim',key,{token_hash:tokenHash},async tx=>{
  await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[inv.workspace_id]);
  const current=(await tx.query('SELECT * FROM faultline.invitations WHERE id=$1 FOR UPDATE',[inv.id])).rows[0];
  demand(current&&!current.revoked&&!current.claimed_by&&Date.parse(current.expires_at)>Date.now(),'INVITATION_UNAVAILABLE','Invitation is no longer available.',409);
  const existing=(await tx.query('SELECT role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[inv.workspace_id,principal.id])).rows[0];
  demand(!existing,'ALREADY_MEMBER','An invitation cannot change an existing membership.',409);
  await tx.query('INSERT INTO faultline.memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',[inv.workspace_id,principal.id,inv.role]);
  await tx.query('UPDATE faultline.invitations SET claimed_by=$2,revision=revision+1 WHERE id=$1',[inv.id,principal.id]);
  await audit(tx,inv.workspace_id,principal.id,'invitation.claim',{invitation_id:inv.id,role:inv.role});
  return {status:'claimed',workspace_id:inv.workspace_id};
 });
}
export async function changeMember(wid:string,pid:string,key:string,memberId:string,role:Role|null,match:string,transfer=false){
 return command(wid,pid,transfer?'owner.transfer':'member.change',key,{memberId,role,match,transfer},async tx=>{
  const workspace=(await tx.query('SELECT * FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid])).rows[0];
  await access(tx,wid,pid,['owner']);
  const member=(await tx.query('SELECT * FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[wid,memberId])).rows[0];
  demand(member,'NOT_FOUND','Member unavailable.',404);expected(match,transfer?workspace.revision:member.revision);if(transfer)demand(memberId!==pid,'INVALID_TRANSFER','Choose another member for ownership transfer.',400);
  if(member.role==='owner'&&role!=='owner'){
   const owners=await tx.query("SELECT count(*)::integer n FROM faultline.memberships WHERE workspace_id=$1 AND role='owner'",[wid]);
   demand(owners.rows[0].n>1,'LAST_OWNER','The final owner cannot be removed or demoted.',409);
  }
  if(role)await tx.query('UPDATE faultline.memberships SET role=$3,revision=revision+1 WHERE workspace_id=$1 AND user_id=$2',[wid,memberId,role]);
  else await tx.query('DELETE FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[wid,memberId]);
  if(transfer)await tx.query('UPDATE faultline.workspaces SET revision=revision+1 WHERE id=$1',[wid]);
  if(transfer&&memberId!==pid)await tx.query("UPDATE faultline.memberships SET role='analyst',revision=revision+1 WHERE workspace_id=$1 AND user_id=$2",[wid,pid]);
  await audit(tx,wid,pid,transfer?'owner.transfer':'member.change',{member_id:memberId,from:member.role,to:role,...(transfer?{previous_owner:pid,previous_owner_new_role:'analyst'}:{})});
  return role?{...member,role,revision:member.revision+1}:null;
 });
}
export async function revokeInvite(wid:string,pid:string,key:string,id:string,match:string){
 return command(wid,pid,'invitation.revoke',key,{id,match},async tx=>{await access(tx,wid,pid,['owner']);const inv=(await tx.query('SELECT revision FROM faultline.invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[wid,id])).rows[0];demand(inv,'NOT_FOUND','Invitation unavailable.',404);expected(match,inv.revision);await tx.query('UPDATE faultline.invitations SET revoked=true,revision=revision+1 WHERE id=$1',[id]);await audit(tx,wid,pid,'invitation.revoke',{id});return null;});
}

