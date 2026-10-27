import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalOutputAllowance,proposalReservationFailure} from './proposal-allowance.js';
import {DomainError} from '../errors.js';

test('unfunded schema repair preserves the primary numeric rejection without hiding unrelated reservation failures',()=>{
 const original=new DomainError('MODEL_NUMERIC_CLAIM_UNSUPPORTED','Model prose must be number-free.',422);
 for(const code of ['MODEL_BUDGET_EXHAUSTED','MODEL_REPAIR_EXHAUSTED']){const budget=new DomainError(code,'No further call is authorized.',429);assert.equal(proposalReservationFailure(budget,original),original);assert.equal(proposalReservationFailure(budget),budget);}
 const stale=new DomainError('STALE_INPUTS','Inputs changed.',409);assert.equal(proposalReservationFailure(stale,original),stale);
 const untrusted={code:'MODEL_BUDGET_EXHAUSTED'};assert.equal(proposalReservationFailure(untrusted,original),untrusted);
});

test('proposal output uses at most the per-call cap and remaining installation/policy budget',()=>{
 for(const [policy,reserved,spent,expected] of [[8000,0,0,4000],[8000,0,3370,4000],[8000,3000,3370,1630],[2500,0,0,2500],[2500,1000,1000,500],[9000,3000,0,4000],[9000,0,7000,2000],[8000,1000,7000,0],[8000,0,9000,0],[0,0,0,0],[64000,0,8000,4000],[64000,2000,61000,1000],[128000,0,63000,1000],[64000,0,64000,0]] as const){
  const actual=proposalOutputAllowance(policy,reserved,spent);assert.equal(actual,expected);assert.ok(actual>=0&&actual<=4000);assert.ok(actual<=Math.max(0,Math.min(64000,policy)-reserved-spent));
 }
});

test('invalid proposal budget values fail closed rather than reserving or refunding tokens',()=>{
 for(const invalid of [NaN,Infinity,-Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1,undefined,null,'8000'])for(const index of [0,1,2]){
  const values:any[]=[8000,0,0];values[index]=invalid;
  assert.throws(()=>proposalOutputAllowance(values[0],values[1],values[2]),{code:'MODEL_BUDGET_EXHAUSTED',status:429});
 }
});
