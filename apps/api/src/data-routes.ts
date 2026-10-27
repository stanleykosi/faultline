import type {FastifyInstance,FastifyRequest} from 'fastify';
import multipart from '@fastify/multipart';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import * as captures from '../../../packages/core/src/captures/service.js';
import {queueMixAdjustment} from '../../../packages/core/src/captures/mix-adjustment.js';
import * as jobs from '../../../packages/core/src/jobs/service.js';
import {getTimeline} from '../../../packages/core/src/metrics/timeline-service.js';
import {storeBounded} from '../../../packages/core/src/storage/capacity.js';
import {objects} from '../../../packages/core/src/storage/objects.js';
import {transaction} from '../../../packages/database/src/client.js';
import {getCaseTx} from '../../../packages/core/src/cases/service.js';
import {demand} from '../../../packages/core/src/errors.js';
import {prepareDirectUpload,acceptDirectUpload} from '../../../packages/core/src/captures/direct-uploads.js';
type Transport={actor:(r:FastifyRequest)=>Promise<{id:string}>,key:(r:FastifyRequest)=>string,match:(r:FastifyRequest)=>string,data:(r:FastifyRequest,value:unknown)=>object};
export async function registerDataRoutes(app:FastifyInstance,t:Transport){
 await app.register(multipart,{limits:{fileSize:50*1024*1024,files:1,fields:2,parts:3,fieldSize:256}});
 const originalActor=t.actor;t={...t,actor:async r=>{for(const value of Object.values(r.params as Record<string,string>))demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),'INVALID_INPUT','Invalid resource identity.',400);return originalActor(r);}};
 const w=(r:FastifyRequest)=>(r.params as {workspaceId:string}).workspaceId,c=(r:FastifyRequest)=>(r.params as {caseId:string}).caseId;
 const param=(r:FastifyRequest,name:string)=>(r.params as Record<string,string>)[name]!;
 const base='/api/v1/workspaces/:workspaceId/cases/:caseId';
 app.get(base+'/upload-options',async r=>{const user=await t.actor(r);await transaction(w(r),tx=>getCaseTx(tx,w(r),user.id,c(r),true));return t.data(r,{mode:process.env.OBJECT_STORE==='supabase'?'direct':'multipart',max_bytes:50*1024*1024});});
 app.post(base+'/uploads',async(r,reply)=>{const user=await t.actor(r);reply.code(201);return t.data(r,await prepareDirectUpload(w(r),user.id,t.key(r),c(r),r.body));});
 app.post(base+'/uploads/accept',async(r,reply)=>{const user=await t.actor(r);t.key(r);const body=r.body as {token?:unknown};demand(body&&typeof body==='object'&&Object.keys(body).length===1&&typeof body.token==='string','INVALID_UPLOAD','Provide the upload receipt.',400);reply.code(201);return t.data(r,await acceptDirectUpload(w(r),user.id,c(r),body.token));});
 app.get(base+'/timeline',async r=>{const q=r.query as Record<string,unknown>;demand(Object.keys(q).every(k=>['from','to','source_kind','cursor','limit'].includes(k))&&Object.values(q).every(v=>typeof v==='string'),'INVALID_INPUT','Use only the declared timeline filters.',400);return t.data(r,await getTimeline(w(r),(await t.actor(r)).id,c(r),{from:q.from as string|undefined,to:q.to as string|undefined,source_kind:q.source_kind as string|undefined,cursor:q.cursor as string|undefined,limit:q.limit===undefined?undefined:Number(q.limit)}));});
 const asyncResult=(r:FastifyRequest,job:{job_id:string;status:string})=>t.data(r,{...job,events_url:'/api/v1/workspaces/'+w(r)+'/jobs/'+job.job_id+'/events',result_url:'/api/v1/workspaces/'+w(r)+'/jobs/'+job.job_id});
 app.post(base+'/imports',async(r,reply)=>{
  const user=await t.actor(r);t.key(r);await transaction(w(r),tx=>getCaseTx(tx,w(r),user.id,c(r),true));
  const fields:Record<string,string>={};let raw:null|{key:string;size_bytes:number}=null,format='',name='';
  for await(const part of r.parts()){
   if(part.type==='file'){
    demand(part.fieldname==='file'&&!raw,'INVALID_UPLOAD','Exactly one file named file is required.',400);
    name=part.filename;format=name.toLowerCase().endsWith('.jsonl.gz')?'gzip_jsonl':name.toLowerCase().split('.').at(-1)??'';
    demand(['csv','json','jsonl','gzip_jsonl'].includes(format),'UNSUPPORTED_FORMAT','Upload CSV, JSON, JSONL or gzip JSONL.',400);
    raw=await storeBounded(w(r),user.id,c(r),50*1024*1024,()=>objects.putStream(w(r),part.file));demand(!part.file.truncated,'BYTE_LIMIT','Upload exceeds policy.',413);
   }else{demand(['kind','source_id'].includes(part.fieldname)&&fields[part.fieldname]===undefined&&typeof part.value==='string','INVALID_UPLOAD','Unexpected or duplicate field.',400);fields[part.fieldname]=part.value;}
  }
  demand(raw&&fields.kind&&['analytics','support','release'].includes(fields.kind),'INVALID_UPLOAD','Provide a supported record kind and source file.',400);
  reply.code(201);return t.data(r,await captures.createImport(w(r),user.id,t.key(r),c(r),{kind:fields.kind,...(fields.source_id?{source_id:fields.source_id}:{}),format,name,raw_key:raw.key,raw_bytes:raw.size_bytes}));
 });
 app.get(base+'/imports/:importId',async r=>t.data(r,await captures.getImport(w(r),(await t.actor(r)).id,c(r),param(r,'importId'))));
 app.delete(base+'/imports/:importId',async(r,reply)=>{demand(r.body===undefined,'INVALID_INPUT','Discard has no request body.',400);await captures.discardImport(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'importId'),t.match(r));return reply.code(204).send();});
 app.post(base+'/imports/:importId/mappings',async r=>t.data(r,await captures.saveMapping(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'importId'),operationBody('saveImportMapping',r.body),t.match(r))));
 app.post(base+'/imports/:importId/preview',async r=>{const body=operationBody<{mapping_id:string}>('previewImport',r.body);return t.data(r,await captures.previewImport(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'importId'),body.mapping_id));});
 app.post(base+'/imports/:importId/commit',async(r,reply)=>{const result=await captures.queueCommit(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'importId'),operationBody('commitImport',r.body),t.match(r));reply.code(202);return asyncResult(r,result);});
 app.get(base+'/snapshots',async r=>({...t.data(r,await captures.listSnapshots(w(r),(await t.actor(r)).id,c(r))),page:{next_cursor:null}}));
 app.get(base+'/snapshots/:snapshotId',async r=>{const user=await t.actor(r);return t.data(r,await transaction(w(r),async tx=>{await getCaseTx(tx,w(r),user.id,c(r));return (await captures.snapshotTx(tx,w(r),c(r),param(r,'snapshotId'))).value;}));});
 app.post(base+'/snapshot-selections',async r=>t.data(r,await captures.selectSnapshots(w(r),(await t.actor(r)).id,t.key(r),c(r),operationBody('selectSnapshotRevision',r.body),t.match(r))));
 app.get(base+'/snapshots/:snapshotId/quality',async r=>t.data(r,await captures.snapshotQuality(w(r),(await t.actor(r)).id,c(r),param(r,'snapshotId'))));
 app.get(base+'/metrics',async r=>({...t.data(r,await captures.listMetrics(w(r),(await t.actor(r)).id,c(r))),page:{next_cursor:null}}));
 app.post(base+'/metrics',async(r,reply)=>{const body=operationBody<{metric:Parameters<typeof captures.createMetric>[4]}>('createMetricDraft',r.body);reply.code(201);return t.data(r,await captures.createMetric(w(r),(await t.actor(r)).id,t.key(r),c(r),body.metric));});
 app.post(base+'/metrics/:metricId/preview',async r=>{const body=operationBody<{snapshot_id:string}>('previewMetric',r.body);return t.data(r,await captures.metricPreview(w(r),(await t.actor(r)).id,c(r),param(r,'metricId'),body.snapshot_id));});
 app.post(base+'/metrics/:metricId/freeze',async r=>t.data(r,await captures.freezeMetric(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'metricId'),operationBody('freezeMetric',r.body),t.match(r))));
 app.post(base+'/comparisons',async(r,reply)=>{const body=operationBody<{revision_id:string}>('computeComparison',r.body),result=await captures.queueComparison(w(r),(await t.actor(r)).id,t.key(r),c(r),body.revision_id);reply.code(202);return asyncResult(r,result);});
 app.get(base+'/comparisons',async r=>{const user=await t.actor(r);return t.data(r,await transaction(w(r),async tx=>{const current=await getCaseTx(tx,w(r),user.id,c(r));return (await tx.query('SELECT id,revision_id,metric_hash,snapshot_hash,created_at FROM faultline.comparisons WHERE workspace_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 50',[w(r),c(r)])).rows.map(row=>({...row,freshness:row.revision_id===current.active_revision_id?'current_revision':'historical_revision'}));}));});
 app.get(base+'/comparisons/:comparisonId',async r=>t.data(r,await captures.getComparison(w(r),(await t.actor(r)).id,c(r),param(r,'comparisonId'))));
 app.post(base+'/comparisons/:comparisonId/mix-adjustments',async(r,reply)=>{const body=operationBody<{standard_population:'baseline'}>('computeMixAdjustment',r.body),result=await queueMixAdjustment(w(r),(await t.actor(r)).id,t.key(r),c(r),param(r,'comparisonId'),body);reply.code(202);return asyncResult(r,result);});
 app.get('/api/v1/workspaces/:workspaceId/jobs/:jobId',async r=>t.data(r,await jobs.getWorkspaceJob(w(r),(await t.actor(r)).id,param(r,'jobId'))));
 app.post('/api/v1/workspaces/:workspaceId/jobs/:jobId/cancel',async r=>{const user=await t.actor(r),job=await jobs.getWorkspaceJob(w(r),user.id,param(r,'jobId'));return t.data(r,await jobs.cancelJob(w(r),user.id,t.key(r),job.case_id,param(r,'jobId'),operationBody<{reason:string}>('cancelJob',r.body).reason,t.match(r)));});
 app.get('/api/v1/workspaces/:workspaceId/jobs/:jobId/events',async(r,reply)=>{
  const initial=String(r.headers['last-event-id']??'0');demand(/^[0-9]{1,18}$/.test(initial),'INVALID_CURSOR','Invalid event cursor.',400);
  const user=await t.actor(r);await jobs.getWorkspaceJob(w(r),user.id,param(r,'jobId'));
  reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','connection':'keep-alive'});
  let closed=false,after=initial;const end=Date.now()+30000;reply.raw.on('close',()=>{closed=true;});
  try{while(!closed&&Date.now()<end){
   const current=await t.actor(r),events=await jobs.jobEvents(w(r),current.id,param(r,'jobId'),after);
   for(const event of events){if(closed)break;reply.raw.write('id: '+event.seq+'\nevent: job\ndata: '+JSON.stringify({...event.event,created_at:event.created_at})+'\n\n');after=event.seq;}
   if(!events.length)reply.raw.write(': heartbeat\n\n');
   await new Promise(resolve=>setTimeout(resolve,1000));
  }}catch{if(!closed)reply.raw.write('event: access_closed\ndata: {}\n\n');}finally{reply.raw.end();}
 });

}

