import {identitySql} from "../../packages/database/src/identity-schema.js";
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {makeAuth,enrollmentContext} from '../../packages/core/src/identity/auth.js';
import {byteHash,newId} from '../../packages/core/src/canonical.js';
import {demand} from '../../packages/core/src/errors.js';
import {authDatabaseTypes} from '../../packages/database/src/client.js';
const url=process.env.MIGRATION_DATABASE_URL;demand(url,'CONFIGURATION','Operator database configuration required.');
const admin=new pg.Pool({connectionString:url}),identityPool=new pg.Pool({connectionString:url,types:authDatabaseTypes,options:identitySql('-c search_path=auth')});
const file=process.env.BOOTSTRAP_TOKEN_PATH??'.runtime/bootstrap-token';
try{
 const email=process.env.BOOTSTRAP_EMAIL;demand(email,'CONFIGURATION','Provide BOOTSTRAP_EMAIL in the private operator environment.');
 const prepareOnly=process.argv.includes('--prepare'),complete=process.argv.includes('--complete');
 if(prepareOnly||complete){
  const tx=await admin.connect();
  try{await tx.query('BEGIN');const installation=(await tx.query('SELECT bootstrapped_at FROM faultline.installation WHERE singleton FOR UPDATE')).rows[0];demand(installation&&!installation.bootstrapped_at,'ALREADY_CONFIGURED','Bootstrap refuses an already configured installation.',409);
   const token=randomBytes(32).toString('base64url');await tx.query(identitySql("INSERT INTO auth.enrollment_capabilities(token_hash,workspace_id,intended_email,role,mode,expires_at,workspace_name) VALUES($1,$2,$3,'owner','bootstrap',now()+interval '15 minutes',$4)"),[byteHash(token),newId(),email.toLowerCase(),process.env.BOOTSTRAP_WORKSPACE??'First workspace']);
   await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,token,{mode:0o600});await tx.query('COMMIT');console.log('One-use bootstrap capability saved privately; expires in 15 minutes.');
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 }
 if(!prepareOnly){
  const token=(await fs.readFile(file,'utf8')).trim(),password=process.env.BOOTSTRAP_PASSWORD;demand(password&&password.length>=12,'CONFIGURATION','Provide BOOTSTRAP_PASSWORD with at least 12 characters.');
  const identity=makeAuth(identityPool)!;await enrollmentContext.run({hash:byteHash(token),email:email.toLowerCase()},()=>identity.api.signUpEmail({body:{email,password,name:process.env.BOOTSTRAP_NAME??'Installation owner'}}));
  await fs.unlink(file);console.log('Initial owner/workspace created. Sign in using the real application.');
 }
}finally{await admin.end();await identityPool.end();}

