import type {FastifyInstance,FastifyRequest} from 'fastify';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import * as targets from '../../../packages/core/src/targets/service.js';
import type {FaultlineBuildAttestation} from '../../../packages/contracts/src/generated.js';
import {demand} from '../../../packages/core/src/errors.js';
type Transport={actor:(r:FastifyRequest)=>Promise<{id:string}>,key:(r:FastifyRequest)=>string,match:(r:FastifyRequest)=>string,data:(r:FastifyRequest,value:unknown)=>object};
export async function registerTargetRoutes(app:FastifyInstance,t:Transport){
 const params=(r:FastifyRequest)=>r.params as Record<string,string>,wid=(r:FastifyRequest)=>params(r).workspaceId!,cid=(r:FastifyRequest)=>params(r).caseId!,workspace='/api/v1/workspaces/:workspaceId',base=workspace+'/cases/:caseId';
 const user=async(r:FastifyRequest)=>{for(const [name,value] of Object.entries(params(r)))demand(name==='workspaceId'||name==='caseId'?/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value):/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value),'INVALID_INPUT','Invalid scoped staging identity.',400);demand(Object.keys(r.query??{}).length===0,'INVALID_INPUT','This finite catalog has no query fields.',400);return (await t.actor(r)).id;};
 app.get(workspace+'/target-grants',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'grant')));
 app.post(workspace+'/target-grants',async(r,reply)=>{const pid=await user(r),body=operationBody<Parameters<typeof targets.createWorkspaceGrant>[3]>('createTargetGrant',r.body);reply.code(201);return t.data(r,await targets.createWorkspaceGrant(wid(r),pid,t.key(r),body));});
 app.post(workspace+'/target-grants/:grantId/revoke',async r=>{const pid=await user(r),body=operationBody<{reason:string}>('revokeTargetGrant',r.body);return t.data(r,await targets.revokeWorkspaceGrant(wid(r),pid,t.key(r),params(r).grantId!,body,t.match(r)));});
 app.get(workspace+'/runner-profiles',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'runner')));
 app.post(workspace+'/runner-profiles/:runnerId/probe',async(r,reply)=>{const pid=await user(r);operationBody('probeRunnerProfile',r.body);reply.code(202);return t.data(r,await targets.queueRunnerProbe(wid(r),pid,t.key(r),params(r).runnerId!));});
 app.get(workspace+'/environment-profiles',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'environment')));
 app.get(base+'/fixture-profiles',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'fixture',cid(r))));
 app.post(base+'/fixture-profiles',async(r,reply)=>{const pid=await user(r),body=operationBody<targets.FixtureInput>('createFixtureProfile',r.body);reply.code(201);return t.data(r,await targets.createFixtureProfile(wid(r),pid,t.key(r),cid(r),body));});
 app.get(base+'/observation-profiles',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'observation',cid(r))));
 app.post(base+'/observation-profiles',async(r,reply)=>{const pid=await user(r),body=operationBody<targets.ObservationInput>('createObservationProfile',r.body);reply.code(201);return t.data(r,await targets.createObservationProfile(wid(r),pid,t.key(r),cid(r),body));});
 app.get(base+'/build-attestations',async r=>t.data(r,await targets.listCatalog(wid(r),await user(r),'build',cid(r))));
 app.post(base+'/build-attestations',async r=>{const pid=await user(r),body=operationBody<{attestation:FaultlineBuildAttestation}>('importBuildAttestation',r.body);return t.data(r,await targets.importBuildAttestation(wid(r),pid,t.key(r),cid(r),body));});
 app.get(base+'/build-attestations/:buildId',async r=>{const rows=await targets.listCatalog(wid(r),await user(r),'build',cid(r)),row=rows.find(value=>value.id===params(r).buildId);demand(row,'NOT_FOUND','Deployment metadata unavailable.',404);return t.data(r,row);});
}
