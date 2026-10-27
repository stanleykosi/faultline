import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const HOSTED_VOLUME_ROOT='/data';
export const HOSTED_SECRET_INPUTS=Object.freeze([
 'FAULTLINE_SEALED_SECRET_KEYRING_JSON_B64',
 'FAULTLINE_SEALED_REPORT_SIGNING_PRIVATE_PEM_B64',
 'FAULTLINE_SEALED_REPORT_SIGNING_PUBLIC_PEM_B64',
]);
export const HOSTED_OPERATOR_ONLY_INPUTS=Object.freeze([
 'MIGRATION_DATABASE_URL','BACKUP_WRAP_KEY_PATH','BACKUP_WRAP_KEY_BASE64','BACKUP_WRAP_KEY',
 'BACKUP_WRAPPING_KEY','API_DATABASE_PASSWORD','AUTH_DATABASE_PASSWORD','QUEUE_DATABASE_PASSWORD',
 'DISPATCHER_DATABASE_PASSWORD','BOOTSTRAP_EMAIL','BOOTSTRAP_PASSWORD','BOOTSTRAP_NAME',
 'BOOTSTRAP_WORKSPACE','BOOTSTRAP_TOKEN_PATH','RECOVERY_EMAIL','REHEARSAL_CREDENTIALS_PATH',
 'RECOVERED_RESTORE_RECEIPT',
]);

const secretFiles=Object.freeze([
 {name:'keyring.json',envName:'SECRET_KEYRING_PATH',inputName:HOSTED_SECRET_INPUTS[0],maxBytes:16_384,kind:'keyring'},
 {name:'report-private.pem',envName:'REPORT_SIGNING_KEY_PATH',inputName:HOSTED_SECRET_INPUTS[1],maxBytes:8_192,kind:'private'},
 {name:'report-public.pem',envName:'REPORT_SIGNING_PUBLIC_KEY_PATH',inputName:HOSTED_SECRET_INPUTS[2],maxBytes:8_192,kind:'public'},
]);
const secretFileNames=new Set(secretFiles.map(file=>file.name));
const secretTemporaryNames=new Set(secretFiles.map(file=>`.faultline-secret-${file.name}.tmp`));
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});

function fail(code){const error=new Error(code);error.code=code;return error;}
function isMissing(error){return error?.code==='ENOENT';}
function samePath(left,right){return path.resolve(left)===path.resolve(right);}
function defaultPermissionInfo(_target,stat){return {uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777,nlink:stat.nlink};}

export function mountInfoHasExactPath(mountInfo,target){
 if(typeof mountInfo!=='string'||typeof target!=='string'||!path.posix.isAbsolute(target))return false;
 const decode=value=>value.replace(/\\([0-7]{3})/g,(_match,octal)=>String.fromCharCode(Number.parseInt(octal,8)));
 for(const line of mountInfo.split(/\r?\n/)){
  const separator=line.indexOf(' - ');if(separator<0)continue;
  const fields=line.slice(0,separator).split(' ');
  if(fields.length>=5&&decode(fields[4])===target)return true;
 }
 return false;
}

async function verifyMountedRoot(root,fsApi){
 if(process.platform!=='linux'||root!==HOSTED_VOLUME_ROOT)throw fail('HOSTED_VOLUME_MOUNT_REQUIRED');
 let mountInfo;try{mountInfo=await fsApi.readFile('/proc/self/mountinfo','utf8');}catch{throw fail('HOSTED_VOLUME_MOUNT_UNVERIFIABLE');}
 if(!mountInfoHasExactPath(mountInfo,root))throw fail('HOSTED_VOLUME_MOUNT_REQUIRED');
}

async function lstatRequired(target,fsApi,permissionApi){
 let stat;try{stat=await fsApi.lstat(target);}catch(error){if(isMissing(error))throw fail('HOSTED_PRIVATE_PATH_MISSING');throw fail('HOSTED_PRIVATE_PATH_UNAVAILABLE');}
 if(stat.isSymbolicLink())throw fail('HOSTED_PRIVATE_SYMLINK_REFUSED');
 let real;try{real=await fsApi.realpath(target);}catch{throw fail('HOSTED_PRIVATE_PATH_UNAVAILABLE');}
 if(!samePath(real,target))throw fail('HOSTED_PRIVATE_PATH_ESCAPE');
 let permissions;try{permissions=permissionApi.inspect(target,stat);}catch{throw fail('HOSTED_PRIVATE_METADATA_UNAVAILABLE');}
 return {stat,permissions};
}

async function assertRootDirectory(root,fsApi,permissionApi){
 const {stat,permissions}=await lstatRequired(root,fsApi,permissionApi);
 if(!stat.isDirectory()||permissions.uid!==0||permissions.gid!==0||(permissions.mode&0o001)===0||(permissions.mode&0o022)!==0)throw fail('HOSTED_VOLUME_ROOT_UNSAFE');
 return stat;
}

async function assertAppDirectory(target,{fsApi,permissionApi,uid,gid,device}){
 const {stat,permissions}=await lstatRequired(target,fsApi,permissionApi);
 if(!stat.isDirectory()||stat.dev!==device||permissions.uid!==uid||permissions.gid!==gid||permissions.mode!==0o700)throw fail('HOSTED_PRIVATE_DIRECTORY_UNSAFE');
 return stat;
}

function validateFixedEnvironment(env,root){
 const expected={
  OBJECT_STORE:'filesystem',
  OBJECT_STORE_PATH:path.join(root,'objects'),
  SECRET_KEYRING_PATH:path.join(root,'keys','keyring.json'),
  REPORT_SIGNING_KEY_PATH:path.join(root,'keys','report-private.pem'),
  REPORT_SIGNING_PUBLIC_KEY_PATH:path.join(root,'keys','report-public.pem'),
 };
 for(const [name,value] of Object.entries(expected)){
  if(env[name]!==undefined&&env[name]!==value)throw fail('HOSTED_PRIVATE_PATH_CONFIGURATION_INVALID');
  env[name]=value;
 }
}

function decodeInput(value,maxBytes){
 if(typeof value!=='string'||value.length===0||value.length>Math.ceil(maxBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw fail('HOSTED_SEALED_INPUT_INVALID');
 const bytes=Buffer.from(value,'base64');
 if(bytes.length===0||bytes.length>maxBytes||bytes.toString('base64')!==value)throw fail('HOSTED_SEALED_INPUT_INVALID');
 return bytes;
}

function parseKeyring(bytes){
 let value;try{value=JSON.parse(decoder.decode(bytes));}catch{throw fail('HOSTED_KEYRING_INVALID');}
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='active,keys'||typeof value.active!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.active)||!value.keys||Object.getPrototypeOf(value.keys)!==Object.prototype)throw fail('HOSTED_KEYRING_INVALID');
 const versions=Object.keys(value.keys);
 if(versions.length<1||versions.length>32||!versions.every(version=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))||!Object.hasOwn(value.keys,value.active))throw fail('HOSTED_KEYRING_INVALID');
 for(const version of versions){
  const encoded=value.keys[version];if(typeof encoded!=='string'||!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(encoded))throw fail('HOSTED_KEYRING_INVALID');
  const key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)throw fail('HOSTED_KEYRING_INVALID');key.fill(0);
 }
}

function parsePem(bytes,kind){
 let pem;try{pem=decoder.decode(bytes);}catch{throw fail('HOSTED_SIGNING_KEY_INVALID');}
 try{
  if(kind==='private'){
   const key=createPrivateKey({key:pem,format:'pem',type:'pkcs8'});
   if(key.asymmetricKeyType!=='ed25519'||!Buffer.from(key.export({format:'pem',type:'pkcs8'})).equals(bytes))throw fail('HOSTED_SIGNING_KEY_INVALID');
   return key;
  }
  const key=createPublicKey({key:pem,format:'pem',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519'||!Buffer.from(key.export({format:'pem',type:'spki'})).equals(bytes))throw fail('HOSTED_SIGNING_KEY_INVALID');
  return key;
 }catch(error){if(error?.code==='HOSTED_SIGNING_KEY_INVALID')throw error;throw fail('HOSTED_SIGNING_KEY_INVALID');}
}

function validateSecretBundle(bytesByName){
 const keyring=bytesByName.get('keyring.json'),privateBytes=bytesByName.get('report-private.pem'),publicBytes=bytesByName.get('report-public.pem');
 if(!keyring||!privateBytes||!publicBytes)throw fail('HOSTED_SEALED_INPUTS_INCOMPLETE');
 parseKeyring(keyring);
 const privateKey=parsePem(privateBytes,'private'),publicKey=parsePem(publicBytes,'public');
 const derived=createPublicKey(privateKey).export({format:'der',type:'spki'}),supplied=publicKey.export({format:'der',type:'spki'});
 if(!Buffer.from(derived).equals(Buffer.from(supplied)))throw fail('HOSTED_SIGNING_KEY_MISMATCH');
}

async function readBoundedHandle(handle,target,maxBytes,expected,{permissionApi,requirePrivateFile=true}){
 let stat;try{stat=await handle.stat();}catch{throw fail('HOSTED_PRIVATE_FILE_UNAVAILABLE');}
 const permissions=permissionApi.inspect(target,stat);
 if(!stat.isFile()||permissions.uid!==expected.uid||permissions.gid!==expected.gid||permissions.mode!==0o600||(requirePrivateFile&&permissions.nlink!==1)||stat.size>maxBytes)throw fail('HOSTED_PRIVATE_FILE_UNSAFE');
 const chunks=[];let total=0;const buffer=Buffer.alloc(4096);
 try{
  while(true){
   let result;try{result=await handle.read(buffer,0,buffer.length,null);}catch{throw fail('HOSTED_PRIVATE_FILE_UNAVAILABLE');}
   if(result.bytesRead===0)break;total+=result.bytesRead;if(total>maxBytes)throw fail('HOSTED_PRIVATE_FILE_TOO_LARGE');chunks.push(Buffer.from(buffer.subarray(0,result.bytesRead)));
  }
  return Buffer.concat(chunks,total);
 }finally{buffer.fill(0);for(const chunk of chunks)chunk.fill(0);}
}

async function readPrivateFile(target,maxBytes,{fsApi,permissionApi,uid,gid,device}){
 const {stat,permissions}=await lstatRequired(target,fsApi,permissionApi);
 if(!stat.isFile()||stat.dev!==device||permissions.uid!==uid||permissions.gid!==gid||permissions.mode!==0o600||permissions.nlink!==1||stat.size>maxBytes)throw fail('HOSTED_PRIVATE_FILE_UNSAFE');
 const flags=fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0);let handle;
 try{handle=await fsApi.open(target,flags);const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw fail('HOSTED_PRIVATE_FILE_CHANGED');return await readBoundedHandle(handle,target,maxBytes,{uid,gid},{permissionApi});}
 catch(error){if(error?.code?.startsWith?.('HOSTED_'))throw error;throw fail('HOSTED_PRIVATE_FILE_UNAVAILABLE');}
 finally{await handle?.close().catch(()=>{});}
}

async function syncPrivateFile(target,expected,{fsApi}){
 const flags=fsConstants.O_RDWR|(fsConstants.O_NOFOLLOW??0);let handle;
 try{handle=await fsApi.open(target,flags);const opened=await handle.stat();if(opened.dev!==expected.dev||opened.ino!==expected.ino)throw fail('HOSTED_PRIVATE_FILE_CHANGED');await handle.sync();}
 catch(error){if(error?.code?.startsWith?.('HOSTED_'))throw error;throw fail('HOSTED_PRIVATE_SYNC_FAILED');}
 finally{await handle?.close().catch(()=>{});}
}

async function optionalPrivateFile(target,maxBytes,context){
 try{return await readPrivateFile(target,maxBytes,context);}
 catch(error){if(error?.code==='HOSTED_PRIVATE_PATH_MISSING')return null;throw error;}
}

async function optionalPrivateInfo(target,fsApi,permissionApi){
 try{return await lstatRequired(target,fsApi,permissionApi);}
 catch(error){if(error?.code==='HOSTED_PRIVATE_PATH_MISSING')return null;throw error;}
}

function isLinkedTemporaryPair(targetInfo,temporaryInfo,{uid,gid,device}){
 const {stat:targetStat,permissions:targetPermissions}=targetInfo,{stat:temporaryStat,permissions:temporaryPermissions}=temporaryInfo;
 return targetStat.isFile()&&temporaryStat.isFile()&&targetStat.dev===device&&temporaryStat.dev===device&&targetStat.dev===temporaryStat.dev&&targetStat.ino===temporaryStat.ino&&targetPermissions.uid===uid&&temporaryPermissions.uid===uid&&targetPermissions.gid===gid&&temporaryPermissions.gid===gid&&targetPermissions.mode===0o600&&temporaryPermissions.mode===0o600&&targetPermissions.nlink===2&&temporaryPermissions.nlink===2;
}

async function readLinkedTemporary(target,targetInfo,{fsApi,permissionApi,uid,gid,maxBytes}){
 const flags=fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0);let handle;
 try{
  handle=await fsApi.open(target,flags);const opened=await handle.stat();
  if(opened.dev!==targetInfo.stat.dev||opened.ino!==targetInfo.stat.ino||opened.nlink!==2)throw fail('HOSTED_PRIVATE_FILE_CHANGED');
  return await readBoundedHandle(handle,target,maxBytes,{uid,gid},{permissionApi,requirePrivateFile:false});
 }catch(error){if(error?.code?.startsWith?.('HOSTED_'))throw error;throw fail('HOSTED_PRIVATE_FILE_UNAVAILABLE');}
 finally{await handle?.close().catch(()=>{});}
}

async function recoverLinkedTemporary(target,temporary,bytes,maxBytes,{fsApi,permissionApi,uid,gid,device,syncDir}){
 const [targetInfo,temporaryInfo]=await Promise.all([optionalPrivateInfo(target,fsApi,permissionApi),optionalPrivateInfo(temporary,fsApi,permissionApi)]);
 if(!targetInfo||!temporaryInfo||!isLinkedTemporaryPair(targetInfo,temporaryInfo,{uid,gid,device}))return false;
 const linkedBytes=await readLinkedTemporary(target,targetInfo,{fsApi,permissionApi,uid,gid,maxBytes});
 const same=linkedBytes.equals(bytes);linkedBytes.fill(0);if(!same)throw fail('HOSTED_SECRET_TEMPORARY_CONFLICT');
 const [currentTarget,currentTemporary]=await Promise.all([optionalPrivateInfo(target,fsApi,permissionApi),optionalPrivateInfo(temporary,fsApi,permissionApi)]);
 if(!currentTarget||!currentTemporary||!isLinkedTemporaryPair(currentTarget,currentTemporary,{uid,gid,device})||currentTarget.stat.ino!==targetInfo.stat.ino)throw fail('HOSTED_PRIVATE_FILE_CHANGED');
 try{await fsApi.unlink(temporary);await syncDir(path.dirname(target),fsApi);}catch{throw fail('HOSTED_SECRET_PUBLISH_FAILED');}
 const published=await readPrivateFile(target,maxBytes,{fsApi,permissionApi,uid,gid,device});const matches=published.equals(bytes);published.fill(0);if(!matches)throw fail('HOSTED_SECRET_PUBLISH_FAILED');
 return true;
}

async function syncDirectory(directory,fsApi){
 const flags=fsConstants.O_RDONLY|(fsConstants.O_DIRECTORY??0);let handle;
 try{handle=await fsApi.open(directory,flags);await handle.sync();}
 catch{throw fail('HOSTED_PRIVATE_SYNC_FAILED');}
 finally{await handle?.close().catch(()=>{});}
}

async function publishCreateOnly(target,bytes,maxBytes,{fsApi,permissionApi,uid,gid,device,syncDir=syncDirectory}){
 const temporary=path.join(path.dirname(target),`.faultline-secret-${path.basename(target)}.tmp`);
 const fileContext={fsApi,permissionApi,uid,gid,device};
 if(await recoverLinkedTemporary(target,temporary,bytes,maxBytes,{...fileContext,syncDir}))return;
 const existing=await optionalPrivateFile(target,maxBytes,{fsApi,permissionApi,uid,gid,device});
 const stranded=await optionalPrivateFile(temporary,maxBytes,fileContext);
 if(existing){
  const same=existing.equals(bytes);existing.fill(0);if(!same){stranded?.fill(0);throw fail('HOSTED_SECRET_FILE_CONFLICT');}
  if(stranded){const recovered=stranded.equals(bytes);stranded.fill(0);if(!recovered)throw fail('HOSTED_SECRET_TEMPORARY_CONFLICT');try{await fsApi.unlink(temporary);await syncDir(path.dirname(target),fsApi);}catch{throw fail('HOSTED_SECRET_PUBLISH_FAILED');}}
  return;
 }
 const recoveringTemporary=Boolean(stranded);
 if(stranded){const recovered=stranded.equals(bytes);stranded.fill(0);if(!recovered)throw fail('HOSTED_SECRET_TEMPORARY_CONFLICT');}
 const flags=fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|(fsConstants.O_NOFOLLOW??0);let handle,linked=false,temporaryOwned=false,temporaryIdentity;
 try{
  if(!recoveringTemporary){handle=await fsApi.open(temporary,flags,0o600);temporaryOwned=true;await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;}
  const tempStat=await fsApi.lstat(temporary);temporaryIdentity={dev:tempStat.dev,ino:tempStat.ino};
  const tempBytes=await readPrivateFile(temporary,maxBytes,fileContext);if(!tempBytes.equals(bytes)){tempBytes.fill(0);throw fail('HOSTED_SECRET_TEMPORARY_INVALID');}tempBytes.fill(0);
  if(recoveringTemporary)await syncPrivateFile(temporary,temporaryIdentity,{fsApi});
  try{await fsApi.link(temporary,target);linked=true;}catch(error){
   if(error?.code==='EEXIST'){
    const raced=await readPrivateFile(target,maxBytes,{fsApi,permissionApi,uid,gid,device});const same=raced.equals(bytes);raced.fill(0);if(!same)throw fail('HOSTED_SECRET_FILE_CONFLICT');
   }else throw fail('HOSTED_SECRET_PUBLISH_FAILED');
  }
  await fsApi.unlink(temporary);temporaryOwned=false;
  await syncDir(path.dirname(target),fsApi);
  const published=await readPrivateFile(target,maxBytes,{fsApi,permissionApi,uid,gid,device});const matches=published.equals(bytes);published.fill(0);if(!matches)throw fail('HOSTED_SECRET_PUBLISH_FAILED');
 }catch(error){
  await handle?.close().catch(()=>{});
  if(linked&&temporaryIdentity){try{const now=await fsApi.lstat(target);if(now.dev===temporaryIdentity.dev&&now.ino===temporaryIdentity.ino&&now.nlink<=2)await fsApi.unlink(target);}catch{/* the published file may already be complete */}}
  if(temporaryOwned)await fsApi.unlink(temporary).catch(()=>{});
  if(error?.code?.startsWith?.('HOSTED_'))throw error;
  throw fail('HOSTED_SECRET_PUBLISH_FAILED');
 }
}

async function validateDirectoryContents(directory,allowedNames,fsApi){
 let names;try{names=await fsApi.readdir(directory);}catch{throw fail('HOSTED_PRIVATE_DIRECTORY_UNAVAILABLE');}
 if(names.some(name=>!allowedNames.has(name)))throw fail('HOSTED_PRIVATE_UNEXPECTED_ENTRY');
}

/** Validate the fixed mounted storage and materialize only explicitly supplied sealed inputs. */
export async function prepareHostedPrivateRuntime({root=HOSTED_VOLUME_ROOT,env=process.env,fsApi=fs,permissionApi={inspect:defaultPermissionInfo},identity=()=>({uid:process.getuid?.(),gid:process.getgid?.()}),verifyMount=verifyMountedRoot,syncDir=syncDirectory}={}){
 const sealedValues=Object.fromEntries(HOSTED_SECRET_INPUTS.map(name=>[name,env[name]]));let buffers=[];
 try{
  if(env.NODE_ENV!=='production')throw fail('HOSTED_RUNTIME_REQUIRES_PRODUCTION');
  for(const name of HOSTED_OPERATOR_ONLY_INPUTS)if(env[name]!==undefined&&env[name]!=='')throw fail('HOSTED_OPERATOR_INPUT_REFUSED');
  const who=identity();if(who?.uid!==1000||who?.gid!==1000)throw fail('HOSTED_RUNTIME_IDENTITY_UNSAFE');
  await verifyMount(root,fsApi);
  const rootStat=await assertRootDirectory(root,fsApi,permissionApi);
  const objectDirectory=path.join(root,'objects'),keyDirectory=path.join(root,'keys');
  await assertAppDirectory(objectDirectory,{fsApi,permissionApi,uid:who.uid,gid:who.gid,device:rootStat.dev});
  await assertAppDirectory(keyDirectory,{fsApi,permissionApi,uid:who.uid,gid:who.gid,device:rootStat.dev});
  validateFixedEnvironment(env,root);
  const supplied=HOSTED_SECRET_INPUTS.map(name=>sealedValues[name]!==undefined&&sealedValues[name]!==''),suppliedCount=supplied.filter(Boolean).length;
  if(suppliedCount!==0&&suppliedCount!==HOSTED_SECRET_INPUTS.length)throw fail('HOSTED_SEALED_INPUTS_INCOMPLETE');
  const allowedEntries=suppliedCount===HOSTED_SECRET_INPUTS.length?new Set([...secretFileNames,...secretTemporaryNames]):secretFileNames;
  await validateDirectoryContents(keyDirectory,allowedEntries,fsApi);
  const byName=new Map();
  if(suppliedCount===HOSTED_SECRET_INPUTS.length){
   for(const descriptor of secretFiles){const value=sealedValues[descriptor.inputName];const bytes=decodeInput(value,descriptor.maxBytes);buffers.push(bytes);byName.set(descriptor.name,bytes);}
   validateSecretBundle(byName);
   for(const descriptor of secretFiles)await publishCreateOnly(path.join(keyDirectory,descriptor.name),byName.get(descriptor.name),descriptor.maxBytes,{fsApi,permissionApi,uid:who.uid,gid:who.gid,device:rootStat.dev,syncDir});
  }
  for(const descriptor of secretFiles){
   const file=path.join(keyDirectory,descriptor.name);if(!byName.has(descriptor.name)){const bytes=await readPrivateFile(file,descriptor.maxBytes,{fsApi,permissionApi,uid:who.uid,gid:who.gid,device:rootStat.dev});buffers.push(bytes);byName.set(descriptor.name,bytes);}
  }
  validateSecretBundle(byName);
  await validateDirectoryContents(keyDirectory,secretFileNames,fsApi);
  validateFixedEnvironment(env,root);
  return {status:'HOSTED_PRIVATE_RUNTIME_READY'};
 }catch(error){
  if(error?.code?.startsWith?.('HOSTED_'))throw error;
  throw fail('HOSTED_PRIVATE_RUNTIME_FAILED');
 }finally{
  for(const bytes of buffers)bytes.fill(0);
  for(const name of HOSTED_SECRET_INPUTS){delete env[name];sealedValues[name]=undefined;}
 }
}

async function main(){
 try{await prepareHostedPrivateRuntime();}
 catch(error){console.error(error?.code?.startsWith?.('HOSTED_')?error.code:'HOSTED_PRIVATE_RUNTIME_FAILED');process.exitCode=1;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
