// Reversible native NTFS compression of generated performance INPUT fixtures only.
// Original filenames, contents, failed receipts and database/private objects are preserved.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
assert.equal(process.platform,'win32');
const root=path.resolve('reports/application/performance');assert.equal(await fs.realpath(root),root);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const at=new Date().toISOString(),records=[],before=await fs.statfs(root);
for(const run of await fs.readdir(root,{withFileTypes:true})){
 assert(!run.isSymbolicLink());if(!run.isDirectory())continue;
 assert(/^private-local-[0-9]{17}-[a-f0-9]{8}$/.test(run.name));
 const folder=path.join(root,run.name);assert.equal(await fs.realpath(folder),folder);
 for(const name of ['events-10000.jsonl','events-100000.jsonl']){
  const file=path.join(folder,name);let stat;try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=32*1024*1024);assert.equal(await fs.realpath(file),file);
  const original=await fs.readFile(file),sha256=hash(original);
  const result=await new Promise((resolve,reject)=>{const child=spawn('compact.exe',['/C','/A','/F',file],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',exit=>resolve({exit,output}));});
  assert.equal(result.exit,0);assert.equal(hash(await fs.readFile(file)),sha256);assert.equal((await fs.stat(file)).size,original.length);
  records.push({path:path.relative(process.cwd(),file).replaceAll('\\','/'),sha256,size_bytes:original.length,exit_code:result.exit,output:result.output});
 }
}
const after=await fs.statfs(root),receipt={operation:'ntfs_generated_input_compression',status:'passed',at,finished_at:new Date().toISOString(),files:records,free_bytes_before:before.bavail*before.bsize,free_bytes_after:after.bavail*after.bsize,limitations:['Only existing authored performance fixture inputs compressed transparently. No input, result, database, archive or private object deleted. Free-space change also includes unrelated host activity. Compression is reversible with compact /U on exact same paths.']};
const output='reports/application/consolidated/input-compression-'+randomUUID()+'.json';await fs.writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:receipt.status,files:records.length,free_bytes_before:receipt.free_bytes_before,free_bytes_after:receipt.free_bytes_after,receipt:output}));
