import {objects} from './objects.js';
import {transaction} from '../../../database/src/client.js';
import {getCaseTx} from '../cases/service.js';
import {demand} from '../errors.js';
import {newId} from '../canonical.js';
// Interrupted publications stay reserved until private files and committed references are reconciled.
export async function storeBounded<T extends {key:string;size_bytes:number}>(wid:string,pid:string,caseId:string,amount:number,write:()=>Promise<T>):Promise<T>{
 demand(Number.isSafeInteger(amount)&&amount>0&&amount<=268435456,'BYTE_LIMIT','Invalid bounded object size.',413);
 const id=newId();await transaction(wid,async tx=>{
  await tx.query('SELECT id FROM faultline.workspaces WHERE id=$1 FOR UPDATE',[wid]);
  await getCaseTx(tx,wid,pid,caseId,true);
  await tx.query('INSERT INTO faultline.case_storage(workspace_id,case_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[wid,caseId]);
  const r=await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes+$3 WHERE workspace_id=$1 AND case_id=$2 AND used_bytes+reserved_bytes+$3<=ceiling RETURNING ceiling',[wid,caseId,amount]);
  demand(r.rowCount,'STORAGE_EXHAUSTED','Case storage limit reached. Review retained objects before another capture.',429);
  await tx.query('INSERT INTO faultline.storage_reservations(id,workspace_id,case_id,amount) VALUES($1,$2,$3,$4)',[id,wid,caseId,amount]);
 });
 let value:T;try{value=await write();}catch(error){await transaction(wid,async tx=>{await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes-$3 WHERE workspace_id=$1 AND case_id=$2',[wid,caseId,amount]);await tx.query('DELETE FROM faultline.storage_reservations WHERE workspace_id=$1 AND id=$2',[wid,id]);}).catch(()=>{});throw error;}
 demand(value.size_bytes<=amount,'BYTE_LIMIT','Stored output exceeded its reservation.',413);
 await transaction(wid,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[wid+':object:'+value.key]);
  await objects.read(wid,value.key);
  await tx.query('SELECT case_id FROM faultline.case_storage WHERE workspace_id=$1 AND case_id=$2 FOR UPDATE',[wid,caseId]);
  const added=await tx.query('INSERT INTO faultline.object_references(workspace_id,case_id,object_key,size_bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING object_key',[wid,caseId,value.key,value.size_bytes]);
  await tx.query('UPDATE faultline.case_storage SET reserved_bytes=reserved_bytes-$3,used_bytes=used_bytes+$4 WHERE workspace_id=$1 AND case_id=$2',[wid,caseId,amount,added.rowCount?value.size_bytes:0]);
  await tx.query('DELETE FROM faultline.storage_reservations WHERE workspace_id=$1 AND id=$2',[wid,id]);
 });return value;
}
