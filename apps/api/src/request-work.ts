import type {IncomingMessage} from 'node:http';
import type {FastifyInstance} from 'fastify';

const work=new WeakMap<IncomingMessage,Set<Promise<unknown>>>();

/** The host must keep aborted invocations alive until an async route releases its resources. */
export function installRequestWorkTracking(app:FastifyInstance){
 app.addHook('onRoute',route=>{
  const handler=route.handler;
  route.handler=function(request,reply){
   const result=handler.call(this,request,reply);
   if(result&&typeof (result as Promise<unknown>).then==='function'){
    let pending=work.get(request.raw);if(!pending){pending=new Set();work.set(request.raw,pending);}
    const tracked=Promise.resolve(result),entries=pending;entries.add(tracked);
    const settled=()=>{entries.delete(tracked);if(!entries.size)work.delete(request.raw);};
    void tracked.then(settled,settled);
   }
   return result;
  };
 });
}

export async function drainRequestWork(request:IncomingMessage){
 let pending=work.get(request);
 while(pending?.size){await Promise.allSettled([...pending]);pending=work.get(request);}
}
