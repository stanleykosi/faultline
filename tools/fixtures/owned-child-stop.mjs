import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';
// A failure-path process bound, never evidence of browser/server/lock closure.
// Windows SIGTERM terminates the owned process; it is not a graceful proof.
export async function stopUnreadyOwnedChild(child,expectedEntry,maximumMs=10000){
 assert.ok(child instanceof ChildProcess&&Number.isInteger(child.pid));
 assert.equal(child.spawnfile,process.execPath);assert.ok(child.spawnargs.includes(expectedEntry));
 assert.ok(Number.isInteger(maximumMs)&&maximumMs>0&&maximumMs<=10000);
 if(child.exitCode!==null||child.signalCode!==null)return {process_exited:true,exit_code:child.exitCode,signal:child.signalCode,containment:'unknown',closure_verified:false};
 let timer;const exit=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Owned unready child exit remains unknown.')),maximumMs);child.once('exit',(code,signal)=>resolve({code,signal}));});
 try{assert.equal(child.kill('SIGTERM'),true);const actual=await exit;return {process_exited:true,exit_code:actual.code,signal:actual.signal,requested_signal:'SIGTERM',termination_semantics:process.platform==='win32'?'owned_process_termination':'signal_requested',containment:'unknown',closure_verified:false};}
 finally{clearTimeout(timer);}
}
