import * as redaction from '../../../packages/core/src/privacy/service.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import * as privacy from '../../../packages/core/src/privacy/artifacts.js';
import {getCaseTx} from '../../../packages/core/src/cases/service.js';
import {transaction} from '../../../packages/database/src/client.js';
import {demand} from '../../../packages/core/src/errors.js';
type Transport={actor:(r:FastifyRequest)=>Promise<{id:string}>,key:(r:FastifyRequest)=>string,match:(r:FastifyRequest)=>string,data:(r:FastifyRequest,value:unknown)=>object};
export async function registerPrivacyRoutes(app:FastifyInstance,t:Transport){
 const params=(r:FastifyRequest)=>r.params as Record<string,string>,w=(r:FastifyRequest)=>params(r).workspaceId!,c=(r:FastifyRequest)=>params(r).caseId!,base='/api/v1/workspaces/:workspaceId/cases/:caseId';
 const actor=async(r:FastifyRequest)=>{for(const id of Object.values(params(r)))demand(/^[a-f0-9-]{36}$/i.test(id),'INVALID_INPUT','Invalid identity.',400);return (await t.actor(r)).id;};
 app.post(base+'/redaction-previews',async(r,reply)=>{const pid=await actor(r),job=await redaction.queueRedactionPreview(w(r),pid,t.key(r),c(r),operationBody('previewRedaction',r.body));reply.code(202);return t.data(r,job);});
 app.post(base+'/redactions',async(r,reply)=>{const pid=await actor(r),job=await redaction.queueRedactionApply(w(r),pid,t.key(r),c(r),operationBody('applyRedaction',r.body),t.match(r));reply.code(202);return t.data(r,job);});
 app.post(base+'/evidence-artifacts',async(r,reply)=>{const pid=await actor(r),key=t.key(r);await transaction(w(r),tx=>getCaseTx(tx,w(r),pid,c(r),true));const fields:Record<string,string>={};let bytes:Buffer|undefined,filename='';
 for await(const part of r.parts({limits:{files:1,fields:2,parts:3,fileSize:5*1024*1024,fieldSize:16000}})){if(part.type==='file'){demand(part.fieldname==='file'&&!bytes,'INVALID_UPLOAD','One evidence file is required.');filename=part.filename;bytes=await part.toBuffer();demand(!part.file.truncated,'BYTE_LIMIT','Evidence exceeds5MiB.',413);}else{demand(['description','related_evidence_ids'].includes(part.fieldname)&&!Object.hasOwn(fields,part.fieldname)&&typeof part.value==='string','INVALID_UPLOAD','Unexpected or duplicate evidence field.');fields[part.fieldname]=part.value;}}
 const description=fields.description;demand(bytes&&typeof description==='string'&&description.trim().length>0&&description.length<=2000,'INVALID_UPLOAD','Provide one file and bounded description.');let related:unknown;try{related=JSON.parse(fields.related_evidence_ids??'[]');}catch{demand(false,'INVALID_UPLOAD','Related evidence must be a JSON array.');}demand(Array.isArray(related)&&related.length<=100&&related.every(x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x)),'INVALID_UPLOAD','Related evidence must be a bounded identity array.');
 reply.code(201);return t.data(r,await privacy.uploadArtifact(w(r),pid,key,c(r),{filename,description:description!,related_evidence_ids:related as string[],bytes:bytes!}));});
 app.get(base+'/evidence-artifacts/:artifactId',async r=>t.data(r,await privacy.getArtifact(w(r),await actor(r),c(r),params(r).artifactId!)));
 app.get(base+'/evidence-artifacts/:artifactId/download',async(r,reply)=>{const artifact=await privacy.downloadArtifact(w(r),await actor(r),c(r),params(r).artifactId!);return reply.header('Content-Disposition','attachment; filename="'+artifact.filename+'"').type(artifact.media_type).send(artifact.bytes);});
 app.post(base+'/evidence-artifacts/:artifactId/derivatives',async(r,reply)=>{const pid=await actor(r),body=operationBody<{text:string;reason:string;policy_version:string}>('reviewEvidenceDerivative',r.body);reply.code(201);return t.data(r,await privacy.derivative(w(r),pid,t.key(r),c(r),params(r).artifactId!,body,t.match(r)));});
 app.post(base+'/evidence/:evidenceId/supersede',async r=>t.data(r,await privacy.supersede(w(r),await actor(r),t.key(r),c(r),params(r).evidenceId!,operationBody('supersedeEvidence',r.body),t.match(r))));
}
