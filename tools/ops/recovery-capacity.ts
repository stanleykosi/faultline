import fs from 'node:fs/promises';
import {demand} from '../../packages/core/src/errors.js';

// Leave room for bounded archive/SQL temporary work and an isolated copy.
// This floor supplements, rather than replaces, actual output/database limits.
export const MIN_RECOVERY_FREE_BYTES=2*1024*1024*1024;
export function assertRecoveryCapacity(availableBytes:number):void{
 demand(Number.isSafeInteger(availableBytes)&&availableBytes>=MIN_RECOVERY_FREE_BYTES,'RECOVERY_STORAGE_CAPACITY','Recovery needs at least 2 GiB free on the workspace volume before backup or isolated restore.',503);
}
export async function checkRecoveryCapacity(directory:string):Promise<void>{
 const stat=await fs.statfs(directory);assertRecoveryCapacity(stat.bavail*stat.bsize);
}
