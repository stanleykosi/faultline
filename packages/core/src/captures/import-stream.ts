import {Readable} from 'node:stream';import{finished}from'node:stream/promises';import {createGunzip} from 'node:zlib';import{parse}from'csv-parse';import{TextDecoder}from'node:util';import{rejectDuplicateJsonKeys}from'../imports/duplicate-json-keys.js';import{DEFAULT_IMPORT_LIMITS}from'../imports/parser.js';import{demand}from'../errors.js';
const namespace=(value:unknown):string|null=>{const source=(value as {source_id?:unknown}|null)?.source_id;return typeof source==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(source)?source:null;};
/** Untrusted bounded hint only. The subsequent normalizer drains and verifies the complete immutable object before any publication. */
export async function sniffSourceNamespace(input:AsyncIterable<Uint8Array>,format:'csv'|'jsonl'|'gzip_jsonl'):Promise<string|null>{
 const hintBytes=1024*1024;let inputBytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});
 async function* bounded(){for await(const chunk of input){inputBytes+=chunk.byteLength;demand(inputBytes<=hintBytes,'BYTE_LIMIT','Namespace input exceeded the source limit',413);yield chunk;}}
 const streams:Readable[]=[],settlements:Promise<unknown>[]=[];const track=<T extends Readable>(stream:T):T=>{streams.push(stream);settlements.push(finished(stream,{cleanup:true}).catch(()=>undefined));return stream;};const source=track(Readable.from(bounded()));let output:Readable=source;
 try{
  if(format==='csv'){
   const csv=track(parse({bom:true,columns:(headers:string[])=>{demand(headers.every(h=>h.length>0&&h.length<=128&&!['__proto__','constructor','prototype'].includes(h))&&new Set(headers).size===headers.length,'INVALID_HEADERS','CSV headers must be unique safe names');return headers;},cast:false,cast_date:false,relax_column_count:false,relax_quotes:false,skip_records_with_error:false,max_record_size:DEFAULT_IMPORT_LIMITS.recordBytes,to:1}));
   const text=(async function*(){for await(const chunk of source)yield decoder.decode(chunk,{stream:true});const tail=decoder.decode();if(tail)yield tail;})();const decoded=track(Readable.from(text));output=csv;decoded.once('error',error=>csv.destroy(error));decoded.pipe(csv);
   try{for await(const record of csv)return namespace(record);return null;}finally{decoded.destroy();}
  }
  if(format==='gzip_jsonl'){const gunzip=track(createGunzip());source.once('error',error=>gunzip.destroy(error));source.pipe(gunzip);output=gunzip;}
  let pending='',decodedBytes=0,started=false;
  const lineNamespace=(line:string)=>{demand(Buffer.byteLength(line)<=DEFAULT_IMPORT_LIMITS.recordBytes,'RECORD_LIMIT','Namespace record exceeds its finite ceiling');rejectDuplicateJsonKeys(line,DEFAULT_IMPORT_LIMITS.depth);return namespace(JSON.parse(line));};
  for await(const chunk of output){decodedBytes+=chunk.length;demand(decodedBytes<=hintBytes&&(format!=='gzip_jsonl'||decodedBytes<=Math.max(1,inputBytes)*DEFAULT_IMPORT_LIMITS.expansionRatio),'EXPANSION_LIMIT','Namespace decoded input exceeds its finite ceiling');let text=decoder.decode(chunk,{stream:true});if(!started&&text.length){text=text.replace(/^\uFEFF/,'');started=true;}pending+=text;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);if(line.trim())return lineNamespace(line);}demand(Buffer.byteLength(pending)<=DEFAULT_IMPORT_LIMITS.recordBytes,'RECORD_LIMIT','Namespace record exceeds its finite ceiling');}
  pending+=decoder.decode();return pending.trim()?lineNamespace(pending.replace(/\r$/,'')):null;
 }catch{return null;}finally{for(const stream of streams)stream.destroy();await Promise.all(settlements);}
}
export function bufferedJsonNamespace(bytes:Buffer):string|null{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');rejectDuplicateJsonKeys(text,DEFAULT_IMPORT_LIMITS.depth);return namespace(JSON.parse(text)?.[0]);}catch{return null;}}

