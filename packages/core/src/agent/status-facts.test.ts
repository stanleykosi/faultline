import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticCheckFacts,explanationStateFacts} from './status-facts.js';

test('saved explanation state is independent of check outcomes and never promoted by a completed job',()=>{
 const explanation=Object.freeze({id:'explanation-current',status:'proposed'}),states=explanationStateFacts([explanation]);
 for(const outcome of ['passed','failed','blocked','inconclusive','cancelled','not_run','unknown']){
  const value=Object.freeze({hypothesis_id:explanation.id,kind:'cohort_change',outcome,result_hash:'a'.repeat(64)}),check=analyticCheckFacts({id:'check-current',plan_id:'plan-current',value});
  assert.equal(check.hypothesis_id,explanation.id);assert.equal(check.outcome,outcome);assert.equal(check.test_type,'cohort_change');assert.equal(check.freshness,'fresh');
  assert.deepEqual(states,[{id:explanation.id,state:'proposed'}]);assert.equal(explanation.status,'proposed');assert.equal(value.outcome,outcome);
 }
 const missing=analyticCheckFacts({id:'check-missing-outcome',value:{status:'succeeded'}});
 assert.equal(missing.outcome,'unknown');assert.equal(missing.test_type,null);assert.equal(missing.hypothesis_id,null);
 assert.deepEqual(explanationStateFacts([{id:'unreviewed',status:'passed'},{id:'missing'}]),[{id:'unreviewed',state:'unknown'},{id:'missing',state:'unknown'}]);
});
