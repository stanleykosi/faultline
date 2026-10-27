import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HOSTED_SECRET_INPUTS,prepareHostedPrivateRuntime} from '../../scripts/hosted-private-runtime.mjs';

const keyNames=['keyring.json','report-private.pem','report-public.pem'];
const inputNames=HOSTED_SECRET_INPUTS;

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-private-runtime-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const objects=path.join(root,'objects'),keys=path.join(root,'keys');
 await fs.mkdir(objects);await fs.mkdir(keys);
 const pair=generateKeyPairSync('ed25519');
 const ring=Buffer.from(JSON.stringify({active:'test-v1',keys:{'test-v1':Buffer.alloc(32,0x5a).toString('base64')}}));
 const privatePem=Buffer.from(pair.privateKey.export({format:'pem',type:'pkcs8'}));
 const publicPem=Buffer.from(pair.publicKey.export({format:'pem',type:'spki'}));
 const inputBytes=new Map([['keyring.json',ring],['report-private.pem',privatePem],['report-public.pem',publicPem]]);
 const env={NODE_ENV:'production',OBJECT_STORE:'filesystem',OBJECT_STORE_PATH:objects,SECRET_KEYRING_PATH:path.join(keys,'keyring.json'),REPORT_SIGNING_KEY_PATH:path.join(keys,'report-private.pem'),REPORT_SIGNING_PUBLIC_KEY_PATH:path.join(keys,'report-public.pem')};
 for(let index=0;index<keyNames.length;index++)env[inputNames[index]]=inputBytes.get(keyNames[index]).toString('base64');
 const overrides=new Map();
 const permissionApi={inspect(target,stat){
  const relative=path.relative(root,target).split(path.sep).join('/');
  const base=relative===''?{uid:0,gid:0,mode:0o755}:{uid:1000,gid:1000,mode:stat.isDirectory()?0o700:0o600};
  return {...base,...(overrides.get(relative)??{}),nlink:stat.nlink};
 }};
 const options={root,env,permissionApi,identity:()=>({uid:1000,gid:1000}),verifyMount:async target=>assert.equal(target,root),syncDir:async()=>{}};
 return {root,objects,keys,env,pair,inputBytes,overrides,permissionApi,options};
}

function freshEnv(f,inputs=true){
 const env={NODE_ENV:'production',OBJECT_STORE:'filesystem',OBJECT_STORE_PATH:f.objects,SECRET_KEYRING_PATH:path.join(f.keys,'keyring.json'),REPORT_SIGNING_KEY_PATH:path.join(f.keys,'report-private.pem'),REPORT_SIGNING_PUBLIC_KEY_PATH:path.join(f.keys,'report-public.pem')};
 if(inputs)for(let index=0;index<keyNames.length;index++)env[inputNames[index]]=f.inputBytes.get(keyNames[index]).toString('base64');
 return env;
}

test('materializes a valid synthetic AES keyring and matching Ed25519 pair as private create-only files',async t=>{
 const f=await fixture(t);assert.deepEqual(await prepareHostedPrivateRuntime(f.options),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
 for(const name of keyNames){const file=path.join(f.keys,name);assert.ok((await fs.stat(file)).isFile());assert.equal((await fs.stat(file)).nlink,1);assert.equal(Object.hasOwn(f.env,inputNames[keyNames.indexOf(name)]),false);}
 assert.equal(f.env.SECRET_KEYRING_PATH,path.join(f.keys,'keyring.json'));
 assert.equal(f.env.REPORT_SIGNING_KEY_PATH,path.join(f.keys,'report-private.pem'));
 assert.equal(f.env.REPORT_SIGNING_PUBLIC_KEY_PATH,path.join(f.keys,'report-public.pem'));
 assert.equal(f.env.OBJECT_STORE_PATH,f.objects);
});

test('identical input retries and validated pre-provisioned files are idempotent',async t=>{
 const f=await fixture(t);await prepareHostedPrivateRuntime(f.options);
 const retry={...f.options,env:freshEnv(f)};assert.deepEqual(await prepareHostedPrivateRuntime(retry),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
 const preprovisioned={...f.options,env:freshEnv(f,false)};assert.deepEqual(await prepareHostedPrivateRuntime(preprovisioned),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
});

test('complete crash-leftover temporary secret files recover only with the identical sealed bundle',async t=>{
 const f=await fixture(t),temporary=path.join(f.keys,'.faultline-secret-keyring.json.tmp');
 await fs.writeFile(temporary,f.inputBytes.get('keyring.json'),{mode:0o600});
 assert.deepEqual(await prepareHostedPrivateRuntime(f.options),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
 assert.deepEqual((await fs.readdir(f.keys)).sort(),[...keyNames].sort());
 assert.deepEqual(await fs.readFile(path.join(f.keys,'keyring.json')),f.inputBytes.get('keyring.json'));
});

test('post-link crash state is recovered only for the same private inode and bytes',async t=>{
 const f=await fixture(t),temporary=path.join(f.keys,'.faultline-secret-keyring.json.tmp'),target=path.join(f.keys,'keyring.json');
 await fs.writeFile(temporary,f.inputBytes.get('keyring.json'),{mode:0o600});await fs.link(temporary,target);
 assert.equal((await fs.stat(target)).nlink,2);
 assert.deepEqual(await prepareHostedPrivateRuntime(f.options),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
 assert.equal((await fs.stat(target)).nlink,1);await assert.rejects(fs.stat(temporary),error=>error.code==='ENOENT');
 assert.deepEqual((await fs.readdir(f.keys)).sort(),[...keyNames].sort());
});

test('post-link crash state with different bytes remains untouched and fails closed',async t=>{
 const f=await fixture(t),temporary=path.join(f.keys,'.faultline-secret-keyring.json.tmp'),target=path.join(f.keys,'keyring.json'),marker=Buffer.from('SYNTHETIC-POST-LINK-MARKER');
 await fs.writeFile(temporary,marker,{mode:0o600});await fs.link(temporary,target);
 await assert.rejects(prepareHostedPrivateRuntime(f.options),error=>error.code==='HOSTED_SECRET_TEMPORARY_CONFLICT'&&!error.message.includes(marker.toString()));
 assert.equal((await fs.stat(target)).nlink,2);assert.equal((await fs.stat(temporary)).nlink,2);
 assert.deepEqual((await fs.readFile(target)),marker);assert.deepEqual((await fs.readFile(temporary)),marker);
});

test('conflicting crash-leftover temporary data is preserved and startup fails closed',async t=>{
 const f=await fixture(t),temporary=path.join(f.keys,'.faultline-secret-keyring.json.tmp'),marker=Buffer.from('SYNTHETIC-STALE-MARKER');
 await fs.writeFile(temporary,marker,{mode:0o600});
 await assert.rejects(prepareHostedPrivateRuntime(f.options),error=>error.code==='HOSTED_SECRET_TEMPORARY_CONFLICT'&&!error.message.includes(marker.toString()));
 assert.deepEqual(await fs.readdir(f.keys),['.faultline-secret-keyring.json.tmp']);
 assert.deepEqual(await fs.readFile(temporary),marker);
});

test('conflicting input never overwrites an existing key file',async t=>{
 const f=await fixture(t);await prepareHostedPrivateRuntime(f.options);
 const before=await fs.readFile(path.join(f.keys,'keyring.json'));
 const changed=Buffer.from(JSON.stringify({active:'test-v2',keys:{'test-v2':Buffer.alloc(32,0x6b).toString('base64')}}));
 const conflictEnv=freshEnv(f);conflictEnv[inputNames[0]]=changed.toString('base64');
 await assert.rejects(prepareHostedPrivateRuntime({...f.options,env:conflictEnv}),error=>error.code==='HOSTED_SECRET_FILE_CONFLICT'&&!error.message.includes(changed.toString('base64')));
 assert.deepEqual(await fs.readFile(path.join(f.keys,'keyring.json')),before);
});

test('partial, malformed, oversized and mismatched sealed bundles reject and clear raw payloads',async t=>{
 const cases=[
  {name:'partial',mutate:f=>{delete f.env[inputNames[2]];},code:'HOSTED_SEALED_INPUTS_INCOMPLETE'},
  {name:'invalid base64',mutate:f=>{f.env[inputNames[0]]='not-base64-SYNTHETIC-MARKER';},code:'HOSTED_SEALED_INPUT_INVALID'},
  {name:'oversized input',mutate:f=>{f.env[inputNames[0]]='A'.repeat(40_000);},code:'HOSTED_SEALED_INPUT_INVALID'},
  {name:'malformed keyring',mutate:f=>{f.env[inputNames[0]]=Buffer.from('{"active":"x","keys":[]}').toString('base64');},code:'HOSTED_KEYRING_INVALID'},
  {name:'mismatched public signer',mutate:f=>{f.env[inputNames[2]]=Buffer.from(generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'})).toString('base64');},code:'HOSTED_SIGNING_KEY_MISMATCH'},
 ];
 for(const item of cases)await t.test(item.name,async sub=>{
  const f=await fixture(sub);item.mutate(f);const raw=f.env[inputNames[0]];
  await assert.rejects(prepareHostedPrivateRuntime(f.options),error=>error.code===item.code&&!error.message.includes('SYNTHETIC-MARKER')&&(!raw||!error.message.includes(raw)));
  for(const name of inputNames)assert.equal(Object.hasOwn(f.env,name),false);
  assert.deepEqual(await fs.readdir(f.keys),[]);
 });
});

test('refuses migration and backup-wrap operator inputs without echoing them',async t=>{
 for(const name of ['MIGRATION_DATABASE_URL','BACKUP_WRAP_KEY_PATH','BACKUP_WRAP_KEY_BASE64'])await t.test(name,async sub=>{
  const f=await fixture(sub),marker=`SYNTHETIC-OPERATOR-MARKER-${name}`;f.env[name]=marker;
  await assert.rejects(prepareHostedPrivateRuntime(f.options),error=>error.code==='HOSTED_OPERATOR_INPUT_REFUSED'&&!error.message.includes(marker));
  for(const input of inputNames)assert.equal(Object.hasOwn(f.env,input),false);
  assert.deepEqual(await fs.readdir(f.keys),[]);
 });
});

test('runtime helper refuses root fallback and unsafe mounted-root permissions',async t=>{
 const rootCase=await fixture(t);rootCase.overrides.set('',{uid:0,gid:0,mode:0o777});
 await assert.rejects(prepareHostedPrivateRuntime(rootCase.options),error=>error.code==='HOSTED_VOLUME_ROOT_UNSAFE');
 assert.deepEqual(await fs.readdir(rootCase.keys),[]);
 const identityCase=await fixture(t),rootOptions={...identityCase.options,identity:()=>({uid:0,gid:0})};
 await assert.rejects(prepareHostedPrivateRuntime(rootOptions),error=>error.code==='HOSTED_RUNTIME_IDENTITY_UNSAFE');
 assert.deepEqual(await fs.readdir(identityCase.keys),[]);
});

test('rejects path overrides, symlinks, unsafe owner/mode, and unexpected secret-directory entries',async t=>{
 const pathCase=await fixture(t);pathCase.env.SECRET_KEYRING_PATH=path.join(pathCase.root,'..','escape.json');
 await assert.rejects(prepareHostedPrivateRuntime(pathCase.options),error=>error.code==='HOSTED_PRIVATE_PATH_CONFIGURATION_INVALID');

 const symlinkCase=await fixture(t);await fs.rm(symlinkCase.objects,{recursive:true});const outside=path.join(symlinkCase.root,'outside');await fs.mkdir(outside);await fs.symlink(outside,symlinkCase.objects,process.platform==='win32'?'junction':'dir');
 await assert.rejects(prepareHostedPrivateRuntime(symlinkCase.options),error=>error.code==='HOSTED_PRIVATE_SYMLINK_REFUSED');

 const ownerCase=await fixture(t);ownerCase.overrides.set('objects',{uid:0,gid:0});
 await assert.rejects(prepareHostedPrivateRuntime(ownerCase.options),error=>error.code==='HOSTED_PRIVATE_DIRECTORY_UNSAFE');

 const modeCase=await fixture(t);modeCase.overrides.set('keys',{uid:1000,gid:1000,mode:0o755});
 await assert.rejects(prepareHostedPrivateRuntime(modeCase.options),error=>error.code==='HOSTED_PRIVATE_DIRECTORY_UNSAFE');

 const unexpectedCase=await fixture(t);await fs.writeFile(path.join(unexpectedCase.keys,'backup-wrap.key'),'SYNTHETIC-OPERATOR-MARKER');
 await assert.rejects(prepareHostedPrivateRuntime(unexpectedCase.options),error=>error.code==='HOSTED_PRIVATE_UNEXPECTED_ENTRY'&&!error.message.includes('SYNTHETIC-OPERATOR-MARKER'));
});

test('rejects hardlinked secret files before reading their bytes',async t=>{
 const f=await fixture(t);const keyring=path.join(f.keys,'keyring.json'),external=path.join(f.root,'synthetic-link');
 await fs.writeFile(keyring,'SYNTHETIC-KEY-MARKER');await fs.link(keyring,external);
 const env=freshEnv(f,false),options={...f.options,env};
 await assert.rejects(prepareHostedPrivateRuntime(options),error=>error.code==='HOSTED_PRIVATE_FILE_UNSAFE'&&!error.message.includes('SYNTHETIC-KEY-MARKER'));
});

test('atomic publication failure leaves no partial file and a same-input retry succeeds',async t=>{
 const f=await fixture(t);let links=0;
 const injectedFs=new Proxy(fs,{get(target,property){if(property==='link')return async(...args)=>{links++;if(links===2){const error=new Error('synthetic injected failure');error.code='EIO';throw error;}return target.link(...args);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 const options={...f.options,fsApi:injectedFs};
 await assert.rejects(prepareHostedPrivateRuntime(options),error=>error.code==='HOSTED_SECRET_PUBLISH_FAILED'&&!error.message.includes('synthetic injected failure'));
 const afterFailure=await fs.readdir(f.keys);assert.deepEqual(afterFailure,['keyring.json']);
 const retry={...f.options,env:freshEnv(f)};assert.deepEqual(await prepareHostedPrivateRuntime(retry),{status:'HOSTED_PRIVATE_RUNTIME_READY'});
 assert.deepEqual((await fs.readdir(f.keys)).sort(),[...keyNames].sort());
});
