import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {rpcSignature,signatureMatches} from '../../dist/server/packages/core/src/experiments/protocol.js';
import {stopUnreadyOwnedChild} from './owned-child-stop.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const options=new Map(process.argv.slice(2).map(arg=>{const m=/^--(root|driver-sha256|runner-sha256|owned-stop-sha256)=(.+)$/.exec(arg);assert.ok(m);return [m[1],m[2]];}));
assert.equal(options.size,4);assert.equal(process.argv.length,6);
const selected=options.get('root');assert.match(selected,/^\.runtime\/acceptance\/connected-verification-[a-f0-9-]{36}$/);
const root=path.resolve(selected),entry=path.resolve('dist/server/apps/runner/src/main.js'),source=path.resolve('tools/fixtures/connected-runner.mjs');
for(const key of ['driver-sha256','runner-sha256','owned-stop-sha256'])assert.match(options.get(key),/^[a-f0-9]{64}$/);
assert.equal(hash(await fs.readFile(source)),options.get('driver-sha256'));assert.equal(hash(await fs.readFile(entry)),options.get('runner-sha256'));
assert.equal(hash(await fs.readFile('tools/fixtures/owned-child-stop.mjs')),options.get('owned-stop-sha256'));
const stat=await fs.lstat(root);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(await fs.realpath(root),root);
const nonce=randomUUID(),key=randomBytes(32),keyPath=path.join(root,'runner.key');await fs.writeFile(keyPath,key,{flag:'wx',mode:0o600});
const deadline=Date.now()+900000,port=3042,origin='http://127.0.0.1:3042',replies=[];
const report={schema_version:1,status:'starting',nonce,scope:'owned_private_supplied_fixture_acceptance_only',production_claim_eligible:false,origin,driver_sha256:options.get('driver-sha256'),runner_sha256:options.get('runner-sha256'),started_at:new Date().toISOString(),parent_pid:process.pid,replies,force_kill_fallback:false};
const save=()=>fs.writeFile(path.join(root,'lifecycle.json'),JSON.stringify(report,null,2)+'\n');
async function closedPort(){return new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',()=>{socket.destroy();resolve(true);});socket.once('timeout',()=>{socket.destroy();resolve(false);});});}
assert.equal(await closedPort(),true,'The selected fixture RPC port must initially be unused.');
const env={};for(const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT'])if(process.env[name])env[name]=process.env[name];
Object.assign(env,{NODE_ENV:'development',RUNNER_MODE:'trusted_fixture',ALLOW_FIXTURE_ADAPTERS:'true',RUNNER_FIXTURE_PORT:String(port),RUNNER_AUTH_KEY_PATH:keyPath,RUNNER_ARTIFACT_ROOT:path.join(root,'artifacts'),RUNNER_STATE_ROOT:path.join(root,'state')});
const child=spawn(process.execPath,['--max-old-space-size=128',entry],{cwd:process.cwd(),env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe','ipc']});report.runner_pid=child.pid;
let generation,stdout='',stdoutBytes=0,stderrBytes=0,exit,readyError,reply;
child.on('error',error=>{readyError=error;});child.once('exit',(code,signal)=>{exit={code,signal,at:new Date().toISOString()};report.runner_exit=exit;});
child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;if(stdoutBytes>65536){readyError=Error('Runner metadata exceeded its bound.');return;}stdout+=bytes.toString();let index;while((index=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,index);stdout=stdout.slice(index+1);try{const value=JSON.parse(line);if(value.service==='trusted_fixture_runner'){assert.equal(value.origin,origin);assert.equal(value.production_claim_eligible,false);assert.match(value.generation,/^[a-f0-9-]{36}$/);generation=value.generation;report.generation=generation;}}catch(error){if(line.startsWith('{'))readyError=error;}}});
child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;});
child.on('message',message=>{try{const {signature,...body}=message;assert.ok(signatureMatches(body,signature,key));assert.equal(body.kind,'parent_shutdown_result');assert.equal(body.parent_pid,process.pid);assert.equal(body.pid,child.pid);assert.equal(body.generation,generation);replies.push(body);reply=body;}catch(error){readyError=error;}});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const start=Date.now();while(!generation){if(readyError)throw readyError;if(exit)throw Error('Owned runner exited before readiness.');assert.ok(Date.now()-start<45000,'Owned runner startup deadline exceeded.');await delay(100);}
 report.status='ready';report.key_path=keyPath;report.artifact_root=env.RUNNER_ARTIFACT_ROOT;report.state_root=env.RUNNER_STATE_ROOT;await save();console.log(JSON.stringify({status:'ready',control_root:selected,runner_pid:child.pid,generation,origin}));
 while(true){assert.ok(!exit,'Owned runner exited without requested closure.');assert.ok(Date.now()<deadline,'Acceptance runner exceeded its fifteen-minute finite lifecycle.');let request;try{request=JSON.parse(await fs.readFile(path.join(root,'close-request.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(request){assert.deepEqual(request,{nonce,action:'close_owned_fixture_acceptance'});break;}await delay(500);}
 report.status='closing';await save();
}catch(error){report.status='failed';report.error=String(error.message).slice(0,500);process.exitCode=1;}
finally{
 if(generation&&!exit){try{const body={kind:'parent_shutdown',version:1,nonce:randomUUID(),generation,parent_pid:process.pid};child.send({...body,signature:rpcSignature(body,key)});const start=Date.now();while(!reply||!exit){assert.ok(Date.now()-start<15000,'Owned runner closure deadline exceeded.');if(reply?.status==='busy')throw Error('Runner remains active; containment is unknown.');await delay(100);}assert.equal(reply.nonce,body.nonce);assert.equal(reply.status,'closed');assert.equal(reply.active,0);for(const field of ['browsers_closed','fixture_servers_closed','native_lock_released'])assert.equal(reply[field],true);assert.equal(exit.code,0);assert.equal(await closedPort(),true);report.closure_verified=true;if(report.status!=='failed')report.status='closed';}catch(error){report.status='failed';report.closure_verified=false;report.cleanup_error=String(error.message).slice(0,500);process.exitCode=1;}}
 else {report.status='failed';report.closure_verified=false;process.exitCode=1;if(!exit){try{report.unready_child_cleanup=await stopUnreadyOwnedChild(child,entry);report.runner_port_closed=await closedPort();}catch(error){report.cleanup_error=String(error.message).slice(0,500);}}}
 report.stdout_bytes=stdoutBytes;report.stderr_bytes=stderrBytes;report.finished_at=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,closure_verified:report.closure_verified,receipt:path.join(selected,'lifecycle.json')}));
}
