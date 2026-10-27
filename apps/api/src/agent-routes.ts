import type {FastifyInstance,FastifyRequest} from 'fastify';
import {operationBody} from '../../../packages/contracts/src/transport.js';
import {demand} from '../../../packages/core/src/errors.js';
import * as agent from '../../../packages/core/src/agent/service.js';
import * as memory from '../../../packages/core/src/agent/memory.js';

type Transport={actor:(request:FastifyRequest)=>Promise<{id:string}>,key:(request:FastifyRequest)=>string,match:(request:FastifyRequest)=>string,data:(request:FastifyRequest,value:unknown)=>object};

export async function registerAgentRoutes(app:FastifyInstance,t:Transport){
 const params=(request:FastifyRequest)=>request.params as Record<string,string>;
 const ids=(request:FastifyRequest)=>{const value=params(request);for(const id of Object.values(value))demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),'INVALID_INPUT','Invalid identity.',400);return value;};
 const base='/api/v1/workspaces/:workspaceId/cases/:caseId/agent';
 app.get(base,async request=>{const p=ids(request);return t.data(request,await agent.getAgentWorkspace(p.workspaceId!, (await t.actor(request)).id,p.caseId!));});
 app.post(base+'/sessions',async(request,reply)=>{const p=ids(request),input=operationBody<agent.CreateAgentSessionInput>('createAgentSession',request.body);reply.code(202);return t.data(request,await agent.createAgentSession(p.workspaceId!, (await t.actor(request)).id,t.key(request),p.caseId!,input));});
 app.post(base+'/sessions/:sessionId/turns',async(request,reply)=>{const p=ids(request),input=operationBody<agent.CreateAgentTurnInput>('createAgentTurn',request.body);reply.code(202);return t.data(request,await agent.createAgentTurn(p.workspaceId!, (await t.actor(request)).id,t.key(request),p.caseId!,p.sessionId!,input));});
 app.post(base+'/actions/:actionId/approve',async request=>{const p=ids(request);operationBody<{reviewed:true}>('approveAgentAction',request.body);return t.data(request,await agent.approveAgentAction(p.workspaceId!, (await t.actor(request)).id,t.key(request),p.caseId!,p.actionId!,t.match(request)));});
 app.post(base+'/actions/:actionId/dismiss',async request=>{const p=ids(request),input=operationBody<{reason:string}>('dismissAgentAction',request.body);return t.data(request,await agent.dismissAgentAction(p.workspaceId!, (await t.actor(request)).id,t.key(request),p.caseId!,p.actionId!,input.reason,t.match(request)));});
 app.get(base+'/memory',async request=>{const p=ids(request);return t.data(request,await memory.listReportMemory(p.workspaceId!,(await t.actor(request)).id,p.caseId!));});
 app.post(base+'/memory',async(request,reply)=>{const p=ids(request),input=operationBody<memory.SaveReportMemoryInput>('saveReportMemory',request.body);reply.code(201);return t.data(request,await memory.saveReportMemory(p.workspaceId!,(await t.actor(request)).id,t.key(request),p.caseId!,input));});
 app.post(base+'/memory/:capsuleId/withdraw',async request=>{const p=ids(request),input=operationBody<{reason:string}>('withdrawReportMemory',request.body);return t.data(request,await memory.withdrawReportMemory(p.workspaceId!,(await t.actor(request)).id,t.key(request),p.caseId!,p.capsuleId!,input.reason,t.match(request)));});
 app.post(base+'/memory/retrievals/:retrievalId/capsules/:capsuleId/feedback',async request=>{const p=ids(request),input=operationBody<{kind:memory.MemoryFeedbackKind}>('recordMemoryFeedback',request.body);return t.data(request,await memory.recordMemoryFeedback(p.workspaceId!,(await t.actor(request)).id,t.key(request),p.caseId!,p.retrievalId!,p.capsuleId!,input.kind));});
}
