import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {superviseHosted,probeHostedReadiness} from '../../scripts/hosted-supervisor.mjs';

const target='http://127.0.0.1:3600/health/ready';
const specs=[{role:'api',entry:'api.js'},{role:'worker',entry:'worker.js'}];

class Child extends EventEmitter{
 constructor(role,{ignoreTerm=false,ignoreKill=false,pid=100}={}){super();this.role=role;this.ignoreTerm=ignoreTerm;this.ignoreKill=ignoreKill;this.pid=pid;this.kills=[];this.exited=false;}
 kill(signal){this.kills.push(signal);if(signal==='SIGTERM'&&this.ignoreTerm||signal==='SIGKILL'&&this.ignoreKill)return true;setImmediate(()=>{if(!this.exited){this.exited=true;this.emit('exit',signal==='SIGTERM'?0:null,signal==='SIGKILL'?'SIGKILL':null);}});return true;}
 exit(code=0){if(!this.exited){this.exited=true;this.emit('exit',code,null);}}
}

function harness({childOptions={},probeReady=async()=>true,spawnFailureAt=null,startupTimeoutMs=100,probeIntervalMs=5,shutdownTimeoutMs=30,forcedStopTimeoutMs=30}={}){
 const children=[],calls=[],signals=new EventEmitter();let spawnCount=0;
 const spawnProcess=(executable,args,options)=>{
  calls.push({executable,args,options});spawnCount++;
  if(spawnFailureAt===spawnCount)throw new Error('synthetic spawn failure');
  const role=options.env.PROCESS_ROLE,child=new Child(role,childOptions[role]);children.push(child);
  return child;
 };
 const running=superviseHosted({children:specs,readinessUrl:target,env:{NO_SECRET_LOGGING:'synthetic'},spawnProcess,probeReady,signalSource:signals,startupTimeoutMs,probeIntervalMs,shutdownTimeoutMs,forcedStopTimeoutMs});
 return {running,children,calls,signals};
}

async function until(predicate){
 const deadline=Date.now()+500;
 while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(predicate(),'condition did not become true within the synthetic test bound');
}

test('spawns exactly API and worker without a shell, requires the ready health contract, and shuts down idempotently',async()=>{
 let probes=0;const h=harness({probeReady:async url=>{probes++;assert.equal(url,target);return true;}});
 await until(()=>probes>0);h.signals.emit('SIGTERM');h.signals.emit('SIGTERM');
 const result=await h.running;
 assert.deepEqual(result,{exitCode:0,reason:'SHUTDOWN_SIGNAL'});
 assert.equal(h.children.length,2);assert.deepEqual(h.children.map(x=>x.role),['api','worker']);
 assert.ok(h.calls.every(x=>x.executable===process.execPath&&x.options.shell===false&&x.options.stdio==='inherit'));
 assert.deepEqual(h.calls.map(x=>x.options.env.PROCESS_ROLE),['api','worker']);
 assert.ok(h.children.every(x=>x.kills.filter(signal=>signal==='SIGTERM').length===1));
});

test('503 and failed readiness probes time out and stop both children',async()=>{
 let probes=0;const h=harness({startupTimeoutMs:30,probeIntervalMs:4,probeReady:async()=>{probes++;throw new Error('synthetic probe failure');}});
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'READINESS_TIMEOUT'});
 assert.ok(probes>0);assert.ok(h.children.every(x=>x.exited));
});

test('a worker exit with code zero before readiness is an unexpected failure and stops the API sibling',async()=>{
 let probeCount=0;const h=harness({probeReady:async()=>{probeCount++;return false;}});
 await until(()=>h.children.length===2);h.children.find(child=>child.role==='worker').exit(0);
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILD_EXITED_UNEXPECTEDLY'});
 assert.ok(probeCount<10);assert.deepEqual(h.children.find(child=>child.role==='api').kills,['SIGTERM']);
});

for(const exitCode of [0,2])test(`an observed worker exit(${exitCode}) stays failed when SIGTERM races the first readiness probe`,async()=>{
 let h,emitted=false;
 h=harness({probeReady:async()=>{
  if(!emitted){emitted=true;h.children.find(child=>child.role==='worker').exit(exitCode);h.signals.emit('SIGTERM');}
  return false;
 }});
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILD_EXITED_UNEXPECTEDLY'});
 assert.equal(emitted,true);assert.ok(h.children.every(child=>child.exited));
});

test('a failed child remains a nonzero supervisor result when sibling shutdown is graceful',async()=>{
 const h=harness();await until(()=>h.children.length===2);
 h.children.find(child=>child.role==='worker').exit(2);
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILD_EXITED_UNEXPECTEDLY'});
 assert.deepEqual(h.children.find(child=>child.role==='api').kills,['SIGTERM']);
 assert.equal(h.children.every(child=>child.exited),true);
});

test('child process errors fail closed and stop its sibling',async()=>{
 const h=harness();await until(()=>h.children.length===2);
 h.children.find(child=>child.role==='worker').emit('error',new Error('synthetic process error'));
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILD_PROCESS_ERROR'});
 assert.ok(h.children.every(child=>child.exited));
});

test('synchronous spawn failure stops an already-started sibling',async()=>{
 const h=harness({spawnFailureAt:2});const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILD_SPAWN_FAILED'});
 assert.equal(h.children.length,1);assert.deepEqual(h.children[0].kills,['SIGTERM']);assert.equal(h.children[0].exited,true);
});

test('shutdown deadline sends a force-stop to both stuck children',async()=>{
 let probes=0;const h=harness({probeReady:async()=>{probes++;return true;},childOptions:{api:{ignoreTerm:true},worker:{ignoreTerm:true}},shutdownTimeoutMs:12,forcedStopTimeoutMs:30});
 await until(()=>probes>0);h.signals.emit('SIGINT');
 const result=await h.running;
 assert.deepEqual(result,{exitCode:1,reason:'CHILDREN_FORCE_STOPPED',trigger:'SHUTDOWN_SIGNAL'});
 assert.ok(h.children.every(child=>child.exited&&child.kills[0]==='SIGTERM'&&child.kills[1]==='SIGKILL'));
});

test('failure to stop even after the forced-stop deadline is reported as a failed shutdown',async()=>{
 const h=harness({probeReady:async()=>true,childOptions:{api:{ignoreTerm:true,ignoreKill:true},worker:{ignoreTerm:true,ignoreKill:true}},shutdownTimeoutMs:8,forcedStopTimeoutMs:8});
 await until(()=>h.children.length===2);h.signals.emit('SIGTERM');
 assert.deepEqual(await h.running,{exitCode:1,reason:'CHILD_FORCE_STOP_TIMEOUT'});
 assert.ok(h.children.every(child=>child.kills.includes('SIGKILL')));
});

test('readiness probe accepts only 200 with database, storage, and fresh-worker readiness',async()=>{
 let requested;
 const fetchImpl=async(url,options)=>{requested={url,options};return {status:200,json:async()=>({status:'ready',components:{database:'ready',storage:'ready',worker:'ready'}})};};
 assert.equal(await probeHostedReadiness(target,fetchImpl),true);
 assert.equal(requested.url,target);assert.equal(requested.options.redirect,'error');
 assert.equal(await probeHostedReadiness('https://example.com/health/ready',fetchImpl),false);
 assert.equal(await probeHostedReadiness(target,async()=>({status:200,json:async()=>({status:'ready',components:{database:'ready',storage:'ready',worker:'stale'}})})),false);
});
