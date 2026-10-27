import https from 'node:https';
import {lookup} from 'node:dns/promises';
import net from 'node:net';
import {demand,DomainError} from '../errors.js';
export interface SafeHttp {get(url:string,options?:{headers?:Record<string,string>;allowedOrigins?:string[];maxBytes?:number}):Promise<{status:number;headers:Record<string,string>;body:Buffer}>}
export function publicAddress(address:string){
 if(net.isIP(address)===4){
  const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]===169&&p[1]===254||p[0]===172&&p[1]!>=16&&p[1]!<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]!>=64&&p[1]!<=127||p[0]!>=224||p[0]===198&&[18,19].includes(p[1]!));
 }
 const lower=address.toLowerCase();
 if(lower.startsWith('::ffff:'))return publicAddress(lower.slice(7));
 // Only global unicast IPv6; exclude documentation, local, multicast, unspecified and loopback.
 return net.isIP(lower)===6&&/^[23][0-9a-f]{3}:/.test(lower)&&!lower.startsWith('2001:db8:');
}
export function checkedUrl(raw:string,allowedOrigins:readonly string[]){
 let url:URL;try{url=new URL(raw);}catch{throw new DomainError('UNSAFE_URL','Invalid provider URL.');}
 demand(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443'),'UNSAFE_URL','Only credential-free approved HTTPS origins are permitted.');
 demand(!net.isIP(url.hostname)&&!['localhost','localhost.localdomain'].includes(url.hostname.toLowerCase())&&!url.hostname.endsWith('.localhost'),'UNSAFE_URL','IP literals and local provider hosts are unavailable.');
 demand(allowedOrigins.includes(url.origin),'ORIGIN_DENIED','Provider origin is not operator-approved.',403);return url;
}
export class RestrictedHttp implements SafeHttp{
 constructor(private allowedOrigins:readonly string[],private signal?:AbortSignal){}
 async get(raw:string,options:{headers?:Record<string,string>;allowedOrigins?:string[];maxBytes?:number}={}){
  const origins=options.allowedOrigins??[...this.allowedOrigins];
  demand(origins.every(o=>this.allowedOrigins.includes(o)),'ORIGIN_DENIED','Call cannot expand network authority.',403);
  const url=checkedUrl(raw,origins),max=Math.min(options.maxBytes??8*1024*1024,64*1024*1024);
  demand(Number.isSafeInteger(max)&&max>0,'BYTE_LIMIT','Invalid byte limit.');
  const answers=await lookup(url.hostname,{all:true,verbatim:true});
  demand(answers.length&&answers.every(a=>publicAddress(a.address)),'SSRF_DENIED','Provider DNS resolved outside permitted public networks.',403);
  const selected=answers[0]!;
  return new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject)=>{
   const request=https.request(url,{method:'GET',headers:options.headers??{},timeout:15_000,signal:this.signal,
    lookup:(_hostname,_options,callback)=>callback(null,selected.address,selected.family)},
    response=>{
     const chunks:Buffer[]=[];let bytes=0;
     const length=Number(response.headers['content-length']??0);if(length>max){response.destroy(new DomainError('BYTE_LIMIT','Provider response exceeds limit.',413));return;}
     response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>max)response.destroy(new DomainError('BYTE_LIMIT','Provider response exceeds limit.',413));else chunks.push(chunk);});
     response.on('error',reject);response.on('end',()=>{
      const headers:Record<string,string>={};for(const [name,value] of Object.entries(response.headers))if(value!==undefined)headers[name]=Array.isArray(value)?value.join(', '):value;
      resolve({status:response.statusCode??502,headers,body:Buffer.concat(chunks)});
     });
    });
   request.on('timeout',()=>request.destroy(new DomainError('UPSTREAM_TIMEOUT','Provider timeout.',503)));request.on('error',reject);request.end();
  });
 }
}

