import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {stopUnreadyOwnedChild} from './owned-child-stop.mjs';
test('an actual owned unready finite test child exits without manufacturing containment proof',async()=>{
 const entry='setInterval(()=>{},1000)',child=spawn(process.execPath,['-e',entry],{windowsHide:true,shell:false,stdio:'ignore'});
 await assert.rejects(stopUnreadyOwnedChild(child,'another-entry'),/assertion|false|falsy/i);assert.equal(child.exitCode,null);
 const result=await stopUnreadyOwnedChild(child,entry);assert.equal(result.process_exited,true);assert.equal(result.closure_verified,false);assert.equal(result.containment,'unknown');assert.ok(child.exitCode!==null||child.signalCode!==null);
});
