import type pg from 'pg';
import {demand,DomainError} from '../../core/src/errors.js';

export function runtimePoolSize(value:string|undefined,fallback:number):number {
 const size=value===undefined?fallback:Number(value);
 demand(Number.isSafeInteger(size)&&size>=1&&size<=32,'CONFIGURATION','Database pool size must be an integer from1 to32.');
 return size;
}

/** Hold all bounded slots until every connection is opened; release every slot on failure. */
export async function warmPool(pool:pg.Pool,size:number):Promise<void>{
 demand(Number.isSafeInteger(size)&&size>=1&&size<=32&&size<=pool.options.max,'CONFIGURATION','Warm-up cannot exceed the configured pool.');
 const connections=await Promise.allSettled(Array.from({length:size},()=>pool.connect()));
 const clients=connections.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
 let failed=connections.some(result=>result.status==='rejected');
 try {
  if(!failed){
   // Installed pg8.16.3 accepts per-query read timeouts; its declaration omits this field.
   const query:pg.QueryConfig&{query_timeout:number}={text:'SELECT 1 AS warm',query_timeout:3000};
   const checks=await Promise.allSettled(clients.map(client=>client.query(query)));
   failed=checks.some(result=>result.status==='rejected'||result.value.rows[0]?.warm!==1);
  }
  if(failed)throw new DomainError('DEPENDENCY_UNAVAILABLE','Database startup connection warm-up failed.',503);
 }finally{for(const client of clients)client.release(failed);}
}
