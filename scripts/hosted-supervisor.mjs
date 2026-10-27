import {spawn as nodeSpawn} from 'node:child_process';

export const hostedSupervisorDefaults = Object.freeze({
 startupTimeoutMs: 120_000,
 probeIntervalMs: 1_000,
 probeTimeoutMs: 1_500,
 shutdownTimeoutMs: 10_000,
 forcedStopTimeoutMs: 2_000,
});

function deferred(){
 let resolve;
 const promise=new Promise(done=>{resolve=done;});
 return {promise,resolve};
}

function safeReadyUrl(value){
 try{
  const url=new URL(value);
  const hostname=url.hostname,port=Number(url.port||(url.protocol==='http:'?'80':'0'));
  return url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(hostname)&&Number.isInteger(port)&&port>=1&&port<=65535&&url.pathname==='/health/ready'&&!url.username&&!url.password&&!url.search&&!url.hash;
 }catch{return false;}
}

function waitForExit(records,milliseconds){
 if(records.every(record=>record.exited))return Promise.resolve(true);
 let timer;
 const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);});
 return Promise.race([Promise.all(records.map(record=>record.exitPromise)).then(()=>true),timeout]).finally(()=>clearTimeout(timer));
}

async function stopChildren(records,{shutdownTimeoutMs,forcedStopTimeoutMs}){
 const alive=records.filter(record=>!record.exited);
 for(const record of alive){try{record.child.kill('SIGTERM');}catch{/* bounded forced stop follows */}}
 if(await waitForExit(records,shutdownTimeoutMs))return {complete:true,forced:false};
 for(const record of records.filter(item=>!item.exited)){try{record.child.kill('SIGKILL');}catch{/* report if still alive */}}
 return {complete:await waitForExit(records,forcedStopTimeoutMs),forced:true};
}

export async function probeHostedReadiness(url,fetchImpl=globalThis.fetch,timeoutMs=hostedSupervisorDefaults.probeTimeoutMs){
 if(!safeReadyUrl(url)||typeof fetchImpl!=='function')return false;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(url,{method:'GET',cache:'no-store',redirect:'error',signal:controller.signal});
  if(response.status!==200)return false;
  const body=await response.json();
  return body?.status==='ready'&&body?.components?.database==='ready'&&body?.components?.storage==='ready'&&body?.components?.worker==='ready';
 }catch{return false;}finally{clearTimeout(timer);}
}

/** Supervise exactly the supplied API and worker children. No shell or migration command is invoked. */
export async function superviseHosted({
 children,
 readinessUrl,
 env=process.env,
 spawnProcess=nodeSpawn,
 probeReady=probeHostedReadiness,
 signalSource=process,
 startupTimeoutMs=hostedSupervisorDefaults.startupTimeoutMs,
 probeIntervalMs=hostedSupervisorDefaults.probeIntervalMs,
 shutdownTimeoutMs=hostedSupervisorDefaults.shutdownTimeoutMs,
 forcedStopTimeoutMs=hostedSupervisorDefaults.forcedStopTimeoutMs,
}={}){
 if(!Array.isArray(children)||children.length!==2||new Set(children.map(item=>item.role)).size!==2||!children.some(item=>item.role==='api')||!children.some(item=>item.role==='worker'))return {exitCode:1,reason:'INVALID_CHILD_SET'};
 if(!safeReadyUrl(readinessUrl))return {exitCode:1,reason:'INVALID_READINESS_TARGET'};
 const timing={shutdownTimeoutMs,forcedStopTimeoutMs},records=[],failure=deferred(),signal=deferred();
 let failed=null,receivedSignal=null,stopping=false;
 const onFailure=reason=>{if(failed||stopping)return;failed=reason;failure.resolve(reason);};
 const onSignal=name=>{if(receivedSignal)return;receivedSignal=name;signal.resolve(name);};
 const sigint=()=>onSignal('SIGINT'),sigterm=()=>onSignal('SIGTERM');
 signalSource.on('SIGINT',sigint);signalSource.on('SIGTERM',sigterm);

 const finish=(record,reason)=>{
  if(record.exited)return;
  record.exited=true;record.exitReason=reason;record.resolveExit();
 };
 try{
  for(const spec of children){
   if(receivedSignal||failed)break;
   let child;
   try{
    child=spawnProcess(process.execPath,['--max-old-space-size=128',spec.entry],{
     cwd:spec.cwd,
     env:{...env,PROCESS_ROLE:spec.role},
     shell:false,
     windowsHide:true,
     stdio:'inherit',
    });
   }catch{onFailure('CHILD_SPAWN_FAILED');break;}
   const exited=deferred(),record={role:spec.role,child,exited:false,exitPromise:exited.promise,resolveExit:exited.resolve};records.push(record);
   child.once('error',()=>{
    if(child.pid===undefined||child.pid===null)finish(record,'spawn_error');
    onFailure(child.pid===undefined||child.pid===null?'CHILD_SPAWN_FAILED':'CHILD_PROCESS_ERROR');
   });
   child.once('exit',(code,terminationSignal)=>{
    finish(record,{code,signal:terminationSignal});
    if(!stopping)onFailure('CHILD_EXITED_UNEXPECTEDLY');
   });
   child.once('close',(code,terminationSignal)=>{
    finish(record,{code,signal:terminationSignal});
    if(!stopping)onFailure('CHILD_EXITED_UNEXPECTEDLY');
   });
  }

  if(!failed&&!receivedSignal){
   const deadline=Date.now()+startupTimeoutMs;
   let ready=false;
   while(Date.now()<=deadline){
    const remaining=Math.max(0,deadline-Date.now());let timeoutId;
    const timedOut=new Promise(resolve=>{timeoutId=setTimeout(()=>resolve({kind:'timeout'}),remaining);});
    const result=await Promise.race([
     Promise.resolve().then(()=>probeReady(readinessUrl)).then(ok=>({kind:'probe',ok:ok===true}),()=>({kind:'probe',ok:false})),
     failure.promise.then(reason=>({kind:'failure',reason})),
     signal.promise.then(name=>({kind:'signal',name})),
     timedOut,
    ]);
    clearTimeout(timeoutId);
    if(result.kind==='failure'){failed=result.reason;break;}
    if(result.kind==='signal'){receivedSignal=result.name;break;}
    if(result.kind==='timeout'){failed='READINESS_TIMEOUT';break;}
    if(result.ok&&Date.now()<=deadline){ready=true;break;}
    const pause=Math.min(probeIntervalMs,Math.max(0,deadline-Date.now()));if(pause<=0){failed='READINESS_TIMEOUT';break;}
    let pauseTimer;
    const pauseResult=await Promise.race([
     new Promise(resolve=>{pauseTimer=setTimeout(()=>resolve({kind:'retry'}),pause);}),
     failure.promise.then(reason=>({kind:'failure',reason})),
     signal.promise.then(name=>({kind:'signal',name})),
    ]);
    clearTimeout(pauseTimer);
    if(pauseResult.kind==='failure'){failed=pauseResult.reason;break;}
    if(pauseResult.kind==='signal'){receivedSignal=pauseResult.name;break;}
   }
   if(!ready&&!failed&&!receivedSignal)failed='READINESS_TIMEOUT';
   if(ready&&!failed&&!receivedSignal){
    const result=await Promise.race([failure.promise.then(reason=>({kind:'failure',reason})),signal.promise.then(name=>({kind:'signal',name}))]);
    if(result.kind==='failure')failed=result.reason;else receivedSignal=result.name;
   }
  }
 }catch{onFailure('SUPERVISOR_FAILURE');}

 stopping=true;
 let stopResult={complete:false,forced:false};
 try{stopResult=await stopChildren(records,timing);}catch{stopResult={complete:false,forced:false};}
 signalSource.off?.('SIGINT',sigint);signalSource.off?.('SIGTERM',sigterm);
 signalSource.removeListener?.('SIGINT',sigint);signalSource.removeListener?.('SIGTERM',sigterm);
 if(!stopResult.complete)return {exitCode:1,reason:'CHILD_FORCE_STOP_TIMEOUT'};
 if(stopResult.forced)return {exitCode:1,reason:'CHILDREN_FORCE_STOPPED',trigger:failed??(receivedSignal?'SHUTDOWN_SIGNAL':'SUPERVISOR_STOPPED')};
 if(failed)return {exitCode:1,reason:failed};
 if(receivedSignal&&records.some(record=>record.exitReason&&typeof record.exitReason==='object'&&(record.exitReason.code!==0||record.exitReason.signal!==null)))return {exitCode:1,reason:'CHILD_SHUTDOWN_FAILED'};
 if(receivedSignal)return {exitCode:0,reason:'SHUTDOWN_SIGNAL'};
 return {exitCode:1,reason:failed??'SUPERVISOR_STOPPED'};
}
