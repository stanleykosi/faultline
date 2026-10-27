import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {runExternalTask,validateExternalTask,type ExternalNetworkProfile} from './external-task.js';
import {canonical} from '../../../packages/core/src/canonical.js';

const TASK_PATH='/faultline/task.json',RESULT_PATH='/faultline/result.json',PROGRAM_PATH='/faultline/program.mjs';
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const ip4=/^\d{1,3}(?:\.\d{1,3}){3}$/;

function nftSet(addresses:string[],family:4|6):string{
 const selected=addresses.filter(value=>(family===4)===ip4.test(value));
 return selected.length?`ip${family===4?'':'6'} daddr { ${selected.join(', ')} } tcp dport 443 accept\n`:'';
}

/** Compiles only already-validated numeric addresses into a default-deny ruleset. */
export function externalEgressRules(profile:ExternalNetworkProfile):string{
 const validated=validateExternalTask as unknown; // keeps this module bundled with the same validator implementation.
 void validated;
 const addresses=[...new Set(Object.values(profile.resolved_addresses).flat())].sort();
 if(!addresses.length||addresses.some(value=>!/^[-a-fA-F0-9:.]+$/.test(value)))throw new Error('NETWORK_POLICY_INVALID');
 return `flush ruleset
table inet faultline {
 chain input { type filter hook input priority 0; policy drop; ct state established,related accept; }
 chain output { type filter hook output priority 0; policy drop; ct state established,related accept;
${nftSet(addresses,4)}${nftSet(addresses,6)} }
}`;
}

async function runNft(rules:string):Promise<void>{
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('nft',['-f','-'],{stdio:['pipe','ignore','pipe'],shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}}),errors:Buffer[]=[];
  child.stderr.on('data',chunk=>{if(Buffer.concat(errors).length<4096)errors.push(Buffer.from(chunk));});
  child.once('error',()=>reject(new Error('NETWORK_POLICY_UNAVAILABLE')));
  child.once('exit',code=>code===0?resolve():reject(new Error('NETWORK_POLICY_REJECTED')));
  child.stdin.end(rules);
 });
}

function hostRules(profile:ExternalNetworkProfile):string{
 const maps=Object.entries(profile.resolved_addresses).sort(([a],[b])=>a.localeCompare(b)).map(([host,addresses])=>`MAP ${host} ${addresses[0]}`);
 return [...maps,'EXCLUDE localhost'].join(',');
}

function pinnedFetch(profile:ExternalNetworkProfile){
 return async(input:string,init:{method:'GET';redirect:'error';signal:AbortSignal;headers?:Record<string,string>}):Promise<Response>=>{
  const target=new URL(input),approved=profile.resolved_addresses[target.hostname];
  if(target.protocol!=='https:'||!approved?.length)throw new Error('PINNED_FETCH_DENIED');
  return new Promise<Response>((resolve,reject)=>{
   const request=https.request(target,{method:'GET',headers:init.headers,signal:init.signal,servername:target.hostname,lookup:(_host,_options,callback)=>callback(null,approved[0]!,approved[0]!.includes(':')?6:4)},response=>{
    const chunks:Buffer[]=[],maximum=profile.max_response_bytes+1;let total=0;
    response.on('data',chunk=>{total+=chunk.length;if(total<=maximum)chunks.push(Buffer.from(chunk));else request.destroy(new Error('RECEIPT_BYTE_LIMIT'));});
    response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode??500,headers:response.headers as Record<string,string>})));
   });
   request.once('error',reject);request.end();
  });
 };
}

function dropPrivileges():void{
 if(typeof process.getuid==='function'&&process.getuid()===0){
  process.setgroups?.([]);process.setgid?.(65534);process.setuid?.(65534);
 }
 if(typeof process.getuid==='function'&&process.getuid()===0)throw new Error('RUNNER_PRIVILEGE_DROP_FAILED');
}

async function regularBytes(file:string,maximum:number):Promise<Uint8Array>{
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum||path.resolve(file)!==file)throw new Error('RUNNER_INPUT_FILE_INVALID');
 return fs.readFile(file);
}

export async function main(argv=process.argv):Promise<void>{
 if(argv.length!==4||argv[1]!==PROGRAM_PATH||argv[2]!==TASK_PATH||argv[3]!==RESULT_PATH)throw new Error('RUNNER_FIXED_PATHS_REQUIRED');
 const [programBytes,taskBytes]=await Promise.all([regularBytes(PROGRAM_PATH,4*1024*1024),regularBytes(TASK_PATH,1024*1024)]);
 const taskJson=Buffer.from(taskBytes).toString('utf8'),task=validateExternalTask(JSON.parse(taskJson));
 const output=await fs.open(RESULT_PATH,'wx+',0o600);
 try{
  await runNft(externalEgressRules(task.network_profile));
  dropPrivileges();
  const result=await runExternalTask(task,{
   browserFactory:async policy=>chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome-stable',args:[`--host-resolver-rules=${hostRules(task.network_profile)}`,'--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--no-first-run','--no-default-browser-check']}) as never,
   fetch:pinnedFetch(task.network_profile),clock:()=>new Date(),
  });
  const result_json=canonical(result),envelope={version:1,task_sha256:sha256(taskJson),program_sha256:sha256(programBytes),result_json,result_sha256:sha256(result_json)};
  await output.writeFile(JSON.stringify(envelope));await output.sync();
 }finally{await output.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'EXTERNAL_TASK_FAILED');process.exitCode=1;});
