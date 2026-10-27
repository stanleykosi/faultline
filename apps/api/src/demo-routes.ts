import type {FastifyInstance,FastifyRequest} from 'fastify';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import {config} from '../../../packages/core/src/config.js';
import {createDemoCase,resetDemoCase} from '../../../packages/core/src/demo/service.js';
import type {DemoFixture} from '../../../packages/core/src/demo/domain.js';
import {demand} from '../../../packages/core/src/errors.js';

type Transport={actor:(r:FastifyRequest)=>Promise<{id:string}>,key:(r:FastifyRequest)=>string,match:(r:FastifyRequest)=>string,data:(r:FastifyRequest,value:unknown)=>object};
export async function registerDemoRoutes(app:FastifyInstance,t:Transport){
 const workspace=(r:FastifyRequest)=>(r.params as {workspaceId:string}).workspaceId;
 const caseId=(r:FastifyRequest)=>(r.params as {caseId:string}).caseId;
 app.post('/api/v1/workspaces/:workspaceId/demo-cases',async(r,reply)=>{
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspace(r)),'INVALID_INPUT','Invalid workspace identity.',400);
  const user=await t.actor(r),input=operationBody<{fixture:DemoFixture}>('createDemoCase',r.body);
  const result=await createDemoCase(workspace(r),user.id,t.key(r),input.fixture,{production:config.production,runnerMode:config.runnerMode});
  reply.code(202);return t.data(r,{...result,events_url:`/api/v1/workspaces/${workspace(r)}/jobs/${result.job_id}/events`,result_url:`/api/v1/workspaces/${workspace(r)}/jobs/${result.job_id}`});
 });
 app.post('/api/v1/workspaces/:workspaceId/cases/:caseId/demo-reset',async r=>{
  const user=await t.actor(r),input=operationBody<{fixture:DemoFixture;confirmation:'reset synthetic case'}>('resetDemoCase',r.body);
  for(const value of Object.values(r.params as Record<string,string>))demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),'INVALID_INPUT','Invalid resource identity.',400);
  return t.data(r,await resetDemoCase(workspace(r),user.id,t.key(r),caseId(r),input,t.match(r),{production:config.production,runnerMode:config.runnerMode}));
 });
}
