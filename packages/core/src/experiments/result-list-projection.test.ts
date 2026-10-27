import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {FaultlineVerificationResult} from '../../../contracts/src/generated.js';
import {listedVerificationResult} from './result-list-projection.js';
import {validateContract} from '../../../contracts/src/validate.js';
const result:FaultlineVerificationResult={outcome:'passed',association:'observed',mechanism:'reproduced',correction:'validated',freshness:'fresh',attribution:{scope:'association_only',causal_effect:'not_established'},reasons:[],expected_runs:18,observed_runs:18,plan_hash:'a'.repeat(64),mode:'trusted_fixture',production_claim_eligible:false,workspace_id:'w',case_id:'c',revision_id:'r',hypothesis_id:'h',metric_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64)};
test('historical validated correction projects current stale truth without rewriting the stored verdict',()=>{
 const stored=structuredClone(result),before=JSON.stringify(stored),current=listedVerificationResult(stored,'stale');
 assert.equal(JSON.stringify(stored),before); assert.equal(stored.correction,'validated'); assert.equal(stored.freshness,'fresh');
 assert.equal(current.correction,'inconclusive');assert.equal(current.freshness,'stale');assert.equal(current.production_claim_eligible,false);assert.ok(current.reasons.includes('stale_inputs'));
 assert.equal(current.outcome,'passed');assert.equal(current.mechanism,'reproduced');assert.equal(current.observed_runs,18);assert.equal(current.attribution.causal_effect,'not_established');
 assert.deepEqual(validateContract('verification-result',JSON.parse(JSON.stringify(current))),current);
});
test('current fresh result preserves all canonical business axes and excludes row-level private fields',()=>{
 assert.deepEqual(listedVerificationResult(result,'fresh'),result);
 assert.throws(()=>listedVerificationResult({...result,receipt:{private:'secret'}} as never,'fresh'));
});
test('stale failed or blocked results never become passing results',()=>{
 for(const outcome of ['failed','blocked','inconclusive','not_run','cancelled'] as const){const stored={...result,outcome,mechanism:'inconclusive' as const,correction:'not_tested' as const,observed_runs:0,reasons:['missing_observation']};const projected=listedVerificationResult(stored,'stale');assert.equal(projected.outcome,outcome);assert.equal(projected.observed_runs,0);assert.equal(projected.mechanism,'inconclusive');assert.equal(projected.correction,'not_tested');assert.deepEqual(projected.reasons,['stale_inputs','missing_observation']);}
});
test('stale production eligibility is withdrawn and reason projection stays within the canonical bound',()=>{
 const staging={...result,mode:'verified_staging' as const,production_claim_eligible:true};assert.equal(listedVerificationResult(staging,'stale').production_claim_eligible,false);
 const full={...result,correction:'not_tested' as const,reasons:Array.from({length:30},(_,i)=>'historical_'+i)},projected=listedVerificationResult(full,'stale');
 assert.equal(projected.reasons.length,30);assert.equal(projected.reasons[0],'stale_inputs');assert.equal(full.reasons.length,30);assert.equal(full.reasons[29],'historical_29');
});
