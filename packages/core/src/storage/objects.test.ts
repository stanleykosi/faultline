import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrivateObjects} from './objects.js';
import {DomainError} from '../errors.js';

const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
const consume=async(input:AsyncIterable<Buffer>)=>{const parts:Buffer[]=[];for await(const part of input)parts.push(part);return Buffer.concat(parts);};
async function fixture(){const root=path.resolve('.runtime/acceptance/object-stream-'+randomUUID()),wid=randomUUID(),objects=new PrivateObjects(root);await fs.mkdir(root,{recursive:true});return{root,wid,objects};}

test('stored stream preserves original binary bytes with bounded chunks and verified EOF',async()=>{
 const {wid,objects}=await fixture(),bytes=Buffer.alloc(196613);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const stored=await objects.put(wid,bytes),parts:Buffer[]=[];for await(const chunk of objects.readStream(wid,stored.key,bytes.length)){assert.ok(chunk.length<=65536);parts.push(chunk);}
 assert.ok(parts.length>1);assert.deepEqual(Buffer.concat(parts),bytes);
 await assert.rejects(consume(objects.readStream(wid,stored.key,bytes.length-1)),code('BYTE_LIMIT'));
 for(const limit of [0,-1,NaN,Infinity,1.5,256*1024*1024+1])await assert.rejects(consume(objects.readStream(wid,stored.key,limit)),code('BYTE_LIMIT'));
});

test('same-length corruption and truncation cannot complete an authenticated stream',async()=>{
 const {root,wid,objects}=await fixture(),original=Buffer.from('independent original bytes'),stored=await objects.put(wid,original),file=path.join(root,wid,stored.key);
 const altered=Buffer.from(original);altered[0]=altered[0]!^1;await fs.writeFile(file,altered);
 await assert.rejects(consume(objects.readStream(wid,stored.key)),code('ARTIFACT_CORRUPT'));
 await fs.writeFile(file,original.subarray(0,original.length-1));await assert.rejects(consume(objects.readStream(wid,stored.key)),code('ARTIFACT_CORRUPT'));
});

test('early iterator return closes the file and subsequent complete reads remain valid',async()=>{
 const {root,wid,objects}=await fixture(),bytes=Buffer.alloc(196608,73),stored=await objects.put(wid,bytes),iterator=objects.readStream(wid,stored.key);
 assert.equal((await iterator.next()).value?.length,65536);assert.equal((await iterator.return(undefined)).done,true);
 const file=path.join(root,wid,stored.key),moved=file+'.closure-proof';await fs.rename(file,moved);await fs.rename(moved,file);
 assert.deepEqual(await consume(objects.readStream(wid,stored.key)),bytes);
});

test('empty immutable object validates at EOF and invalid identities fail before access',async()=>{
 const {wid,objects}=await fixture(),stored=await objects.put(wid,Buffer.alloc(0));assert.equal((await consume(objects.readStream(wid,stored.key))).length,0);
 await assert.rejects(consume(objects.readStream('../escape',stored.key)),code('INVALID_OBJECT'));
 await assert.rejects(consume(objects.readStream(wid,'../escape')),code('INVALID_OBJECT'));
});
