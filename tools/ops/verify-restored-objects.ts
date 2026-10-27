import fs from 'node:fs/promises';
import path from 'node:path';
import {byteHash} from '../../packages/core/src/canonical.js';
import {demand,DomainError} from '../../packages/core/src/errors.js';

export type RestoredObjectReference={workspace_id:string;object_key:string;size_bytes:string};
/** Database references, rather than archive presence alone, define required recovery bytes. */
export async function verifyRestoredObjects(root:string,references:RestoredObjectReference[]){
 const absolute=path.resolve(root);
 demand(await fs.realpath(absolute)===absolute,'RESTORE_PATH_ESCAPE','Recovery object root must resolve exactly.');
 for(const reference of references){
  demand(/^[a-f0-9-]{36}$/i.test(reference.workspace_id)&&/^[a-f0-9]{64}$/.test(reference.object_key),'RESTORE_OBJECT_IDENTITY','Recovered object identity is invalid.');
  const file=path.join(absolute,reference.workspace_id,reference.object_key);
  let bytes:Buffer;
  try{
   const entry=await fs.lstat(file);
   demand(await fs.realpath(path.dirname(file))===path.dirname(file)&&entry.isFile()&&!entry.isSymbolicLink(),'RESTORE_PATH_ESCAPE','Recovered object must be a regular private file without redirection.');
   bytes=await fs.readFile(file);
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new DomainError('RESTORE_OBJECT_MISSING','A recovered database reference has no private evidence bytes; recovery is not verified.',422);throw error;}
  demand(bytes.length===Number(reference.size_bytes)&&byteHash(bytes)===reference.object_key,'RESTORE_OBJECT_CHECKSUM','Recovered database reference does not resolve to exact private bytes.');
 }
 return {verified_objects:references.length};
}
