import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {HOSTED_OPERATOR_ONLY_INPUTS} from './hosted-private-runtime.mjs';

function requireValue(ok,code){if(!ok)throw Object.assign(new Error(code),{code});}
function decode(value,max){requireValue(typeof value==='string'&&value.length<=max*2&&/^[A-Za-z0-9+/]+={0,2}$/.test(value),'VERCEL_SECRET_REQUIRED');const bytes=Buffer.from(value,'base64');requireValue(bytes.length>0&&bytes.length<=max&&bytes.toString('base64')===value,'VERCEL_SECRET_INVALID');return bytes;}
/** Ephemeral key materialization only. This profile stores durable objects in private remote storage. */
export async function initializeVercelRuntime({env=process.env,parent=os.tmpdir()}={}){
 requireValue(env.OBJECT_STORE==='supabase'&&env.AUTH_DATABASE_SCHEMA==='faultline_identity','VERCEL_HOSTING_PROFILE_REQUIRED');
 requireValue(!HOSTED_OPERATOR_ONLY_INPUTS.some(name=>env[name]),'VERCEL_OPERATOR_SECRET_FORBIDDEN');
 const decoded=[];let root,published=false;
 try{
  const keyring=decode(env.FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64,16384);decoded.push(keyring);
  const privateKey=decode(env.FAULTLINE_SEALED_REPORT_SIGNING_PRIVATE_PEM_B64,8192);decoded.push(privateKey);
  const publicKey=decode(env.FAULTLINE_SEALED_REPORT_SIGNING_PUBLIC_PEM_B64,8192);decoded.push(publicKey);
  let value;try{value=JSON.parse(keyring.toString('utf8'));}catch{throw Object.assign(new Error('VERCEL_KEYRING_INVALID'),{code:'VERCEL_KEYRING_INVALID'});}
  requireValue(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')==='active,keys'&&typeof value.active==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(value.active)&&value.keys&&Object.getPrototypeOf(value.keys)===Object.prototype&&Object.keys(value.keys).length<=32&&Object.hasOwn(value.keys,value.active),'VERCEL_KEYRING_INVALID');
  for(const [version,key] of Object.entries(value.keys)){requireValue(/^[A-Za-z0-9._-]{1,64}$/.test(version)&&typeof key==='string'&&Buffer.from(key,'base64').length===32&&Buffer.from(key,'base64').toString('base64')===key,'VERCEL_KEYRING_INVALID');}
  const signing=createPrivateKey(privateKey),verification=createPublicKey(publicKey);
  requireValue(signing.asymmetricKeyType==='ed25519'&&verification.asymmetricKeyType==='ed25519'&&createPublicKey(signing).export({format:'der',type:'spki'}).equals(verification.export({format:'der',type:'spki'})),'VERCEL_SIGNING_KEY_MISMATCH');
  root=await fs.mkdtemp(path.join(parent,'faultline-keys-'));await fs.chmod(root,0o700);
  const files=[['keyring.json','SECRET_KEYRING_PATH',keyring],['signing.pem','REPORT_SIGNING_KEY_PATH',privateKey],['public.pem','REPORT_SIGNING_PUBLIC_KEY_PATH',publicKey]];
  for(const [name,,bytes] of files)await fs.writeFile(path.join(root,name),bytes,{flag:'wx',mode:0o600});
  for(const [name,setting] of files)env[setting]=path.join(root,name);published=true;
  return {root};
 }catch(error){if(error?.code?.startsWith('VERCEL_'))throw error;throw Object.assign(new Error('VERCEL_RUNTIME_INITIALIZATION_FAILED'),{code:'VERCEL_RUNTIME_INITIALIZATION_FAILED'});}
 finally{for(const bytes of decoded)bytes.fill(0);if(root&&!published){for(const name of ['keyring.json','signing.pem','public.pem'])await fs.unlink(path.join(root,name)).catch(()=>{});await fs.rmdir(root).catch(()=>{});}}
}
