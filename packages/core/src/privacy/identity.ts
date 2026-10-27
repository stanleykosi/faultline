import {createHmac} from 'node:crypto';
import {loadKeyring} from '../secrets/keyring.js';
import {demand} from '../errors.js';
import type {Tx} from '../../../database/src/client.js';
export function sessionPseudonym(key:Buffer,wid:string,sourceId:string,version:string,sessionId:string){
 demand(key.length===32&&sessionId.length>0,'IDENTITY_POLICY','A bounded source session and retained identity key are required.');
 return 's_'+createHmac('sha256',key).update(JSON.stringify([version,wid,sourceId,sessionId])).digest('hex');
}
export function pseudonymizeRecords(key:Buffer,wid:string,sourceId:string,version:string,records:any[],consume=false){
 const output=consume?records:[];
 const sessions=new Map<string,string>();
 for(let i=0;i<records.length;i++){
  const event=records[i];let value=sessions.get(event.session_id);
  if(value===undefined){value=sessionPseudonym(key,wid,sourceId,version,event.session_id);sessions.set(event.session_id,value);}
  output[i]={...event,session_id:value};
 }
 return output;
}
export async function pseudonymizeTx(tx:Tx,wid:string,sourceId:string,records:any[],consume=false){
 const ring=await loadKeyring();await tx.query('INSERT INTO faultline.source_identity_policies(workspace_id,source_id,version,key_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[wid,sourceId,'workspace-source-hmac-sha256-v1',ring.active]);
 const policy=(await tx.query('SELECT version,key_version FROM faultline.source_identity_policies WHERE workspace_id=$1 AND source_id=$2',[wid,sourceId])).rows[0];
 const key=Buffer.from(ring.keys[policy.key_version]??'','base64');demand(key.length===32,'IDENTITY_KEY_UNAVAILABLE','The pinned identity policy key must be retained.',503);
 return {records:pseudonymizeRecords(key,wid,sourceId,policy.version,records,consume),policy:{version:policy.version,key_version:policy.key_version,source_id:sourceId}};
}
