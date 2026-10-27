import {identitySql} from "../../packages/database/src/identity-schema.js";
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from 'better-auth/crypto';
import {demand} from '../../packages/core/src/errors.js';
import {byteHash,newId} from '../../packages/core/src/canonical.js';
const url=process.env.MIGRATION_DATABASE_URL,email=process.env.RECOVERY_EMAIL;
demand(url&&email,'CONFIGURATION','Configure private operator credentials and RECOVERY_EMAIL.');
const admin=new pg.Pool({connectionString:url});const tx=await admin.connect(),file='.runtime/recovery-token';
try{
 await tx.query('BEGIN');const user=(await tx.query(identitySql('SELECT id FROM auth."user" WHERE lower(email)=lower($1) FOR UPDATE'),[email])).rows[0];demand(user,'NOT_FOUND','Account not found.',404);
 if(process.argv.includes('--prepare')){const token=randomBytes(32).toString('base64url');await tx.query(identitySql("INSERT INTO auth.recovery_capabilities(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')"),[byteHash(token),user.id]);await fs.writeFile(file,token,{mode:0o600});}
 else{
  const token=(await fs.readFile(file,'utf8')).trim(),password=process.env.RECOVERY_PASSWORD;demand(password&&password.length>=12&&password.length<=128,'CONFIGURATION','Provide an allowed RECOVERY_PASSWORD.');
  const capability=(await tx.query(identitySql('SELECT * FROM auth.recovery_capabilities WHERE token_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE'),[byteHash(token),user.id])).rows[0];demand(capability,'RECOVERY_UNAVAILABLE','Recovery authorization unavailable.',403);
  const updated=await tx.query(identitySql('UPDATE auth.account SET password=$2 WHERE "userId"=$1 AND "providerId"=$3'),[user.id,await hashPassword(password),'credential']);demand(updated.rowCount===1,'RECOVERY_UNAVAILABLE','Exactly one credential account is required.');await tx.query(identitySql('DELETE FROM auth.session WHERE "userId"=$1'),[user.id]);await tx.query(identitySql('UPDATE auth.recovery_capabilities SET consumed_at=now() WHERE token_hash=$1'),[byteHash(token)]);
  const memberships=(await tx.query('SELECT workspace_id FROM faultline.memberships WHERE user_id=$1',[user.id])).rows;
  for(const row of memberships){await tx.query("SELECT set_config('faultline.workspace_id',$1,true)",[row.workspace_id]);await tx.query('INSERT INTO faultline.audit(id,workspace_id,actor_id,operation,details) VALUES($1,$2,$3,$4,$5)',[newId(),row.workspace_id,'operator','account.recover',{user_id:user.id,session_revocation:true}]);}
 }
 await tx.query('COMMIT');if(!process.argv.includes('--prepare'))await fs.unlink(file);console.log(process.argv.includes('--prepare')?'Private one-use recovery token prepared for 15 minutes.':'Account recovered with actual credential update and all sessions revoked; no message was sent.');
}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();await admin.end();}

