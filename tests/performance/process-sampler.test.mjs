import test from 'node:test';
import assert from 'node:assert/strict';
import {createProcessSampler} from './process-sampler.mjs';

// Real native read-only scalar processes only; no DB/browser/CIM benchmark targets.
const scalar=String.raw`
$global:taskIndependentScalarCount += 1
@{native_pid=$PID;ordinal=$global:taskIndependentScalarCount;marker=$env:FAULTLINE_SCALAR_MARKER} | ConvertTo-Json -Compress
`;
const failedClose=async(sampler,expected)=>{await assert.rejects(sampler.close(),cause=>cause.code===expected&&cause.child_exited===true);};

test('two matched scalar samples execute on one persistent native child; graceful close confirms exit',{timeout:45000},async()=>{
 const sampler=createProcessSampler(scalar,{FAULTLINE_SCALAR_MARKER:'independent-local-protocol'});
 try{const first=await sampler.sample(),second=await sampler.sample();assert.ok(Number.isInteger(first.native_pid)&&first.native_pid>0);assert.equal(second.native_pid,first.native_pid);assert.equal(first.ordinal,1);assert.equal(second.ordinal,2);assert.equal(first.marker,'independent-local-protocol');assert.equal(second.marker,first.marker);await sampler.close();await sampler.close();await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_CLOSED');}
 finally{await sampler.close();}
});
test('a second in-flight request is rejected rather than queued or spawning another observer',{timeout:45000},async()=>{
 const sampler=createProcessSampler('Start-Sleep -Milliseconds 100\n'+scalar,{FAULTLINE_SCALAR_MARKER:'one-in-flight'});
 try{const first=sampler.sample();await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_BUSY');assert.equal((await first).ordinal,1);assert.equal((await sampler.sample()).ordinal,2);}
 finally{await sampler.close();}
});
test('malformed script JSON produces no measurement; failure retains verified child exit',{timeout:45000},async()=>{
 const sampler=createProcessSampler("'{not-json}'");await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_JSON');await failedClose(sampler,'SAMPLER_JSON');
});
test('over-bound native output is rejected without an unbounded retained buffer or process kill',{timeout:45000},async()=>{
 const sampler=createProcessSampler("'x' * 1048577");await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_OUTPUT_BOUND');await failedClose(sampler,'SAMPLER_OUTPUT_BOUND');
});
test('forged stale protocol nonce is not accepted as a measurement',{timeout:45000},async()=>{
 const sampler=createProcessSampler(String.raw`[Console]::Out.WriteLine((@{version=1;kind='sample';nonce='00000000-0000-0000-0000-000000000000';pid=$PID;json='{"forged":true}'} | ConvertTo-Json -Compress))
'{"actual":true}'`);
 await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_PROTOCOL_NONCE');await failedClose(sampler,'SAMPLER_PROTOCOL_NONCE');
});
test('native child failure during sample cannot become a successful graceful shutdown',{timeout:45000},async()=>{
 const sampler=createProcessSampler('exit 7');await assert.rejects(sampler.sample(),cause=>cause.code==='SAMPLER_EXIT');await assert.rejects(sampler.close(),cause=>cause.code==='SAMPLER_EXIT'&&cause.child_exited===true&&cause.exit_code===7);
});
