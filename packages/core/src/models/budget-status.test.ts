import test from 'node:test';
import assert from 'node:assert/strict';
import {modelBudgetStatus,modelBudgetStatusTx,modelRequestReadiness,requireModelBudget} from './budget-status.js';
import {modelRevisionLimits} from './limits.js';
import type {Tx} from '../../../database/src/client.js';
const policy={max_automatic_model_calls:4,max_input_tokens:40000,max_output_tokens:8000};
test('AI budget preflight accounts for spent and reserved work without resetting usage',()=>{
 const status=modelBudgetStatus(policy,{calls_spent:3,input_spent:'36321',output_spent:'7904'},4);
 assert.deepEqual(status,{remaining_calls:1,remaining_input:3679,remaining_output:96,can_request:false,reason_code:'MODEL_BUDGET_EXHAUSTED'});
 assert.throws(()=>requireModelBudget(status,100),{code:'MODEL_BUDGET_EXHAUSTED'});
 const allowed=modelBudgetStatus(policy,{calls_reserved:1,input_reserved:500,output_reserved:1000},4);requireModelBudget(allowed,39500);assert.throws(()=>requireModelBudget(allowed,39501),{code:'MODEL_BUDGET_EXHAUSTED'});
});
test('AI limits fail closed and preserve installation ceilings even with owner-granted calls',()=>{
 const allowed=modelBudgetStatus({...policy,max_input_tokens:1000000,max_output_tokens:128000},{},8);assert.equal(allowed.remaining_input,500000);assert.equal(allowed.remaining_output,64000);assert.equal(allowed.remaining_calls,8);
 assert.equal(modelBudgetStatus(policy,{output_spent:NaN},4).can_request,false);assert.equal(modelBudgetStatus({...policy,max_automatic_model_calls:0},{},8).can_request,false);
 assert.equal(modelBudgetStatus(policy,{output_spent:6976},4).can_request,true);assert.equal(modelBudgetStatus(policy,{output_spent:6977},4).can_request,false);
 assert.throws(()=>requireModelBudget(allowed,-1),{code:'MODEL_BUDGET_EXHAUSTED'});
});

const expanded={max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000};

test('configured headroom resumes existing spent work without resetting it or relaxing a lower workspace policy',()=>{
 const usage={calls_spent:3,calls_reserved:1,input_spent:'31000',input_reserved:'12000',output_spent:'3000',output_reserved:'4000'},before=JSON.stringify(usage);
 assert.deepEqual(modelRevisionLimits(expanded),{automatic_calls:24,input:500000,output:64000,owner_calls:4});
 const status=modelBudgetStatus(expanded,usage,24);assert.deepEqual(status,{remaining_calls:20,remaining_input:457000,remaining_output:57000,can_request:true,reason_code:null});
 requireModelBudget(status,12000);assert.equal(modelRequestReadiness(status,457000).can_request,true);assert.equal(modelRequestReadiness(status,457001).can_request,false);
 assert.equal(JSON.stringify(usage),before);
 const lower=modelBudgetStatus(policy,usage,4);assert.equal(lower.can_request,false);assert.equal(lower.remaining_calls,0);assert.equal(lower.remaining_input,0);assert.equal(lower.remaining_output,1000);
});

test('readiness and reservation gates share exact configured exhaustion boundaries including owner calls',()=>{
 for(const usage of [{calls_spent:24},{calls_spent:25},{input_spent:500000},{input_spent:500001},{output_spent:64000},{output_spent:64001},{output_spent:62977}]){
  const status=modelBudgetStatus(expanded,usage,24);assert.equal(status.can_request,false);assert.throws(()=>requireModelBudget(status,1),{code:'MODEL_BUDGET_EXHAUSTED',status:429});
 }
 const exact=modelBudgetStatus(expanded,{calls_spent:23,input_spent:499999,output_spent:62976},24);
 assert.equal(exact.can_request,true);requireModelBudget(exact,1);assert.throws(()=>requireModelBudget(exact,2),{code:'MODEL_BUDGET_EXHAUSTED'});
 const grant=modelBudgetStatus(expanded,{calls_spent:24},28);assert.equal(grant.remaining_calls,4);requireModelBudget(grant,1);
 assert.equal(modelBudgetStatus(expanded,{},29).can_request,false);
 assert.equal(modelBudgetStatus({...expanded,max_automatic_model_calls:0},{},4).can_request,false);
 for(const key of ['max_input_tokens','max_output_tokens'] as const)assert.equal(modelBudgetStatus({...expanded,[key]:0},{},24).can_request,false);
});

test('malformed limits, totals and recorded usage fail closed without treating invalid metadata as a refund',()=>{
 for(const invalid of [undefined,null,[],false,'invalid']){assert.equal(modelBudgetStatus(invalid as any,{},24).can_request,false);assert.equal(modelBudgetStatus(expanded,invalid as any,24).can_request,false);}
 for(const invalid of [NaN,Infinity,-Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1,undefined,null,'24',true,false]){
  for(const field of ['max_automatic_model_calls','max_input_tokens','max_output_tokens'] as const)assert.equal(modelBudgetStatus({...expanded,[field]:invalid} as any,{},24).can_request,false);
  assert.equal(modelBudgetStatus(expanded,{},invalid as any).can_request,false);
  for(const field of ['calls_spent','calls_reserved','input_spent','input_reserved','output_spent','output_reserved']){
   const value=invalid==='24'?'24.5':invalid,status=modelBudgetStatus(expanded,{[field]:value},24);assert.equal(status.can_request,false,field+': '+String(value));assert.throws(()=>requireModelBudget(status,1),{code:'MODEL_BUDGET_EXHAUSTED'});
  }
 }
});

test('database readiness uses the configured automatic ceiling and retained owner grants with existing accounting',async()=>{
 const usage={calls_spent:3,calls_reserved:0,input_spent:'31000',input_reserved:'0',output_spent:'3000',output_reserved:'0'},before=JSON.stringify(usage),writes:string[]=[];
 const tx={query:async(text:string)=>{
  if(text.startsWith('INSERT INTO faultline.workspace_policies')){writes.push(text);return {rows:[],rowCount:0};}
  if(text.startsWith('SELECT * FROM faultline.workspace_policies'))return {rows:[{value:expanded}],rowCount:1};
  if(text.includes('sum(additional_calls)'))return {rows:[{granted:'4'}],rowCount:1};
  if(text.startsWith('SELECT calls_spent,calls_reserved'))return {rows:[usage],rowCount:1};
  throw new Error('Unexpected fixture query');
 }} as unknown as Tx;
 const status=await modelBudgetStatusTx(tx,'workspace','case','revision');assert.equal(status.remaining_calls,25);assert.equal(status.remaining_input,469000);assert.equal(status.remaining_output,61000);requireModelBudget(status,12000);
 assert.equal(JSON.stringify(usage),before);assert.equal(writes.length,1,'Policy insert is conflict-safe; no model accounting is reset or updated.');
});
