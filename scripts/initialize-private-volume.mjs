import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PRIVATE_VOLUME_ROOT='/data';
export const PRIVATE_VOLUME_UID=1000;
export const PRIVATE_VOLUME_GID=1000;
export const PRIVATE_VOLUME_DIRECTORIES=Object.freeze(['objects','keys']);
export const PRIVATE_VOLUME_SYSTEM_DIRECTORIES=Object.freeze(['lost+found']);

function fail(code){const error=new Error(code);error.code=code;return error;}
function decodeMountPath(value){return value.replace(/\\([0-7]{3})/g,(_match,octal)=>String.fromCharCode(Number.parseInt(octal,8)));}

export function mountInfoHasExactPath(mountInfo,target){
 if(typeof mountInfo!=='string'||typeof target!=='string'||!path.posix.isAbsolute(target))return false;
 for(const line of mountInfo.split(/\r?\n/)){
  const separator=line.indexOf(' - ');if(separator<0)continue;
  const fields=line.slice(0,separator).split(' ');
  if(fields.length>=5&&decodeMountPath(fields[4])===target)return true;
 }
 return false;
}

function validateSnapshot({root,rootPermissions,rootDevice,entries}){
 if(root!==PRIVATE_VOLUME_ROOT||rootPermissions?.uid!==0||rootPermissions?.gid!==0||!Number.isInteger(rootPermissions?.mode)||(rootPermissions.mode&0o022)!==0||(rootPermissions.mode&0o001)===0||!Number.isInteger(rootDevice))throw fail('PRIVATE_VOLUME_ROOT_UNSAFE');
 const allowedEntries=[...PRIVATE_VOLUME_DIRECTORIES,...PRIVATE_VOLUME_SYSTEM_DIRECTORIES];
 if(!Array.isArray(entries)||entries.some(entry=>!allowedEntries.includes(entry.name)))throw fail('PRIVATE_VOLUME_UNEXPECTED_ENTRY');
 const byName=new Map(entries.map(entry=>[entry.name,entry]));if(byName.size!==entries.length)throw fail('PRIVATE_VOLUME_UNEXPECTED_ENTRY');
 for(const name of PRIVATE_VOLUME_SYSTEM_DIRECTORIES){
  const entry=byName.get(name);if(!entry)continue;
  if(entry.symlink||!entry.directory||entry.device!==rootDevice||entry.uid!==0||entry.gid!==0||entry.mode!==0o700||entry.nlink!==2||!Array.isArray(entry.children)||entry.children.length!==0)throw fail('PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED');
 }
 const actions=[];
 for(const name of PRIVATE_VOLUME_DIRECTORIES){
  const entry=byName.get(name);
  if(!entry){actions.push({kind:'create_and_assign',name,uid:PRIVATE_VOLUME_UID,gid:PRIVATE_VOLUME_GID,mode:0o700});continue;}
  if(entry.symlink||!entry.directory||entry.device!==rootDevice||!Array.isArray(entry.children)||entry.children.length!==0)throw fail('PRIVATE_VOLUME_EXISTING_DATA_REFUSED');
  const safeMode=Number.isInteger(entry.mode)&&(entry.mode&0o022)===0;
  if(!safeMode)throw fail('PRIVATE_VOLUME_EXISTING_MODE_REFUSED');
  if(entry.uid===PRIVATE_VOLUME_UID&&entry.gid===PRIVATE_VOLUME_GID&&entry.mode===0o700){actions.push({kind:'verify_only',name,uid:PRIVATE_VOLUME_UID,gid:PRIVATE_VOLUME_GID,mode:0o700});continue;}
  if(entry.uid===0&&entry.gid===0){actions.push({kind:'assign_empty_root_directory',name,uid:PRIVATE_VOLUME_UID,gid:PRIVATE_VOLUME_GID,mode:0o700});continue;}
  throw fail('PRIVATE_VOLUME_EXISTING_OWNER_REFUSED');
 }
 return actions;
}

/** Pure policy planner: tests may exercise this without invoking the root-only initializer. */
export function planPrivateVolumeInitialization(snapshot){return validateSnapshot(snapshot);}

function defaultPermissionInfo(_target,stat){return {uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777};}
async function verifyMountedRoot(root,fsApi){
 if(process.platform!=='linux'||root!==PRIVATE_VOLUME_ROOT)throw fail('PRIVATE_VOLUME_MOUNT_REQUIRED');
 let mountInfo;try{mountInfo=await fsApi.readFile('/proc/self/mountinfo','utf8');}catch{throw fail('PRIVATE_VOLUME_MOUNT_UNVERIFIABLE');}
 if(!mountInfoHasExactPath(mountInfo,root))throw fail('PRIVATE_VOLUME_MOUNT_REQUIRED');
}
async function readPath(target,rootDevice,fsApi,permissionApi){
 let stat;try{stat=await fsApi.lstat(target);}catch(error){if(error?.code==='ENOENT')return null;throw fail('PRIVATE_VOLUME_PATH_UNAVAILABLE');}
 if(stat.isSymbolicLink())throw fail('PRIVATE_VOLUME_SYMLINK_REFUSED');
 let actual;try{actual=await fsApi.realpath(target);}catch{throw fail('PRIVATE_VOLUME_PATH_UNAVAILABLE');}
 if(path.resolve(actual)!==path.resolve(target))throw fail('PRIVATE_VOLUME_PATH_ESCAPE');
 const permissions=permissionApi.inspect(target,stat);
 if(stat.dev!==rootDevice)throw fail('PRIVATE_VOLUME_DEVICE_MISMATCH');
 return {stat,permissions};
}
async function setDirectory(target,fsApi,uid,gid,mode){
 const flags=fsConstants.O_RDONLY|(fsConstants.O_DIRECTORY??0)|(fsConstants.O_NOFOLLOW??0);let handle,expected;
 try{
  expected=await fsApi.lstat(target);if(expected.isSymbolicLink()||!expected.isDirectory())throw fail('PRIVATE_VOLUME_DIRECTORY_UNSAFE');
  handle=await fsApi.open(target,flags);
  const stat=await handle.stat(),current=await fsApi.lstat(target);
  if(!stat.isDirectory()||current.isSymbolicLink()||stat.dev!==expected.dev||stat.ino!==expected.ino||current.dev!==expected.dev||current.ino!==expected.ino)throw fail('PRIVATE_VOLUME_SYMLINK_REFUSED');
  const permissions=defaultPermissionInfo(target,stat);if(permissions.uid!==0||permissions.gid!==0||(permissions.mode&0o022)!==0)throw fail('PRIVATE_VOLUME_EXISTING_OWNER_REFUSED');
  if((await fsApi.readdir(target)).length!==0)throw fail('PRIVATE_VOLUME_EXISTING_DATA_REFUSED');
  await handle.chown(uid,gid);await handle.chmod(mode);await handle.sync();
 }catch(error){if(error?.code?.startsWith?.('PRIVATE_VOLUME_'))throw error;throw fail('PRIVATE_VOLUME_PERMISSION_SET_FAILED');}
 finally{await handle?.close().catch(()=>{});}
}
async function syncDirectory(target,fsApi){
 const flags=fsConstants.O_RDONLY|(fsConstants.O_DIRECTORY??0)|(fsConstants.O_NOFOLLOW??0);let handle;
 try{handle=await fsApi.open(target,flags);await handle.sync();}
 catch{throw fail('PRIVATE_VOLUME_SYNC_FAILED');}
 finally{await handle?.close().catch(()=>{});}
}

/** Root-only one-time recipe for a newly attached, empty /data volume; never walks or chowns user data. */
export async function initializePrivateVolume({root=PRIVATE_VOLUME_ROOT,fsApi=fs,permissionApi={inspect:defaultPermissionInfo},identity=()=>({uid:process.getuid?.()}),verifyMount=verifyMountedRoot}={}){
 if(root!==PRIVATE_VOLUME_ROOT||identity()?.uid!==0)throw fail('PRIVATE_VOLUME_ROOT_REQUIRED');
 await verifyMount(root,fsApi);
 let rootStat;try{rootStat=await fsApi.lstat(root);}catch{throw fail('PRIVATE_VOLUME_ROOT_UNAVAILABLE');}
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw fail('PRIVATE_VOLUME_ROOT_UNSAFE');
 let rootReal;try{rootReal=await fsApi.realpath(root);}catch{throw fail('PRIVATE_VOLUME_ROOT_UNAVAILABLE');}
 if(path.resolve(rootReal)!==path.resolve(root))throw fail('PRIVATE_VOLUME_ROOT_UNSAFE');
 const rootPermissions=permissionApi.inspect(root,rootStat);
 if(rootPermissions.uid!==0||rootPermissions.gid!==0||(rootPermissions.mode&0o022)!==0||(rootPermissions.mode&0o001)===0)throw fail('PRIVATE_VOLUME_ROOT_UNSAFE');
 let rootEntries;try{rootEntries=await fsApi.readdir(root);}catch{throw fail('PRIVATE_VOLUME_ROOT_UNAVAILABLE');}
 const entries=[];
 for(const name of PRIVATE_VOLUME_DIRECTORIES){
  const target=path.join(root,name),located=await readPath(target,rootStat.dev,fsApi,permissionApi);
  if(!located){entries.push({name,missing:true});continue;}
  let children;try{children=await fsApi.readdir(target);}catch{throw fail('PRIVATE_VOLUME_DIRECTORY_UNAVAILABLE');}
   entries.push({name,symlink:located.stat.isSymbolicLink(),directory:located.stat.isDirectory(),device:located.stat.dev,uid:located.permissions.uid,gid:located.permissions.gid,mode:located.permissions.mode,nlink:located.stat.nlink,children});
 }
 const plannedEntries=entries.filter(entry=>!entry.missing);
 for(const name of rootEntries.filter(name=>!PRIVATE_VOLUME_DIRECTORIES.includes(name))){
  if(!PRIVATE_VOLUME_SYSTEM_DIRECTORIES.includes(name)){plannedEntries.push({name});continue;}
  const target=path.join(root,name),located=await readPath(target,rootStat.dev,fsApi,permissionApi);
  if(!located)throw fail('PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED');
  let children=null;
  if(located.stat.isDirectory())try{children=await fsApi.readdir(target);}catch{throw fail('PRIVATE_VOLUME_DIRECTORY_UNAVAILABLE');}
  plannedEntries.push({name,symlink:located.stat.isSymbolicLink(),directory:located.stat.isDirectory(),device:located.stat.dev,uid:located.permissions.uid,gid:located.permissions.gid,mode:located.permissions.mode,nlink:located.stat.nlink,children});
 }
 const actions=planPrivateVolumeInitialization({root,rootPermissions,rootDevice:rootStat.dev,entries:plannedEntries});
 for(const action of actions){
  const target=path.join(root,action.name);
  if(action.kind==='create_and_assign'){
   try{await fsApi.mkdir(target,{mode:0o700});}catch(error){throw fail(error?.code==='EEXIST'?'PRIVATE_VOLUME_CREATE_RACE':'PRIVATE_VOLUME_CREATE_FAILED');}
   const created=await readPath(target,rootStat.dev,fsApi,permissionApi);if(!created||!created.stat.isDirectory())throw fail('PRIVATE_VOLUME_DIRECTORY_UNSAFE');
   let children;try{children=await fsApi.readdir(target);}catch{throw fail('PRIVATE_VOLUME_DIRECTORY_UNAVAILABLE');}
   if(children.length!==0)throw fail('PRIVATE_VOLUME_EXISTING_DATA_REFUSED');
   await setDirectory(target,fsApi,action.uid,action.gid,action.mode);
  }else if(action.kind==='assign_empty_root_directory')await setDirectory(target,fsApi,action.uid,action.gid,action.mode);
 }
 for(const name of PRIVATE_VOLUME_DIRECTORIES){
  const target=path.join(root,name),located=await readPath(target,rootStat.dev,fsApi,permissionApi);
  if(!located||!located.stat.isDirectory())throw fail('PRIVATE_VOLUME_DIRECTORY_UNSAFE');
  const perms=located.permissions;if(perms.uid!==PRIVATE_VOLUME_UID||perms.gid!==PRIVATE_VOLUME_GID||perms.mode!==0o700)throw fail('PRIVATE_VOLUME_DIRECTORY_UNSAFE');
  let children;try{children=await fsApi.readdir(target);}catch{throw fail('PRIVATE_VOLUME_DIRECTORY_UNAVAILABLE');}
  if(children.length!==0)throw fail('PRIVATE_VOLUME_EXISTING_DATA_REFUSED');
 }
 await syncDirectory(root,fsApi);
 return 'PRIVATE_VOLUME_READY';
}

async function main(){
 if(process.argv.length!==2){console.error('PRIVATE_VOLUME_ARGUMENTS_REFUSED');process.exitCode=1;return;}
 try{await initializePrivateVolume();console.log('PRIVATE_VOLUME_READY');}
 catch(error){console.error(error?.code?.startsWith?.('PRIVATE_VOLUME_')?error.code:'PRIVATE_VOLUME_INITIALIZATION_FAILED');process.exitCode=1;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
