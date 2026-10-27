import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assertDirectory,readRegular,verifyInventory,assertPublicArchivePath} from '../scripts/release-integrity.mjs';

test('release reads reject real outside, junction and hardlink input redirection',async()=>{
 const base=path.resolve('.runtime/release-integrity',randomUUID()),root=path.join(base,'workspace'),outside=path.join(base,'outside');
 await fs.mkdir(root,{recursive:true});await fs.mkdir(outside);
 const inside=path.join(root,'plain.txt'),secret=path.join(outside,'dummy.txt');
 await fs.writeFile(inside,'allowed fixture');await fs.writeFile(secret,'outside dummy fixture');
 assert.equal((await readRegular(root,inside)).toString(),'allowed fixture');
 assert.equal(await assertDirectory(root,root),root);
 await assert.rejects(readRegular(root,secret),/outside workspace/);
 const redirect=path.join(root,'redirect');await fs.symlink(outside,redirect,'junction');
 try{
  await assert.rejects(assertDirectory(root,redirect),/must be real|redirection/);
  await assert.rejects(readRegular(root,path.join(redirect,'dummy.txt')),/redirection/);
 }finally{await fs.unlink(redirect);}
 const linked=path.join(root,'linked.txt');await fs.link(secret,linked);
 await assert.rejects(readRegular(root,linked),/regular unlinked file/);
});

test('inventory requires unique exact paths, independently fixed sizes and hashes',()=>{
 const a=Buffer.from('A'),b=Buffer.from('B'),descriptor=(name,bytes)=>({path:name,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 const entries=new Map([['a',a],['b',b]]),da=descriptor('a',a),db=descriptor('b',b);
 verifyInventory(entries,[da,db]);
 assert.throws(()=>verifyInventory(entries,[da,da]),/Duplicate inventory path/);
 assert.throws(()=>verifyInventory(entries,[da]),/exact inventory/);
 assert.throws(()=>verifyInventory(entries,[da,{...db,sha256:da.sha256}]));
 assert.throws(()=>verifyInventory(entries,[da,{...db,size_bytes:2}]));
});

test('only exact reviewed environment examples can enter public archives',()=>{
 for(const name of ['ops/.env.example','ops/.env.live.example','ops/.env.runner.example','apps/web/src/main.tsx','.gitignore','.github/workflows/ci.yml'])assert.equal(assertPublicArchivePath(name),name);
 for(const name of ['.env','.env.local','ops/.env/secret','ops/.env.ops','apps/.env.example','.runtime/key','node_modules/pkg','.git/config','../outside','a\\b','C:/secret'])assert.throws(()=>assertPublicArchivePath(name));
});
