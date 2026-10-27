import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import {isIP, BlockList} from 'node:net';
import {ConnectorError, requireWire, type SafeHttp} from '../connectors/wire.js';

const forbidden=new BlockList();
for(const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)forbidden.addSubnet(address,bits,'ipv4');
const publicV6=new BlockList(),forbiddenV6=new BlockList();publicV6.addSubnet('2000::',3,'ipv6');
for(const [address,bits] of [['::',96],['::ffff:0:0',96],['2001::',32],['2001:db8::',32],['2001:10::',28],['2001:20::',28],['2002::',16]] as const)forbiddenV6.addSubnet(address,bits,'ipv6');
// Node's BlockList maps IPv4 queries into IPv6 rules; keep the families separate.
export function publicAddress(address:string):boolean {const family=isIP(address);return family===4?!forbidden.check(address,'ipv4'):family===6?publicV6.check(address,'ipv6')&&!forbiddenV6.check(address,'ipv6'):false;}
export interface TransportOptions {origins:string[]; trustedLocalOrigins?:string[]; signal?:AbortSignal; timeoutMs?:number; beforeRequest?:()=>Promise<void>; resolve?:(hostname:string)=>Promise<{address:string;family:number}[]>;}
export interface RequestOptions {headers?:Record<string,string>;allowedOrigins?:string[];maxBytes?:number;body?:Buffer;signal?:AbortSignal;}
export class PinnedHttpTransport implements SafeHttp {
 private origins:Set<string>;private local:Set<string>;
 constructor(private options:TransportOptions){this.origins=new Set(options.origins.map(value=>exactOrigin(value)));this.local=new Set((options.trustedLocalOrigins??[]).map(value=>exactOrigin(value)));}
 get(url:string,options:RequestOptions={}){return this.request('GET',url,options);}
 post(url:string,body:Buffer,options:RequestOptions={}){return this.request('POST',url,{...options,body});}
 async request(method:'GET'|'POST',value:string,options:RequestOptions={}) {
  await this.options.beforeRequest?.();
  const url=new URL(value),local=this.local.has(url.origin);
  requireWire(this.origins.has(url.origin)&&(!options.allowedOrigins||options.allowedOrigins.includes(url.origin))&&!url.username&&!url.password&&!url.hash,'UNAPPROVED_ORIGIN','Provider destination is outside the exact operator/provider scope.');
  requireWire(url.protocol==='https:' || local && url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname),'UNSAFE_PROVIDER_URL','Provider HTTP requires explicitly registered loopback scope.');
  requireWire(local || !url.port || url.port==='443','UNSAFE_PROVIDER_PORT','Remote providers require the default HTTPS port.');
  requireWire(local || !isIP(url.hostname.replace(/^\[|\]$/g,''))&&!/^(localhost)$|\.(localhost|local)$/i.test(url.hostname),'UNSAFE_PROVIDER_URL','Remote provider must use a registered public DNS hostname.');
  const max=options.maxBytes??1048576;requireWire(Number.isSafeInteger(max)&&max>0&&max<=268435456,'INVALID_BYTE_LIMIT','Provider response requires a bounded byte limit.');
  requireWire(!options.body||options.body.length<=1048576,'PROVIDER_REQUEST_LIMIT','Provider request exceeds its finite byte limit.');
  const timeout=Math.min(this.options.timeoutMs??30000,90000),signals=[AbortSignal.timeout(timeout),this.options.signal,options.signal].filter((signal):signal is AbortSignal=>Boolean(signal)),signal=AbortSignal.any(signals);signal.throwIfAborted();
  const host=url.hostname.replace(/^\[|\]$/g,'');let removeAbort=()=>{};
  const interrupted=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(new ConnectorError('PROVIDER_ABORTED','Provider DNS reached its finite deadline.'));signal.addEventListener('abort',abort,{once:true});removeAbort=()=>signal.removeEventListener('abort',abort);});
  let addresses:{address:string;family:number}[];try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([(this.options.resolve??(hostname=>dns.lookup(hostname,{all:true,verbatim:true})))(host),interrupted]);}finally{removeAbort();}
  requireWire(addresses.length>0&&addresses.length<=32&&addresses.every(item=>isIP(item.address)===item.family&&(local||publicAddress(item.address))),'PROVIDER_DNS_DENIED','Provider DNS resolves outside the allowed network policy.');
  const chosen=addresses[0]!;
  const headers={Accept:'application/json',...options.headers,...(options.body?{'Content-Length':String(options.body.length)}:{})};
  requireWire(Object.entries(headers).every(([name,text])=>/^[A-Za-z0-9-]+$/.test(name)&&!/[\r\n\x00]/.test(text)),'INVALID_PROVIDER_HEADERS','Provider headers have invalid finite fields.');
  return new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject)=>{
   const transport=url.protocol==='https:'?https:http;
   // One validated DNS answer is used for the socket; Node must not resolve a second time.
   const request=transport.request(url,{method,headers,signal,agent:false,rejectUnauthorized:true,maxHeaderSize:16384,servername:isIP(host)?undefined:host,lookup:((_hostname:any,lookupOptions:any,callback:any)=>{if(lookupOptions?.all)callback(null,[chosen]);else callback(null,chosen.address,chosen.family);}) as any},response=>{
    let length=0;const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>max){const error=new ConnectorError('PROVIDER_BYTE_LIMIT','Provider exceeded its frozen response cap.');reject(error);response.destroy(error);request.destroy(error);return;}chunks.push(chunk);});
    response.on('aborted',()=>reject(new ConnectorError('PROVIDER_TRUNCATED','Provider response was interrupted.')));response.on('error',reject);
    response.on('end',()=>{if(!response.complete){reject(new ConnectorError('PROVIDER_TRUNCATED','Provider response was truncated.'));return;}const headers:Record<string,string>={};for(const [name,value]of Object.entries(response.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;resolve({status:response.statusCode??0,headers,body:Buffer.concat(chunks)});});
   });request.on('socket',socket=>{socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>{const expected=new BlockList();expected.addAddress(chosen.address,chosen.family===6?'ipv6':'ipv4');const address=socket.remoteAddress; if(!address||!expected.check(address,isIP(address)===6?'ipv6':'ipv4'))request.destroy(new ConnectorError('PROVIDER_DNS_DENIED','Provider socket differs from the validated pinned DNS address.'));});});request.on('error',error=>reject(error instanceof ConnectorError?error:new ConnectorError(signal.aborted?'PROVIDER_ABORTED':'PROVIDER_UNAVAILABLE','Provider socket failed or reached its finite deadline.')));if(options.body)request.write(options.body);request.end();
  });
 }
}
export function exactOrigin(value:string):string {let url:URL;try{url=new URL(value);}catch{throw new ConnectorError('INVALID_PROVIDER_ORIGIN','Provider origin is malformed.');}requireWire(url.origin===value&&!url.username&&!url.password&&!url.hash&&!url.search&&url.pathname==='/'&&['https:','http:'].includes(url.protocol),'INVALID_PROVIDER_ORIGIN','Register an exact provider origin.');return url.origin;}
export const operatorOrigins=(name:string,defaults:string[]=[]):string[]=>{const value=process.env[name];if(!value)return defaults;let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new ConnectorError('INVALID_PROVIDER_ORIGIN','Operator origin list must be a finite JSON array.');}requireWire(Array.isArray(parsed)&&parsed.length<=30&&parsed.every(origin=>typeof origin==='string'),'INVALID_PROVIDER_ORIGIN','Operator origin list must be finite.');return parsed.map(exactOrigin);};
