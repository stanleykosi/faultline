import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Socket} from 'node:net';

// Trusted private benchmark helper only. Never expose this script argument through
// a product/model API. The supplied processRead script executes anew each sample.
const DEADLINE_MS=20000,MAX_PAYLOAD_BYTES=1024*1024,MAX_FRAME_BYTES=2*MAX_PAYLOAD_BYTES+8192,MAX_STDERR_BYTES=8192;
const error=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
function wrapper(script){return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$taskSamplerScript = [ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script,'utf8').toString('base64')}')))
function Write-TaskSamplerFrame($frame) { [Console]::Out.WriteLine(($frame | ConvertTo-Json -Depth 4 -Compress)); [Console]::Out.Flush() }
while ($null -ne ($taskSamplerLine = [Console]::In.ReadLine())) {
  if ([Text.Encoding]::UTF8.GetByteCount($taskSamplerLine) -gt 1024) { exit 2 }
  try { $taskSamplerRequest = $taskSamplerLine | ConvertFrom-Json } catch { exit 2 }
  if ($taskSamplerRequest.version -ne 1 -or $taskSamplerRequest.nonce -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { exit 2 }
  if ($taskSamplerRequest.kind -eq 'stop') {
    Write-TaskSamplerFrame @{version=1;kind='stopped';nonce=$taskSamplerRequest.nonce;pid=$PID}
    break
  }
  if ($taskSamplerRequest.kind -ne 'sample') { exit 2 }
  try {
    $taskSamplerOutput = @(& $taskSamplerScript)
    if ($taskSamplerOutput.Count -ne 1 -or $taskSamplerOutput[0] -isnot [string]) {
      Write-TaskSamplerFrame @{version=1;kind='error';nonce=$taskSamplerRequest.nonce;pid=$PID;code='SAMPLER_SCRIPT_OUTPUT'}
    } elseif ([Text.Encoding]::UTF8.GetByteCount($taskSamplerOutput[0]) -gt ${MAX_PAYLOAD_BYTES}) {
      Write-TaskSamplerFrame @{version=1;kind='error';nonce=$taskSamplerRequest.nonce;pid=$PID;code='SAMPLER_OUTPUT_BOUND'}
    } else {
      Write-TaskSamplerFrame @{version=1;kind='sample';nonce=$taskSamplerRequest.nonce;pid=$PID;json=$taskSamplerOutput[0]}
    }
  } catch {
    Write-TaskSamplerFrame @{version=1;kind='error';nonce=$taskSamplerRequest.nonce;pid=$PID;code='SAMPLER_SCRIPT_FAILED'}
  }
}
`}

export function createProcessSampler(script,environment={}){
 if(process.platform!=='win32')throw error('SAMPLER_PLATFORM','This observer requires the declared native Windows PowerShell profile.');
 if(typeof script!=='string'||!script.trim()||Buffer.byteLength(script,'utf8')>16384)throw error('SAMPLER_SCRIPT_BOUND','Supply only the bounded trusted benchmark script.');
 if(!environment||typeof environment!=='object'||Array.isArray(environment)||Object.entries(environment).some(([key,value])=>!key||key.includes('\0')||key.length>128||typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>65536))throw error('SAMPLER_ENVIRONMENT_BOUND','The trusted benchmark environment must be bounded strings.');
 const executable=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(wrapper(script),'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...environment}});
 let pending=null,retiredNonce=null,firstFailure=null,closePromise=null,closeResolve,closeReject,closeTimer,stopNonce=null,stopAcknowledged=false,ended=false,exitCode=null,exitSignal=null;
 let fragments=[],lineBytes=0,discardLine=false,stderrBytes=0;
 const remember=cause=>{firstFailure??=cause;return firstFailure;};
 const releasePending=cause=>{if(pending){const current=pending;pending=null;retiredNonce=current.nonce;clearTimeout(current.timer);current.reject(cause);}};
 const closeError=(code,message)=>error(code,message,{child_exited:ended,exit_code:exitCode,exit_signal:exitSignal,own_child_pid:child.pid??null});
 function completeClose(){
  if(!ended||!closePromise)return;clearTimeout(closeTimer);
  if(firstFailure)closeReject(closeError(firstFailure.code??'SAMPLER_FAILED','The observer exited after a reported sampling/protocol failure; no successful measurement is inferred.'));
  else if(exitCode!==0||exitSignal!==null)closeReject(closeError('SAMPLER_EXIT','The owned observer did not exit successfully.'));
  else if(!stopAcknowledged)closeReject(closeError('SAMPLER_STOP_UNCONFIRMED','Owned observer exit was observed without the exact graceful-stop acknowledgment.'));
  else closeResolve();
 }
 function close(){
  if(closePromise)return closePromise;
  closePromise=new Promise((resolve,reject)=>{closeResolve=resolve;closeReject=reject;});closePromise.catch(()=>{});
  if(pending)releasePending(error('SAMPLER_CLOSING','Observer close cancels an in-flight measurement; no sample is returned.'));
  if(ended){completeClose();return closePromise;}
  stopNonce=randomUUID();closeTimer=setTimeout(()=>{
   const cause=remember(error('SAMPLER_CLOSE_TIMEOUT','The owned observer did not confirm exit within20seconds; no process was terminated.'));
   closeReject(closeError(cause.code,cause.message));
   // Stop/EOF was already sent. Detach only JS event-loop references after the
   // bounded failure; an unknown live child is never relabelled stopped or killed.
   child.unref();for(const stream of child.stdio)if(stream instanceof Socket)stream.unref();
  },DEADLINE_MS);
  child.stdin.end(JSON.stringify({version:1,kind:'stop',nonce:stopNonce})+'\n',cause=>{if(cause){remember(error('SAMPLER_STDIN_FAILED','The finite observer stop could not be written.'));completeClose();}});
  return closePromise;
 }
 function fail(cause){remember(cause);releasePending(cause);void close().catch(()=>{});}
 function frame(bytes){
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail(error('SAMPLER_PROTOCOL','Observer returned malformed line protocol.'));return;}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.pid!==child.pid||typeof value.nonce!=='string'){fail(error('SAMPLER_PROTOCOL','Observer frame is not bound to its owned child.'));return;}
  if(value.kind==='stopped'){
   if(!closePromise||value.nonce!==stopNonce||stopAcknowledged){fail(error('SAMPLER_PROTOCOL_NONCE','Graceful-stop acknowledgment does not match the one owned stop.'));return;}
   stopAcknowledged=true;return;
  }
  if(closePromise&&value.nonce===retiredNonce&&['sample','error'].includes(value.kind))return;
  if(!pending||value.nonce!==pending.nonce){fail(error('SAMPLER_PROTOCOL_NONCE','Observer sample nonce is unmatched; no stale or unsolicited result is accepted.'));return;}
  if(value.kind==='error'){
   const allowed=new Set(['SAMPLER_SCRIPT_OUTPUT','SAMPLER_OUTPUT_BOUND','SAMPLER_SCRIPT_FAILED']);fail(error(allowed.has(value.code)?value.code:'SAMPLER_PROTOCOL','Trusted read-only observer script did not yield a bounded measurement.'));return;
  }
  if(value.kind!=='sample'||typeof value.json!=='string'){fail(error('SAMPLER_PROTOCOL','Observer sample frame has no JSON object measurement.'));return;}
  if(Buffer.byteLength(value.json)>MAX_PAYLOAD_BYTES){fail(error('SAMPLER_OUTPUT_BOUND','Read-only process metadata exceeded its1MiB bound.'));return;}
  let measurement;try{measurement=JSON.parse(value.json);}catch{fail(error('SAMPLER_JSON','Read-only script did not return JSON measurement metadata.'));return;}
  if(!measurement||typeof measurement!=='object'||Array.isArray(measurement)){fail(error('SAMPLER_JSON','Read-only script must return one JSON object measurement.'));return;}
  const current=pending;pending=null;clearTimeout(current.timer);current.resolve(measurement);
 }
 child.stdout.on('data',chunk=>{
  let start=0;while(start<chunk.length){const at=chunk.indexOf(10,start),end=at<0?chunk.length:at,part=chunk.subarray(start,end);
   if(!discardLine){lineBytes+=part.length;if(lineBytes>MAX_FRAME_BYTES){fragments=[];discardLine=true;fail(error('SAMPLER_OUTPUT_BOUND','Observer protocol line exceeded its finite output bound.'));}else fragments.push(part);}
   if(at<0)break;if(!discardLine){const complete=Buffer.concat(fragments,lineBytes);frame(complete);}fragments=[];lineBytes=0;discardLine=false;start=at+1;
  }
 });
 child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;fail(error(stderrBytes>MAX_STDERR_BYTES?'SAMPLER_STDERR_BOUND':'SAMPLER_STDERR','Observer emitted diagnostics; the sample remains failed.'));});
 child.stdin.on('error',()=>fail(error('SAMPLER_STDIN_FAILED','Owned observer input pipe is unavailable.')));
 child.on('error',()=>fail(error('SAMPLER_SPAWN','The owned native PowerShell observer could not start.')));
 child.on('close',(code,signal)=>{ended=true;exitCode=code;exitSignal=signal;fragments=[];lineBytes=0;if(pending)releasePending(remember(error('SAMPLER_EXIT','Owned native observer exited before a matched sample completed.')));completeClose();});
 return {
  sample(){
   if(closePromise||ended||firstFailure)return Promise.reject(firstFailure??error('SAMPLER_CLOSED','Observer is closed; no new measurement is available.'));
   if(pending)return Promise.reject(error('SAMPLER_BUSY','Only one bounded observation may be in flight; no poll was queued.'));
   return new Promise((resolve,reject)=>{const nonce=randomUUID(),timer=setTimeout(()=>fail(error('SAMPLER_TIMEOUT','Read-only process sampler exceeded its20-second deadline; no process was terminated.')),DEADLINE_MS);pending={nonce,timer,resolve,reject};child.stdin.write(JSON.stringify({version:1,kind:'sample',nonce})+'\n',cause=>{if(cause)fail(error('SAMPLER_STDIN_FAILED','The finite sample request could not be written.'));});});
  },
  close,
 };
}
