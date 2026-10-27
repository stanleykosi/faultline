import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelBudgetStatus, modelBudgetStatusTx, modelRequestReadiness, requireModelBudget} from './budget-status.js';
import {modelRevisionLimits} from './limits.js';
import {type Tx} from '../../../database/src/client.js';
import {createExecutionGuard} from './execution-guard.js';
import {proposalOutputAllowance, proposalReservationFailure} from './proposal-allowance.js';
import {DomainError} from '../errors.js';
import {callAllowance, extensionInput, requireExtensionCapacity} from '../budgets/allowance.js';

// budget status
const policy={max_automatic_model_calls:4,max_input_tokens:40000,max_output_tokens:8000};
test("model preflight accounts for spent and reserved tokens within installation ceilings", () => {
 // AI budget preflight accounts for spent and reserved work without resetting usage
 {
  const status=modelBudgetStatus(policy,{calls_spent:3,input_spent:'36321',output_spent:'7904'},4);
    assert.deepEqual(status,{remaining_calls:1,remaining_input:3679,remaining_output:96,can_request:false,reason_code:'MODEL_BUDGET_EXHAUSTED'});
    assert.throws(()=>requireModelBudget(status,100),{code:'MODEL_BUDGET_EXHAUSTED'});
    const allowed=modelBudgetStatus(policy,{calls_reserved:1,input_reserved:500,output_reserved:1000},4);requireModelBudget(allowed,39500);assert.throws(()=>requireModelBudget(allowed,39501),{code:'MODEL_BUDGET_EXHAUSTED'});
 }
 // AI limits fail closed and preserve installation ceilings even with owner-granted calls
 {
  const allowed=modelBudgetStatus({...policy,max_input_tokens:1000000,max_output_tokens:128000},{},8);assert.equal(allowed.remaining_input,500000);assert.equal(allowed.remaining_output,64000);assert.equal(allowed.remaining_calls,8);
    assert.equal(modelBudgetStatus(policy,{output_spent:NaN},4).can_request,false);assert.equal(modelBudgetStatus({...policy,max_automatic_model_calls:0},{},8).can_request,false);
    assert.equal(modelBudgetStatus(policy,{output_spent:6976},4).can_request,true);assert.equal(modelBudgetStatus(policy,{output_spent:6977},4).can_request,false);
    assert.throws(()=>requireModelBudget(allowed,-1),{code:'MODEL_BUDGET_EXHAUSTED'});
 }
});

const expanded={max_automatic_model_calls:24,max_input_tokens:500000,max_output_tokens:64000};

test("configured budget changes preserve usage and reject invalid or exhausted policy", () => {
 // configured headroom resumes existing spent work without resetting it or relaxing a lower workspace policy
 {
  const usage={calls_spent:3,calls_reserved:1,input_spent:'31000',input_reserved:'12000',output_spent:'3000',output_reserved:'4000'},before=JSON.stringify(usage);
    assert.deepEqual(modelRevisionLimits(expanded),{automatic_calls:24,input:500000,output:64000,owner_calls:4});
    const status=modelBudgetStatus(expanded,usage,24);assert.deepEqual(status,{remaining_calls:20,remaining_input:457000,remaining_output:57000,can_request:true,reason_code:null});
    requireModelBudget(status,12000);assert.equal(modelRequestReadiness(status,457000).can_request,true);assert.equal(modelRequestReadiness(status,457001).can_request,false);
    assert.equal(JSON.stringify(usage),before);
    const lower=modelBudgetStatus(policy,usage,4);assert.equal(lower.can_request,false);assert.equal(lower.remaining_calls,0);assert.equal(lower.remaining_input,0);assert.equal(lower.remaining_output,1000);
 }
 // readiness and reservation gates share exact configured exhaustion boundaries including owner calls
 {
  for(const usage of [{calls_spent:24},{calls_spent:25},{input_spent:500000},{input_spent:500001},{output_spent:64000},{output_spent:64001},{output_spent:62977}]){
     const status=modelBudgetStatus(expanded,usage,24);assert.equal(status.can_request,false);assert.throws(()=>requireModelBudget(status,1),{code:'MODEL_BUDGET_EXHAUSTED',status:429});
    }
    const exact=modelBudgetStatus(expanded,{calls_spent:23,input_spent:499999,output_spent:62976},24);
    assert.equal(exact.can_request,true);requireModelBudget(exact,1);assert.throws(()=>requireModelBudget(exact,2),{code:'MODEL_BUDGET_EXHAUSTED'});
    const grant=modelBudgetStatus(expanded,{calls_spent:24},28);assert.equal(grant.remaining_calls,4);requireModelBudget(grant,1);
    assert.equal(modelBudgetStatus(expanded,{},29).can_request,false);
    assert.equal(modelBudgetStatus({...expanded,max_automatic_model_calls:0},{},4).can_request,false);
    for(const key of ['max_input_tokens','max_output_tokens'] as const)assert.equal(modelBudgetStatus({...expanded,[key]:0},{},24).can_request,false);
 }
 // malformed limits, totals and recorded usage fail closed without treating invalid metadata as a refund
 {
  for(const invalid of [undefined,null,[],false,'invalid']){assert.equal(modelBudgetStatus(invalid as any,{},24).can_request,false);assert.equal(modelBudgetStatus(expanded,invalid as any,24).can_request,false);}
    for(const invalid of [NaN,Infinity,-Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1,undefined,null,'24',true,false]){
     for(const field of ['max_automatic_model_calls','max_input_tokens','max_output_tokens'] as const)assert.equal(modelBudgetStatus({...expanded,[field]:invalid} as any,{},24).can_request,false);
     assert.equal(modelBudgetStatus(expanded,{},invalid as any).can_request,false);
     for(const field of ['calls_spent','calls_reserved','input_spent','input_reserved','output_spent','output_reserved']){
      const value=invalid==='24'?'24.5':invalid,status=modelBudgetStatus(expanded,{[field]:value},24);assert.equal(status.can_request,false,field+': '+String(value));assert.throws(()=>requireModelBudget(status,1),{code:'MODEL_BUDGET_EXHAUSTED'});
     }
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

// execution guard
test("execution guards serialize authority checks and retain the first failure", async () => {
 // slow full authority checks are shared without overlap and publication drains the check
 {
  let release!:()=>void,calls=0;const guard=createExecutionGuard(async()=>{calls++;await new Promise<void>(r=>release=r);},()=>assert.fail('unexpected failure'));
    const first=guard.check();guard.poll();guard.poll();assert.equal(guard.check(),first);await Promise.resolve();assert.equal(calls,1);
    let drained=false;const stopping=guard.stop().then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);release();await first;await stopping;assert.equal(drained,true);guard.poll();assert.equal(calls,1);
    const next=guard.check();await Promise.resolve();assert.equal(calls,2,'An explicit later check must not reuse completed authority');release();await next;
 }
 // monitor retains the first actual failure and never reports a new failure after stop
 {
  const reason=Object.assign(new Error('stale'),{code:'STALE_INPUTS'}),failures:unknown[]=[];let reject!:(value:unknown)=>void;
    const guard=createExecutionGuard(()=>new Promise<void>((_,r)=>reject=r),e=>failures.push(e));guard.poll();guard.poll();await Promise.resolve();reject(reason);await new Promise(r=>setImmediate(r));assert.deepEqual(failures,[reason]);await guard.stop();guard.poll();assert.deepEqual(failures,[reason]);
 }
});

// proposal allowance
test("proposal allowances cap output and preserve primary failures when repair is unfunded", () => {
 // unfunded schema repair preserves the primary numeric rejection without hiding unrelated reservation failures
 {
  const original=new DomainError('MODEL_NUMERIC_CLAIM_UNSUPPORTED','Model prose must be number-free.',422);
    for(const code of ['MODEL_BUDGET_EXHAUSTED','MODEL_REPAIR_EXHAUSTED']){const budget=new DomainError(code,'No further call is authorized.',429);assert.equal(proposalReservationFailure(budget,original),original);assert.equal(proposalReservationFailure(budget),budget);}
    const stale=new DomainError('STALE_INPUTS','Inputs changed.',409);assert.equal(proposalReservationFailure(stale,original),stale);
    const untrusted={code:'MODEL_BUDGET_EXHAUSTED'};assert.equal(proposalReservationFailure(untrusted,original),untrusted);
 }
 // proposal output uses at most the per-call cap and remaining installation/policy budget
 {
  for(const [policy,reserved,spent,expected] of [[8000,0,0,4000],[8000,0,3370,4000],[8000,3000,3370,1630],[2500,0,0,2500],[2500,1000,1000,500],[9000,3000,0,4000],[9000,0,7000,2000],[8000,1000,7000,0],[8000,0,9000,0],[0,0,0,0],[64000,0,8000,4000],[64000,2000,61000,1000],[128000,0,63000,1000],[64000,0,64000,0]] as const){
     const actual=proposalOutputAllowance(policy,reserved,spent);assert.equal(actual,expected);assert.ok(actual>=0&&actual<=4000);assert.ok(actual<=Math.max(0,Math.min(64000,policy)-reserved-spent));
    }
 }
 // invalid proposal budget values fail closed rather than reserving or refunding tokens
 {
  for(const invalid of [NaN,Infinity,-Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1,undefined,null,'8000'])for(const index of [0,1,2]){
     const values:any[]=[8000,0,0];values[index]=invalid;
     assert.throws(()=>proposalOutputAllowance(values[0],values[1],values[2]),{code:'MODEL_BUDGET_EXHAUSTED',status:429});
    }
 }
});

// allowance
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error&&'code'in error&&error.code===code);

test("owner grants are finite append-only capacity and cannot reset usage", () => {
 // automatic and explicit owner calls remain independently visible within separate ceilings
 {
  assert.deepEqual(callAllowance(4,4,4),{automatic_calls:4,owner_granted_calls:4,total_calls:8});
    assert.deepEqual(callAllowance(1,2,4),{automatic_calls:1,owner_granted_calls:2,total_calls:3});
    assert.deepEqual(callAllowance(0,0,0),{automatic_calls:0,owner_granted_calls:0,total_calls:0});
    assert.deepEqual(callAllowance(24,4,4),{automatic_calls:24,owner_granted_calls:4,total_calls:28});
    assert.deepEqual(Object.keys(callAllowance(4,1,4)).sort(),['automatic_calls','owner_granted_calls','total_calls']);
 }
 // append-only manual capacity never resets on a later extension
 {
  assert.doesNotThrow(()=>requireExtensionCapacity(0,4,4));
    assert.doesNotThrow(()=>requireExtensionCapacity(3,1,4));
    fails(()=>requireExtensionCapacity(3,2,4),'OWNER_CALL_GRANT_LIMIT');
    fails(()=>requireExtensionCapacity(4,1,4),'OWNER_CALL_GRANT_LIMIT');
 }
 // invalid recorded usage or installation ceilings fail closed rather than granting calls
 {
  for(const count of [-1,1.5,5,NaN,Infinity])fails(()=>callAllowance(4,count,4),'INVALID_BUDGET_METADATA');
    for(const ceiling of [-1,1.5,25,NaN]){
     fails(()=>callAllowance(ceiling,0,4),'INVALID_BUDGET_CONFIGURATION');
    }
    for(const ceiling of [-1,1.5,5,NaN]){
     fails(()=>callAllowance(0,0,ceiling),'INVALID_BUDGET_CONFIGURATION');
    }
 }
 // owner extension input is finite and records a meaningful bounded reason
 {
  assert.deepEqual(extensionInput({additional_calls:1,reason:' Review competing hypothesis '},4),{additional_calls:1,reason:'Review competing hypothesis'});
    assert.doesNotThrow(()=>extensionInput({additional_calls:4,reason:'x'.repeat(2000)},4));
    for(const additional_calls of [0,-1,5,1.1,NaN,'1'])fails(()=>extensionInput({additional_calls:additional_calls as number,reason:'review'},4),'INVALID_ALLOWANCE');
    for(const reason of ['', '   ', 'x'.repeat(2001),null])fails(()=>extensionInput({additional_calls:1,reason:reason as string},4),'INVALID_REASON');
    fails(()=>extensionInput({additional_calls:1,reason:'review',reset_calls:true} as never,4),'INVALID_INPUT');
    fails(()=>extensionInput({additional_calls:1,reason:'review'},0),'INVALID_ALLOWANCE');
 }
});
