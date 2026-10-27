import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const within=(root,file)=>{const relative=path.relative(root,file);return !relative.startsWith('..')&&!path.isAbsolute(relative);};
export function assertPublicArchivePath(name){
 const examples=new Set(['ops/.env.example','ops/.env.live.example','ops/.env.runner.example']);
 assert(typeof name==='string'&&name.length>0&&!name.includes('\\')&&!name.includes(':')&&!path.posix.isAbsolute(name)&&name.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'),'Unsafe archive path');
 assert(examples.has(name)||!/(^|\/)(?:(?:\.runtime|node_modules|\.git)(?:\/|$)|\.env(?:$|[./]))/.test(name),'Private archive path');
 return name;
}
export async function assertDirectory(root,directory){
 const absolute=path.resolve(directory);assert(within(root,absolute),'Release directory outside workspace');
 const stat=await fs.lstat(absolute);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Release directory must be real');
 assert.equal(await fs.realpath(absolute),absolute,'Release directory redirection');return absolute;
}
export async function readRegular(root,file){
 const absolute=path.resolve(file);assert(within(root,absolute),'Release file outside workspace');
 const stat=await fs.lstat(absolute);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Release file must be a private regular unlinked file');
 assert.equal(await fs.realpath(absolute),absolute,'Release file redirection');assert(stat.size<=64*1024*1024,'Individual artifact ceiling');
 return fs.readFile(absolute);
}
export function verifyInventory(entries,inventory){
 const wanted=new Map();for(const descriptor of inventory){assert(!wanted.has(descriptor.path),'Duplicate inventory path');wanted.set(descriptor.path,descriptor);}
 assert.deepEqual([...entries.keys()].sort(),[...wanted.keys()].sort(),'Archive paths differ from exact inventory');
 for(const [name,bytes]of entries){const expected=wanted.get(name);assert.equal(bytes.length,expected.size_bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.sha256);}
}
