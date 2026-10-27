import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {type FaultlineBrowserPlan, type FaultlineObservation, type FaultlineVerificationResult} from '../../../contracts/src/generated.js';
import {DomainError} from '../errors.js';
import {hash} from '../canonical.js';
import {buildExploratoryPlan, projectExternalVerification} from './external-service.js';
import {request, verifyRequest, response, verifyResponse, rpcSignature, exactKeys, requireNativeFixtureMode} from './protocol.js';
import {listedVerificationResult} from './result-list-projection.js';
import {validateContract} from '../../../contracts/src/validate.js';

// external service
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const code=(wanted:string)=>(error:unknown)=>error instanceof DomainError&&error.code===wanted;

function plan(objective:'mechanism'|'correction'='mechanism'):FaultlineBrowserPlan{
 const names=objective==='mechanism'?['known_good','incident'] as const:['known_good','incident','candidate'] as const;
 return buildExploratoryPlan({workspace_id:'workspace-unit',case_id:'case-unit',revision_id:'revision-unit',hypothesis_id:'hypothesis-unit',objective,metric_hash:sha('metric'),snapshot_hash:sha('snapshot'),fixture_hash:sha('fixture'),environment_hash:sha('environment'),runner_id:'runner-unit',observation_profile_hash:sha('observation'),actions:[{op:'navigate',path:'/checkout'},{op:'click',locator:{kind:'test_id',value:'pay'}}],arms:names.map(name=>({arm:name,origin:`https://${name.replace('_','-')}.staging.example`,build_digest:sha('build-'+name),deployment_evidence_hash:sha('deployment-'+name)})) as FaultlineBrowserPlan['arms']});
}

function observations(value:FaultlineBrowserPlan,status:FaultlineObservation['status']='observed'){
 const result:FaultlineObservation[]=[];for(const arm of value.arms)for(const cohort of value.cohorts)for(let repeat=1;repeat<=value.repeats;repeat++)result.push({arm:arm.arm,cohort,repeat,status,plan_hash:hash(value),oracle_hash:value.oracle_hash,build_digest:arm.build_digest,build_digest_after:arm.build_digest,deployment_evidence_hash:arm.deployment_evidence_hash,fixture_hash:value.fixture_hash,environment_hash:value.environment_hash,runner_id:value.runner_id,actual:status==='observed'?{checkout_completed:true,order_created_count:1,error_code:null}:null});return result;
}

function runnerResult(value:FaultlineBrowserPlan,status:FaultlineObservation['status']='observed'){
 const obs=observations(value,status);return {version:1 as const,scope:'external_staging' as const,mode:'exploratory' as const,verification_limit_reason:'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED' as const,runner_id:value.runner_id,job_id:'job-unit',lease_id:'lease-unit',nonce:'nonce_external_unit_0001',plan_hash:hash(value),observation_profile_hash:value.observation_profile_hash!,network_profile_hash:sha('network'),started_at:'2026-10-17T10:00:00.000Z',finished_at:'2026-10-17T10:01:00.000Z',engine:{name:'chromium' as const,version:'141.0.0'},observations:obs,attempts:obs.map((observation,index)=>{const arm=value.arms.find(item=>item.arm===observation.arm)!;return {attempt_id:`attempt_external_${String(index+1).padStart(4,'0')}`,arm:observation.arm,cohort:observation.cohort,repeat:observation.repeat,status:observation.status,started_at:'2026-10-17T10:00:00.000Z',finished_at:'2026-10-17T10:01:00.000Z',observation_hash:hash(observation),ui_completed:status==='observed'?true:null,receipt_completed:status==='observed'?true:null,network_request_count:1,denied_requests:[],errors:[],deployment:{arm:arm.arm,deployment_id:`deployment-${arm.arm}`,attester_id:'attester-unit',origin:arm.origin,build_digest:arm.build_digest,deployment_evidence_hash:arm.deployment_evidence_hash}};})};
}

test('external plans retain the protected oracle, exploratory limit, canonical matrix and exact HTTPS hosts',()=>{
 const mechanism=plan();assert.equal(mechanism.mode,'exploratory');assert.deepEqual(mechanism.arms.map(item=>item.arm),['known_good','incident']);assert.equal(mechanism.policy_version,'checkout_mechanism_v1');assert.match(mechanism.oracle_hash,/^[a-f0-9]{64}$/);
 const correction=plan('correction');assert.deepEqual(correction.arms.map(item=>item.arm),['known_good','incident','candidate']);assert.equal(correction.policy_version,'checkout_completion_v1');
 const base={workspace_id:'workspace-unit',case_id:'case-unit',revision_id:'revision-unit',hypothesis_id:'hypothesis-unit',objective:'mechanism' as const,metric_hash:sha('metric'),snapshot_hash:sha('snapshot'),fixture_hash:sha('fixture'),environment_hash:sha('environment'),runner_id:'runner-unit',observation_profile_hash:sha('observation'),actions:[{op:'navigate' as const,path:'/'}] as FaultlineBrowserPlan['actions']};
 assert.throws(()=>buildExploratoryPlan({...base,arms:[{...mechanism.arms[0]!,origin:'http://known-good.example'},{...mechanism.arms[1]!}]}),code('EXTERNAL_ORIGIN_INVALID'));
 assert.throws(()=>buildExploratoryPlan({...base,arms:[mechanism.arms[1]!,mechanism.arms[0]!]}),code('INVALID_MATRIX'));
 assert.throws(()=>buildExploratoryPlan({...base,arms:[mechanism.arms[0]!,{...mechanism.arms[1]!,origin:'https://known-good.staging.example:444'}]}),code('INVALID_MATRIX'));
});

test("external results remain exploratory and reject incomplete or mismatched receipts", () => {
 // complete hardened-runner observations remain exploratory and cannot pass or promote mechanism/correction
 {
  for(const objective of ['mechanism','correction'] as const){const value=plan(objective),result=projectExternalVerification(value,runnerResult(value));assert.equal(result.outcome,'inconclusive');assert.equal(result.production_claim_eligible,false);assert.equal(result.mode,'exploratory');assert.equal(result.association,'not_established');assert.equal(result.mechanism,'inconclusive');assert.equal(result.correction,objective==='mechanism'?'not_tested':'inconclusive');assert.deepEqual(result.attribution,{scope:'association_only',causal_effect:'not_established'});assert.deepEqual(result.reasons,['INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED']);}
 }
 // blocked and cancelled attempts stay visibly nonpassing
 {
  const value=plan(),blocked=projectExternalVerification(value,runnerResult(value,'blocked')),cancelled=projectExternalVerification(value,runnerResult(value,'cancelled'));
    assert.equal(blocked.outcome,'blocked');assert.ok(blocked.reasons.includes('REQUIRED_ATTEMPT_UNAVAILABLE'));assert.equal(cancelled.outcome,'cancelled');assert.ok(cancelled.reasons.includes('REQUIRED_ATTEMPT_CANCELLED'));assert.equal(blocked.production_claim_eligible,false);assert.equal(cancelled.production_claim_eligible,false);
 }
 // outer receipt, observation deployment and complete-cell mismatches fail closed
 {
  const value=plan(),outer=runnerResult(value);assert.throws(()=>projectExternalVerification(value,{...outer,plan_hash:sha('another-plan')}),code('RUNNER_RESULT_BINDING_MISMATCH'));
    const changed=runnerResult(value);changed.observations[0]={...changed.observations[0]!,build_digest:sha('changed-build')};assert.throws(()=>projectExternalVerification(value,changed),code('RUNNER_RESULT_BINDING_MISMATCH'));
    const duplicate=runnerResult(value);duplicate.observations[1]={...duplicate.observations[0]!};assert.throws(()=>projectExternalVerification(value,duplicate),code('RUNNER_RESULT_BINDING_MISMATCH'));
    const incomplete=runnerResult(value);incomplete.observations.pop();incomplete.attempts.pop();assert.throws(()=>projectExternalVerification(value,incomplete),code('RUNNER_RESULT_INCOMPLETE'));
    const mismatchedAttempt=runnerResult(value);mismatchedAttempt.attempts[0]={...mismatchedAttempt.attempts[0]!,observation_hash:sha('wrong-observation')};assert.throws(()=>projectExternalVerification(value,mismatchedAttempt),code('RUNNER_RESULT_BINDING_MISMATCH'));
 }
});

// protocol
test('signed finite fixture RPC binds path, payload, nonce, expiry and production refusal',()=>{
 const key=randomBytes(32),value=request('/v1/prepare',{objective:'mechanism'},key);
 assert.doesNotThrow(()=>verifyRequest('/v1/prepare',value,key));
 assert.throws(()=>verifyRequest('/v1/execute',value,key),/unauthenticated/);
 assert.throws(()=>verifyRequest('/v1/prepare',{...value,payload:{objective:'correction'}},key),/unauthenticated/);
 const body={version:1 as const,nonce:value.nonce,expires_at:'2000-01-01T00:00:00.000Z',payload:value.payload};
 assert.throws(()=>verifyRequest('/v1/prepare',{...body,signature:rpcSignature({method:'POST',path:'/v1/prepare',...body},key)},key),/Expired/);
 const reply=response(value.nonce,{scope:'trusted_fixture'},null,key);assert.doesNotThrow(()=>verifyResponse(reply,value.nonce,key));
 assert.throws(()=>verifyResponse(reply,'another-task',key),/Malformed/);
 assert.throws(()=>verifyResponse({...reply,payload:{scope:'external'}},value.nonce,key),/unauthenticated/);
 assert.throws(()=>exactKeys({objective:'mechanism',javascript:'fetch(...)'},['objective']),/finite fields/);
 const before={node:process.env.NODE_ENV,mode:process.env.RUNNER_MODE,enabled:process.env.ALLOW_FIXTURE_ADAPTERS};
 try{process.env.NODE_ENV='production';process.env.RUNNER_MODE='trusted_fixture';process.env.ALLOW_FIXTURE_ADAPTERS='true';assert.throws(()=>requireNativeFixtureMode(),/unavailable in production/);process.env.NODE_ENV='development';assert.doesNotThrow(()=>requireNativeFixtureMode());process.env.RUNNER_MODE='external';assert.throws(()=>requireNativeFixtureMode(),/Explicitly configure/);}finally{for(const [key,value]of Object.entries({NODE_ENV:before.node,RUNNER_MODE:before.mode,ALLOW_FIXTURE_ADAPTERS:before.enabled})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

// result list projection
const result:FaultlineVerificationResult={outcome:'passed',association:'observed',mechanism:'reproduced',correction:'validated',freshness:'fresh',attribution:{scope:'association_only',causal_effect:'not_established'},reasons:[],expected_runs:18,observed_runs:18,plan_hash:'a'.repeat(64),mode:'trusted_fixture',production_claim_eligible:false,workspace_id:'w',case_id:'c',revision_id:'r',hypothesis_id:'h',metric_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64)};
test("result lists preserve stored verdicts while withdrawing stale claims", () => {
 // historical validated correction projects current stale truth without rewriting the stored verdict
 {
  const stored=structuredClone(result),before=JSON.stringify(stored),current=listedVerificationResult(stored,'stale');
    assert.equal(JSON.stringify(stored),before); assert.equal(stored.correction,'validated'); assert.equal(stored.freshness,'fresh');
    assert.equal(current.correction,'inconclusive');assert.equal(current.freshness,'stale');assert.equal(current.production_claim_eligible,false);assert.ok(current.reasons.includes('stale_inputs'));
    assert.equal(current.outcome,'passed');assert.equal(current.mechanism,'reproduced');assert.equal(current.observed_runs,18);assert.equal(current.attribution.causal_effect,'not_established');
    assert.deepEqual(validateContract('verification-result',JSON.parse(JSON.stringify(current))),current);
 }
 // current fresh result preserves all canonical business axes and excludes row-level private fields
 {
  assert.deepEqual(listedVerificationResult(result,'fresh'),result);
    assert.throws(()=>listedVerificationResult({...result,receipt:{private:'secret'}} as never,'fresh'));
 }
 // stale failed or blocked results never become passing results
 {
  for(const outcome of ['failed','blocked','inconclusive','not_run','cancelled'] as const){const stored={...result,outcome,mechanism:'inconclusive' as const,correction:'not_tested' as const,observed_runs:0,reasons:['missing_observation']};const projected=listedVerificationResult(stored,'stale');assert.equal(projected.outcome,outcome);assert.equal(projected.observed_runs,0);assert.equal(projected.mechanism,'inconclusive');assert.equal(projected.correction,'not_tested');assert.deepEqual(projected.reasons,['stale_inputs','missing_observation']);}
 }
 // stale production eligibility is withdrawn and reason projection stays within the canonical bound
 {
  const staging={...result,mode:'verified_staging' as const,production_claim_eligible:true};assert.equal(listedVerificationResult(staging,'stale').production_claim_eligible,false);
    const full={...result,correction:'not_tested' as const,reasons:Array.from({length:30},(_,i)=>'historical_'+i)},projected=listedVerificationResult(full,'stale');
    assert.equal(projected.reasons.length,30);assert.equal(projected.reasons[0],'stale_inputs');assert.equal(full.reasons.length,30);assert.equal(full.reasons[29],'historical_29');
 }
});
