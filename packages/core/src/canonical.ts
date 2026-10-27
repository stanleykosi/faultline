import {createHash,createHmac,randomUUID} from 'node:crypto';
import {demand} from './errors.js';
export {randomUUID as newId};
export function canonical(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){demand(Number.isFinite(value),'INVALID_INPUT','Non-finite value');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 demand(typeof value==='object'&&value!==null,'INVALID_INPUT','Unsupported canonical value');
 const keys=Object.keys(value).sort();
 demand(!keys.some(k=>['__proto__','prototype','constructor'].includes(k)),'INVALID_INPUT','Unsafe object key');
 return '{'+keys.map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const byteHash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
/** Byte-identical array canonicalization with bounded intermediate strings. */
export function canonicalArrayBytes(values:readonly unknown[]):Buffer{
 const chunks:Buffer[]=[];let part='[',size=1;for(let i=0;i<values.length;i++){const item=(i?',':'')+canonical(values[i]);part+=item;size+=Buffer.byteLength(item);if(size>=65536){chunks.push(Buffer.from(part));part='';size=0;}}part+=']';chunks.push(Buffer.from(part));return Buffer.concat(chunks);
}
export function hashCanonicalArray(values:readonly unknown[]):string{
 const digest=createHash('sha256');digest.update('[');for(let i=0;i<values.length;i++){if(i)digest.update(',');digest.update(canonical(values[i]));}digest.update(']');return digest.digest('hex');
}
export const now=()=>new Date().toISOString();
export const csrf=(secret:string,sessionId:string)=>createHmac('sha256',secret).update('csrf:'+sessionId).digest('base64url');

