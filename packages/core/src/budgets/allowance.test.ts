import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callAllowance,extensionInput,requireExtensionCapacity} from './allowance.js';
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(error:unknown)=>error instanceof Error&&'code'in error&&error.code===code);

test('automatic and explicit owner calls remain independently visible within separate ceilings',()=>{
 assert.deepEqual(callAllowance(4,4,4),{automatic_calls:4,owner_granted_calls:4,total_calls:8});
 assert.deepEqual(callAllowance(1,2,4),{automatic_calls:1,owner_granted_calls:2,total_calls:3});
 assert.deepEqual(callAllowance(0,0,0),{automatic_calls:0,owner_granted_calls:0,total_calls:0});
 assert.deepEqual(callAllowance(24,4,4),{automatic_calls:24,owner_granted_calls:4,total_calls:28});
 assert.deepEqual(Object.keys(callAllowance(4,1,4)).sort(),['automatic_calls','owner_granted_calls','total_calls']);
});
test('append-only manual capacity never resets on a later extension',()=>{
 assert.doesNotThrow(()=>requireExtensionCapacity(0,4,4));
 assert.doesNotThrow(()=>requireExtensionCapacity(3,1,4));
 fails(()=>requireExtensionCapacity(3,2,4),'OWNER_CALL_GRANT_LIMIT');
 fails(()=>requireExtensionCapacity(4,1,4),'OWNER_CALL_GRANT_LIMIT');
});
test('invalid recorded usage or installation ceilings fail closed rather than granting calls',()=>{
 for(const count of [-1,1.5,5,NaN,Infinity])fails(()=>callAllowance(4,count,4),'INVALID_BUDGET_METADATA');
 for(const ceiling of [-1,1.5,25,NaN]){
  fails(()=>callAllowance(ceiling,0,4),'INVALID_BUDGET_CONFIGURATION');
 }
 for(const ceiling of [-1,1.5,5,NaN]){
  fails(()=>callAllowance(0,0,ceiling),'INVALID_BUDGET_CONFIGURATION');
 }
});
test('owner extension input is finite and records a meaningful bounded reason',()=>{
 assert.deepEqual(extensionInput({additional_calls:1,reason:' Review competing hypothesis '},4),{additional_calls:1,reason:'Review competing hypothesis'});
 assert.doesNotThrow(()=>extensionInput({additional_calls:4,reason:'x'.repeat(2000)},4));
 for(const additional_calls of [0,-1,5,1.1,NaN,'1'])fails(()=>extensionInput({additional_calls:additional_calls as number,reason:'review'},4),'INVALID_ALLOWANCE');
 for(const reason of ['', '   ', 'x'.repeat(2001),null])fails(()=>extensionInput({additional_calls:1,reason:reason as string},4),'INVALID_REASON');
 fails(()=>extensionInput({additional_calls:1,reason:'review',reset_calls:true} as never,4),'INVALID_INPUT');
 fails(()=>extensionInput({additional_calls:1,reason:'review'},0),'INVALID_ALLOWANCE');
});
