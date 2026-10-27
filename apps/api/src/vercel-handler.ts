import type {IncomingMessage,ServerResponse} from 'node:http';
import type {FastifyInstance} from 'fastify';
import {drainRequestWork} from './request-work.js';

/** The invocation stays alive through async replies, streams, and early client disconnects. */
export function createVercelHandler(initialize:()=>Promise<FastifyInstance>){
 let ready:Promise<FastifyInstance>|undefined;
 return async function handler(request:IncomingMessage,response:ServerResponse){
  if((request.method==='GET'||request.method==='HEAD')&&request.url?.split('?')[0]==='/health/live'){
   response.statusCode=200;response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');
   response.end(request.method==='HEAD'?undefined:JSON.stringify({status:'alive'}));
   return;
  }
  try{
   const app=await(ready??=initialize().catch(error=>{ready=undefined;throw error;}));
   // A cold initialization may outlive its client. Do not dispatch onto a closed response.
   if(response.destroyed||response.writableFinished)return;
   try{await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{response.off('finish',finish);response.off('close',finish);response.off('error',fail);};
    const finish=()=>{cleanup();resolve();},fail=(error:Error)=>{cleanup();reject(error);};
    response.once('finish',finish);response.once('close',finish);response.once('error',fail);
    app.server.emit('request',request,response);
   });}finally{await drainRequestWork(request);}
  }catch{
   if(response.headersSent||response.destroyed)return;
   response.statusCode=503;response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');
   response.end(JSON.stringify({error:{code:'DEPENDENCY_UNAVAILABLE',message:'Faultline is not ready. Check hosting configuration.',retryable:true,field_errors:[]}}));
  }
 };
}
