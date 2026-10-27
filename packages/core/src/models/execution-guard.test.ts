import test from 'node:test';import assert from 'node:assert/strict';
import {createExecutionGuard} from './execution-guard.js';
test('slow full authority checks are shared without overlap and publication drains the check',async()=>{
 let release!:()=>void,calls=0;const guard=createExecutionGuard(async()=>{calls++;await new Promise<void>(r=>release=r);},()=>assert.fail('unexpected failure'));
 const first=guard.check();guard.poll();guard.poll();assert.equal(guard.check(),first);await Promise.resolve();assert.equal(calls,1);
 let drained=false;const stopping=guard.stop().then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);release();await first;await stopping;assert.equal(drained,true);guard.poll();assert.equal(calls,1);
 const next=guard.check();await Promise.resolve();assert.equal(calls,2,'An explicit later check must not reuse completed authority');release();await next;
});
test('monitor retains the first actual failure and never reports a new failure after stop',async()=>{
 const reason=Object.assign(new Error('stale'),{code:'STALE_INPUTS'}),failures:unknown[]=[];let reject!:(value:unknown)=>void;
 const guard=createExecutionGuard(()=>new Promise<void>((_,r)=>reject=r),e=>failures.push(e));guard.poll();guard.poll();await Promise.resolve();reject(reason);await new Promise(r=>setImmediate(r));assert.deepEqual(failures,[reason]);await guard.stop();guard.poll();assert.deepEqual(failures,[reason]);
});
