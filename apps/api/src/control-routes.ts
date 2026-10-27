import * as policyRetention from '../../../packages/core/src/retention/policy.js';
import * as replacements from '../../../packages/core/src/secrets/replacements.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import * as controls from '../../../packages/core/src/controls/service.js';
import {extendRevisionBudget} from '../../../packages/core/src/budgets/service.js';
import {operationSelection} from '../../../packages/core/src/preflight/service.js';
import * as jobs from '../../../packages/core/src/jobs/service.js';
import {disposition} from '../../../packages/core/src/cases/service.js';
import {demand} from '../../../packages/core/src/errors.js';
type ActorOptions={idempotencyRequired?:boolean};
type Transport={actor:(r:FastifyRequest,options?:ActorOptions)=>Promise<{id:string}>,key:(r:FastifyRequest)=>string,match:(r:FastifyRequest)=>string,data:(r:FastifyRequest,value:unknown)=>object};
export async function registerControlRoutes(app:FastifyInstance,t:Transport){
 const original=t.actor;t={...t,actor:async(r,options)=>{for(const value of Object.values(r.params as Record<string,string>))demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),'INVALID_INPUT','Invalid identity.',400);return original(r,options);}};
 const p=(r:FastifyRequest)=>r.params as Record<string,string>,w=(r:FastifyRequest)=>p(r).workspaceId!,c=(r:FastifyRequest)=>p(r).caseId!,id=(r:FastifyRequest)=>Object.values(p(r)).at(-1)!,root='/api/v1/workspaces/:workspaceId';
 app.post(root+'/cases/:caseId/close',async r=>t.data(r,await disposition(w(r),(await t.actor(r)).id,t.key(r),c(r),operationBody('closeCase',r.body),t.match(r))));
 app.post(root+'/cases/:caseId/reopen',async r=>t.data(r,await disposition(w(r),(await t.actor(r)).id,t.key(r),c(r),operationBody('reopenCase',r.body),t.match(r),true)));
 app.get(root+'/jobs',async r=>({...t.data(r,await jobs.listJobs(w(r),(await t.actor(r)).id)),page:{next_cursor:null}}));
 app.post(root+'/jobs/:jobId/retry',async r=>{operationBody('retryJob',r.body);return t.data(r,await jobs.restartJob(w(r),(await t.actor(r)).id,t.key(r),id(r),t.match(r),'retry'));});
 app.post(root+'/jobs/:jobId/resume',async r=>t.data(r,await jobs.restartJob(w(r),(await t.actor(r)).id,t.key(r),id(r),t.match(r),'resume',operationBody<{prerequisite_ids:string[]}>('resumeJob',r.body).prerequisite_ids)));
 app.get(root+'/budgets',async r=>t.data(r,await controls.budgets(w(r),(await t.actor(r)).id)));
 app.post(root+'/cases/:caseId/revisions/:revisionId/budget-extensions',async r=>t.data(r,await extendRevisionBudget(w(r),(await t.actor(r)).id,t.key(r),c(r),p(r).revisionId!,operationBody('extendRevisionBudget',r.body),t.match(r))));
 app.get(root+'/cases/:caseId/preflight',async r=>t.data(r,await controls.preflight(w(r),(await t.actor(r)).id,c(r),operationSelection(r.query))));
 app.get(root+'/activity',async r=>{const user=await t.actor(r),result=await controls.activity(w(r),user.id,{...(r.query as {cursor?:string}),limit:(r.query as {limit?:string}).limit===undefined?undefined:Number((r.query as {limit?:string}).limit)});return {...t.data(r,result.data),page:result.page};});
 app.get(root+'/audit',async r=>{const user=await t.actor(r),result=await controls.activity(w(r),user.id,{...(r.query as {cursor?:string;operation?:string}),limit:(r.query as {limit?:string}).limit===undefined?undefined:Number((r.query as {limit?:string}).limit)},true);return {...t.data(r,result.data),page:result.page};});
 app.post(root+'/notifications/:notificationId/read',async r=>{operationBody('markNotificationRead',r.body);return t.data(r,await controls.markRead(w(r),(await t.actor(r)).id,t.key(r),id(r)));});
 for(const [path,privacy]of [['policy',false],['privacy-policy',true]] as const){app.get(root+'/'+path,async r=>t.data(r,await controls.getPolicy(w(r),(await t.actor(r)).id,privacy)));app.patch(root+'/'+path,async r=>t.data(r,await controls.updatePolicy(w(r),(await t.actor(r)).id,t.key(r),operationBody(privacy?'setPrivacyPolicy':'updateWorkspacePolicy',r.body),t.match(r),privacy)));}
 app.post(root+'/policy/retention-preview',async r=>{const input=operationBody<{patch:Record<string,unknown>;effective_at?:string}>('previewPolicyRetention',r.body);return t.data(r,await policyRetention.previewPolicyRetention(w(r),(await t.actor(r,{idempotencyRequired:false})).id,input.patch,{effective_at:input.effective_at}));});
 app.get(root+'/policy/retention/:retentionId',async r=>t.data(r,await policyRetention.getPolicyRetention(w(r),(await t.actor(r)).id,id(r))));
 app.post(root+'/policy/retention/:retentionId/resume',async r=>{operationBody('resumePolicyRetention',r.body);return t.data(r,await policyRetention.resumePolicyRetention(w(r),(await t.actor(r)).id,t.key(r),id(r),t.match(r)));});
 app.post(root+'/secrets/:secretId/replacements',async r=>t.data(r,await replacements.stageSecretReplacement(w(r),(await t.actor(r)).id,t.key(r),p(r).secretId!,operationBody<{value:string}>('stageSecretReplacement',r.body).value,t.match(r))));
 app.get(root+'/secrets/:secretId/replacements/:replacementId',async r=>t.data(r,await replacements.getSecretReplacement(w(r),(await t.actor(r)).id,p(r).secretId!,p(r).replacementId!)));
 app.post(root+'/secrets/:secretId/replacements/:replacementId/probe',async r=>{operationBody('probeSecretReplacement',r.body);return t.data(r,await replacements.probeSecretReplacement(w(r),(await t.actor(r)).id,t.key(r),p(r).secretId!,p(r).replacementId!,t.match(r)));});
 app.post(root+'/secrets/:secretId/replacements/:replacementId/activate',async r=>t.data(r,await replacements.activateSecretReplacement(w(r),(await t.actor(r)).id,t.key(r),p(r).secretId!,p(r).replacementId!,operationBody<{acknowledged_binding_hash:string}>('activateSecretReplacement',r.body),t.match(r))));
 app.post(root+'/secrets/:secretId/rotate',async r=>t.data(r,await controls.rotateSecret(w(r),(await t.actor(r)).id,t.key(r),id(r),operationBody<{value:string}>('rotateSecret',r.body).value,t.match(r))));
 app.post(root+'/secrets/:secretId/revoke',async r=>t.data(r,await controls.revokeSecret(w(r),(await t.actor(r)).id,t.key(r),id(r),operationBody<{cancel_dependent_jobs:boolean}>('revokeSecret',r.body).cancel_dependent_jobs,t.match(r))));
}
