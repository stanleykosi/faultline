import fs from 'node:fs/promises';
import net,{isIP} from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {canonical} from '../../../packages/core/src/canonical.js';

const PROGRAM_PATH='/faultline/program.mjs',TASK_PATH='/faultline/task.json',RESULT_PATH='/faultline/result.json';
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const exact=(value:unknown,keys:string[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const publicIp=(value:string)=>{
 const family=isIP(value);if(!family)return false;
 if(family===4){const [a,b,c]=value.split('.').map(Number);return !(a===0||a===10||a===100&&b!>=64&&b!<=127||a===127||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0&&[0,2].includes(c!)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a!>=224);}
 const normalized=value.toLowerCase(),first=parseInt(normalized.split(':')[0]||'0',16);return first>=0x2000&&first<=0x3fff&&!normalized.startsWith('2001:db8:');
};
const statText=async(file:string,maximum=8192)=>{try{const stat=await fs.lstat(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=maximum?(await fs.readFile(file,'utf8')).trim():null;}catch{return null;}};
const symlink=async(file:string)=>{try{return await fs.readlink(file);}catch{return null;}};

async function runNft(addresses:string[]):Promise<void>{
 const v4=addresses.filter(value=>isIP(value)===4),v6=addresses.filter(value=>isIP(value)===6);
 const rules=['flush ruleset','table inet faultline {',' chain input { type filter hook input priority 0; policy drop; ct state established,related accept; }',' chain output { type filter hook output priority 0; policy drop; ct state established,related accept;',v4.length?`ip daddr { ${v4.join(', ')} } tcp dport 443 accept`:null,v6.length?`ip6 daddr { ${v6.join(', ')} } tcp dport 443 accept`:null,' }','}'].filter(Boolean).join('\n');
 await new Promise<void>((resolve,reject)=>{const child=spawn('nft',['-f','-'],{stdio:['pipe','ignore','ignore'],shell:false,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}});child.once('error',()=>reject(new Error('NFT_UNAVAILABLE')));child.once('exit',code=>code===0?resolve():reject(new Error('NFT_REJECTED')));child.stdin.end(rules);});
}

async function denied(host:string,port:number):Promise<boolean>{
 return new Promise(resolve=>{const socket=net.connect({host,port});let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;socket.destroy();resolve(value);};socket.setTimeout(1000,()=>finish(true));socket.once('connect',()=>finish(false));socket.once('error',()=>finish(true));});
}

async function privateHostDenied(host:string):Promise<boolean>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1500);
 try{await fetch(`http://${host}:3000/health/live`,{redirect:'error',signal:controller.signal});return false;}catch{return true;}finally{clearTimeout(timer);}
}

const CONTROL_PLANE_VARIABLES = [
 'RAILWAY_TOKEN','RAILWAY_API_TOKEN','REMOTE_SANDBOX_AUTH_KEY_B64','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN',
 'GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET','AZURE_TENANT_ID',
] as const;

async function main(argv=process.argv){
 if(argv.length!==4||argv[1]!==PROGRAM_PATH||argv[2]!==TASK_PATH||argv[3]!==RESULT_PATH)throw new Error('FIXED_PATHS_REQUIRED');
 const [programBytes,taskBytes]=await Promise.all([fs.readFile(PROGRAM_PATH),fs.readFile(TASK_PATH)]),taskJson=taskBytes.toString('utf8'),task=JSON.parse(taskJson);
 if(!exact(task,['version','nonce','expires_at','provider_scope','approved_origin','approved_addresses','private_probe_host'])||task.version!==1||!/^[A-Za-z0-9_-]{16,128}$/.test(task.nonce)||Date.parse(task.expires_at)<=Date.now()||Date.parse(task.expires_at)>Date.now()+120000||typeof task.provider_scope!=='string'||task.provider_scope.length<1||task.provider_scope.length>200||typeof task.private_probe_host!=='string'||task.private_probe_host.length<1||task.private_probe_host.length>253||!Array.isArray(task.approved_addresses)||!task.approved_addresses.length||task.approved_addresses.length>16||task.approved_addresses.some((item:unknown)=>typeof item!=='string'||!publicIp(item)))throw new Error('PROBE_TASK_INVALID');
 const origin=new URL(task.approved_origin);if(origin.origin!==task.approved_origin||origin.protocol!=='https:')throw new Error('PROBE_ORIGIN_INVALID');
 const private_network_denied=await privateHostDenied(task.private_probe_host);
 const before={uid:process.getuid?.()??null,gid:process.getgid?.()??null,boot_id:await statText('/proc/sys/kernel/random/boot_id',128),pid_ns:await symlink('/proc/self/ns/pid'),mount_ns:await symlink('/proc/self/ns/mnt'),network_ns:await symlink('/proc/self/ns/net'),cgroup:await statText('/proc/self/cgroup'),memory_max:await statText('/sys/fs/cgroup/memory.max'),cpu_max:await statText('/sys/fs/cgroup/cpu.max'),docker_socket_present:await fs.access('/var/run/docker.sock').then(()=>true,()=>false),control_plane_credential_present:CONTROL_PLANE_VARIABLES.some(name=>Boolean(process.env[name]))};
 const output=await fs.open(RESULT_PATH,'wx+',0o600);
 try{
  await runNft(task.approved_addresses);
  if(process.getuid?.()===0){process.setgroups?.([]);process.setgid?.(65534);process.setuid?.(65534);}
  const after_uid=process.getuid?.()??null,rules=task.approved_addresses.map((address:string)=>`MAP ${origin.hostname} ${address}`);
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome-stable',args:[`--host-resolver-rules=${[...rules,'EXCLUDE localhost'].join(',')}`,'--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--no-first-run','--no-default-browser-check']});
  let approved_https=false,browser_version='unknown';
  try{browser_version=browser.version();const page=await browser.newPage({serviceWorkers:'block'});const response=await page.goto(task.approved_origin,{waitUntil:'domcontentloaded',timeout:15000});approved_https=Boolean(response&&response.status()>=200&&response.status()<500);}finally{await browser.close();}
  const unrelated=['1.1.1.1','8.8.8.8','9.9.9.9'].find(address=>!task.approved_addresses.includes(address));
  if(!unrelated)throw new Error('UNRELATED_PUBLIC_PROBE_UNAVAILABLE');
  const direct=await Promise.all([denied(unrelated,443),denied('127.0.0.1',80),denied('169.254.169.254',80),denied('10.0.0.1',80),denied('::1',80)]);
  const result_json=canonical({version:1,kind:'hardened_isolation_probe',nonce:task.nonce,provider_scope:task.provider_scope,approved_origin:task.approved_origin,approved_addresses:task.approved_addresses,private_network_denied,firewall_default_deny:true,approved_https,unrelated_public_denied:direct[0],loopback_denied:direct[1]&&direct[4],metadata_denied:direct[2],private_address_denied:direct[3],privilege_dropped:after_uid!==0,browser_version,before});
  await output.writeFile(JSON.stringify({version:1,task_sha256:sha256(taskJson),program_sha256:sha256(programBytes),result_json,result_sha256:sha256(result_json)}));await output.sync();
 }finally{await output.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'CAPABILITY_PROBE_FAILED');process.exitCode=1;});
