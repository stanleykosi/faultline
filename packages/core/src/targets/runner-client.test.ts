import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac} from 'node:crypto';
import {canonical} from '../canonical.js';
import {cancelRunnerTask,requestRunnerProbe,requestRunnerTask,requestRunnerTaskStatus} from './runner-client.js';

const digest=(c:string)=>c.repeat(64),key=Buffer.alloc(32,7),keyB64=key.toString('base64'),clock=Date.parse('2026-10-17T10:00:00.000Z');
const profile={endpoint:'https://runner.example.test',implementation_digest:digest('a'),transport_ca_sha256:digest('b'),peer_certificate_sha256:digest('c')};
const binding={profile_hash:digest('d'),network_hash:digest('e')};
const executionBinding={adapter_id:'generic-vm-adapter',adapter_version:'1.0.0',provider_id:'example-cloud',provider_version:'2026-10',provider_configuration_hash:digest('f'),isolation_configuration_hash:digest('1'),execution_program_sha256:digest('0')};
const environment={RUNNER_MODE:'external',EXTERNAL_RUNNER_URL:profile.endpoint,EXTERNAL_RUNNER_AUTH_KEY_B64:keyB64};
const nonce='00000000-0000-4000-8000-000000000001';
const sign=(value:unknown)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

function evidence(boot:string,network:string){
 return {version:1,kind:'hardened_isolation_probe',private_network_denied:true,firewall_default_deny:true,approved_https:true,unrelated_public_denied:true,loopback_denied:true,metadata_denied:true,private_address_denied:true,privilege_dropped:true,before:{boot_id:boot,network_ns:network,docker_socket_present:false,control_plane_credential_present:false}};
}
function probePayload(){
 const first=evidence('boot-one','net-one'),second=evidence('boot-two','net-two');
 return {version:1,status:'available',checked_at:'2026-10-17T10:00:01.000Z',adapter_id:'generic-vm-adapter',adapter_version:'1.0.0',provider_id:'example-cloud',provider_version:'2026-10',provider_configuration_hash:digest('f'),implementation_digest:profile.implementation_digest,isolation_configuration_hash:digest('1'),capability_program_sha256:digest('f'),execution_program_sha256:digest('0'),cleanup_verification:true,crash_reconciliation:true,network_calls:2,runs:[{execution_id:'execution-one',result_sha256:hash(first),evidence:first},{execution_id:'execution-two',result_sha256:hash(second),evidence:second}]};
}
function response(request:any,payload:unknown,change:(body:any)=>void=()=>{}){
 const body:any={version:1,nonce:request.nonce,at:'2026-10-17T10:00:02.000Z',ok:true,payload,error_code:null};change(body);
 return {status:200,body:JSON.stringify({...body,signature:sign(body)}),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256};
}
function dependencies(path:string,payload:()=>unknown,change:(body:any)=>void=()=>{}){
 return {now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{const request=JSON.parse(input.body);assert.equal(input.url.pathname,path);assert.equal(request.signature,sign({method:'POST',path,version:request.version,nonce:request.nonce,expires_at:request.expires_at,payload:request.payload}));return response(request,payload(),change);}};
}

test('accepts provider-neutral capability evidence from two distinct executions',async()=>{
 const value=await requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload));
 assert.equal(value.status,'available');assert.equal(value.adapter_id,'generic-vm-adapter');assert.equal(value.runs.length,2);
});

test('rejects provider-specific legacy capability payloads and evidence',async()=>{
 const legacy:any=probePayload();delete legacy.adapter_id;delete legacy.provider_id;delete legacy.execution_program_sha256;legacy.checkpoint_name='railway-checkpoint';legacy.runs[0].sandbox_id=legacy.runs[0].execution_id;delete legacy.runs[0].execution_id;
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>legacy)),/unexpected fields/i);
 const wrong=probePayload();wrong.runs[0]!.evidence.kind='railway_isolation_probe';
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>wrong)),/evidence is incomplete/i);
});

test('rejects incomplete or non-distinct isolation evidence',async()=>{
 const payload=probePayload();payload.runs[1]!.evidence.before.boot_id='boot-one';payload.runs[1]!.result_sha256=hash(payload.runs[1]!.evidence);
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>payload)),/not independent/i);
 const credential=probePayload();credential.runs[0]!.evidence.before.control_plane_credential_present=true;
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>credential)),/evidence is incomplete/i);
});

test('sends a canonical task with a digest and task-route-bound signature',async()=>{
 const task={z:2,a:{second:true,first:'value'}},result={steps:3,status:'passed'};
 const receipt=await requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{
  const request=JSON.parse(input.body),taskRoute={method:'POST',path:'/v1/tasks/execute',version:1,nonce:request.nonce,expires_at:request.expires_at,payload:request.payload},probeRoute={...taskRoute,path:'/v1/probe'};
  assert.equal(input.url.pathname,'/v1/tasks/execute');assert.equal(JSON.stringify(request.payload.task),canonical(task));assert.equal(request.payload.task_sha256,hash(task));
  assert.equal(request.signature,sign(taskRoute));assert.notEqual(request.signature,sign(probeRoute));
  return response(request,{version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,isolation_configuration_hash:executionBinding.isolation_configuration_hash,implementation_digest:profile.implementation_digest,execution_id:'execution-task-one',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result});
 }});
 assert.deepEqual(receipt.result,result);
});

test('snapshots the task before transport and rejects task or result digest mismatches',async()=>{
 const task={value:'original'},result={status:'passed'};
 const receipt=(request:any,overrides:Record<string,unknown>={})=>({version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,isolation_configuration_hash:executionBinding.isolation_configuration_hash,implementation_digest:profile.implementation_digest,execution_id:'execution',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result,...overrides});
 const pending=requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{await Promise.resolve();const request=JSON.parse(input.body);assert.equal(request.payload.task.value,'original');return response(request,receipt(request));}});
 task.value='mutated';await pending;
 await assert.rejects(()=>requestRunnerTask(profile,{value:'original'},executionBinding,new AbortController().signal,dependencies('/v1/tasks/execute',()=>receipt({payload:{task_sha256:hash({value:'original'})}},{task_sha256:digest('7')}))),/did not bind/i);
 await assert.rejects(()=>requestRunnerTask(profile,{value:'original'},executionBinding,new AbortController().signal,dependencies('/v1/tasks/execute',()=>receipt({payload:{task_sha256:hash({value:'original'})}},{result_sha256:digest('6')}))),/result digest/i);
});

test('validates a long task response against receive time rather than request start',async()=>{
 const task={value:'long-running'},result={status:'passed'},times=[clock,clock+70_000];
 const receipt=await requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>times.shift()??clock+70_000,nonce:()=>nonce,environment,transport:async(input:any)=>{
  const request=JSON.parse(input.body),body:any={version:1,nonce:request.nonce,at:new Date(clock+70_000).toISOString(),ok:true,payload:{version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,implementation_digest:profile.implementation_digest,isolation_configuration_hash:executionBinding.isolation_configuration_hash,execution_id:'execution-long',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result},error_code:null};
  return {status:200,body:JSON.stringify({...body,signature:sign(body)}),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256};
 }});
 assert.equal(receipt.execution_id,'execution-long');
});

test('status and cancellation bind the same execution, task and provider capability',async()=>{
 const command={execution_key:'task_nonce_external_0001',task_sha256:digest('8')};
 const state=(status:'running'|'cancelled')=>({version:1,status,adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,implementation_digest:profile.implementation_digest,isolation_configuration_hash:executionBinding.isolation_configuration_hash,execution_key:command.execution_key,task_sha256:command.task_sha256,updated_at:'2026-10-17T10:00:01.000Z'});
 assert.equal((await requestRunnerTaskStatus(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/status',()=>state('running')))).status,'running');
 assert.equal((await cancelRunnerTask(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/cancel',()=>state('cancelled')))).status,'cancelled');
 await assert.rejects(()=>requestRunnerTaskStatus(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/status',()=>({...state('running'),task_sha256:digest('9')}))),/did not bind/i);
});

test('rejects replayed or stale authenticated response envelopes',async()=>{
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload,body=>{body.nonce='00000000-0000-4000-8000-000000000099';})),/authentication|freshness/i);
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload,body=>{body.at='2026-10-17T09:58:59.000Z';})),/authentication|freshness/i);
});

test('rejects oversized responses before parsing and mismatched TLS identities',async()=>{
 const request=()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async()=>({status:200,body:'x'.repeat(1024*1024+1),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256})});
 await assert.rejects(request,/finite bound/i);
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>({...response(JSON.parse(input.body),probePayload()),leafSha256:digest('4')})}),/TLS identity/i);
});

test('rejects duplicate response keys and a configured endpoint mismatch',async()=>{
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async()=>({status:200,body:'{"version":1,"version":1}',leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256})}),/duplicate/i);
 await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{environment:{...environment,EXTERNAL_RUNNER_URL:'https://other.example.test'},transport:async()=>{throw new Error('called');}}),/not the configured external runner/i);
});
