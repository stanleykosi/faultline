import {resourceRevision} from './resource-revision.js';
import {serviceFailureDiagnostic} from './request-diagnostics.js';
import {installRequestWorkTracking} from './request-work.js';
import {identitySql} from '../../../packages/database/src/identity-schema.js';
import {registerProviderRoutes} from './provider-routes.js';
import {registerAgentRoutes} from './agent-routes.js';
import {registerPrivacyRoutes} from './privacy-routes.js';
import {registerExperimentRoutes} from './experiment-routes.js';
import {registerTargetRoutes} from './target-routes.js';
import {registerControlRoutes} from './control-routes.js';
import {registerInvestigationRoutes} from './investigation-routes.js';
import {registerDataRoutes} from './data-routes.js';
import {installExportMetadataDiagnostics} from './export-diagnostics.js';
import Fastify,{type FastifyRequest} from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fromNodeHeaders} from 'better-auth/node';
import {auth,enrollmentContext} from '../../../packages/core/src/identity/auth.js';
import {config} from '../../../packages/core/src/config.js';
import {csrf,byteHash} from '../../../packages/core/src/canonical.js';
import {DomainError,demand} from '../../../packages/core/src/errors.js';
import {pool,authPool,requireDatabase,transaction,verifyRuntimeRole,verifyAuthRuntimeRole} from '../../../packages/database/src/client.js';
import {verifyRuntimeSchema} from '../../../packages/database/src/runtime-schema.js';
import * as workspaces from '../../../packages/core/src/workspaces/service.js';
import * as cases from '../../../packages/core/src/cases/service.js';
import {objects} from '../../../packages/core/src/storage/objects.js';
const string=(maxLength=200)=>({type:'string',minLength:1,maxLength});
const object=(properties:object,required:string[]=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const uid={type:'string',format:'uuid'};
const scoped=object({workspaceId:uid});
const caseScoped=object({workspaceId:uid,caseId:uid});
function safeEqual(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export async function buildServer(){
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}},logger:{level:'warn',redact:['req.headers.cookie','req.headers.authorization','req.headers.x-csrf-token','req.body','res.headers.set-cookie']},bodyLimit:1024*1024,requestIdHeader:false,genReqId:()=>randomUUID()});
 installRequestWorkTracking(app);
 installExportMetadataDiagnostics(app);
 app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>done(null,body));
 app.setErrorHandler((error,request,reply)=>{
  const known=error instanceof DomainError;
  const validation=!!(error as {validation?:unknown}).validation;
  if(validation){const failure=error as {validationContext?:string;validation?:{instancePath:string;schemaPath:string;keyword:string}[]};request.log.warn({request_id:request.id,context:failure.validationContext,issues:failure.validation?.slice(0,8).map(({instancePath,schemaPath,keyword})=>({instancePath,schemaPath,keyword}))},'Request schema rejected');}
  const code=known?error.code:validation?'INVALID_INPUT':(error as {statusCode?:number}).statusCode===413?'BYTE_LIMIT':(error as {statusCode?:number}).statusCode===415?'UNSUPPORTED_MEDIA':'INTERNAL_ERROR';
  const parserStatus=(error as {statusCode?:number}).statusCode;
  const status=known?error.status:validation?400:parserStatus&&parserStatus>=400&&parserStatus<500?parserStatus:503;
  if(status>=500)request.log.error(serviceFailureDiagnostic(error,{domain:pool,auth:authPool},{request_id:request.id,route:request.routeOptions.url??'unmatched',elapsed_ms:reply.elapsedTime}),'Request service failure');
  reply.code(status).send({error:{code,message:known?error.message:validation?'Invalid request.':'A required service could not complete this request.',retryable:status===503,field_errors:[]},meta:{request_id:request.id}});
 });
 app.addHook('onSend',async (_request,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');reply.header('Cache-Control','no-store');return payload;});
 app.get('/health/live',async()=>({status:'alive',version:'0.1.0'}));
 app.get('/health/ready',async (_request,reply)=>{
  const components:{database:string;storage:string;worker:string;model:string;runner:string}={database:'unconfigured',storage:'unavailable',worker:'not_observed',model:config.modelProvider,runner:config.runnerMode};
  try{await objects.health();components.storage='ready';}catch{/* bounded component status */}
  if(pool)try{await verifyRuntimeRole();await verifyRuntimeSchema(pool);await pool.query('SELECT 1 FROM faultline.cases LIMIT 0');await verifyAuthRuntimeRole();components.database='ready';const hb=await pool.query("SELECT EXISTS(SELECT 1 FROM faultline.worker_heartbeats WHERE checked_at>now()-interval '30 seconds' AND version='0.1.0') AS healthy");if(hb.rows[0].healthy)components.worker='ready';}catch{components.database='unavailable';}
  const ready=components.database==='ready'&&components.storage==='ready'&&components.worker==='ready';reply.code(ready?200:503);return {status:ready?'ready':'not_ready',components};
 });
 function origin(request:FastifyRequest){demand(request.headers.origin===config.origin,'ORIGIN_DENIED','A trusted application origin is required.',403);}
 async function session(request:FastifyRequest,optional=false){
  if(!auth){if(optional)return null;throw new DomainError('DEPENDENCY_UNAVAILABLE','Authentication PostgreSQL is not configured.',503);}
  await verifyAuthRuntimeRole();
  const [result]=await Promise.all([auth.api.getSession({headers:fromNodeHeaders(request.headers)}),!optional&&pool?verifyRuntimeRole():Promise.resolve()]);
  if(!optional)demand(result,'SESSION_REQUIRED','Sign in to continue.',401);return result;
 }
 async function actor(request:FastifyRequest,options:{idempotencyRequired?:boolean}={}){
  const result=await session(request);demand(result,'SESSION_REQUIRED','Sign in to continue.',401);
  if(!['GET','HEAD'].includes(request.method)){origin(request);const token=request.headers['x-csrf-token'];demand(typeof token==='string'&&safeEqual(token,csrf(config.authSecret,result.session.id)),'CSRF_DENIED','Refresh your session before retrying.',403);if(options.idempotencyRequired!==false)demand(typeof request.headers['idempotency-key']==='string','IDEMPOTENCY_REQUIRED','Provide an Idempotency-Key.',400);}
  return result.user;
 }
 const key=(r:FastifyRequest)=>{const value=String(r.headers['idempotency-key']??'');demand(value.length>=8&&value.length<=160,'IDEMPOTENCY_REQUIRED','Provide an Idempotency-Key.',400);return value;};
 const match=(r:FastifyRequest)=>resourceRevision(r.headers);
 const ws=(r:FastifyRequest)=>(r.params as {workspaceId:string}).workspaceId;
 const cid=(r:FastifyRequest)=>(r.params as {caseId:string}).caseId;
 const data=(r:FastifyRequest,value:unknown)=>({data:value,meta:{request_id:r.id}});
 const list=(r:FastifyRequest,value:unknown[])=>({...data(r,value),page:{next_cursor:null}});
 app.route({method:['GET','POST'],url:'/api/auth/*',handler:async(request,reply)=>{
  demand(auth,'DEPENDENCY_UNAVAILABLE','Authentication PostgreSQL is not configured.',503);
  await verifyAuthRuntimeRole();
  if(request.method==='POST')origin(request);
  let response:Response;
  if(request.url.split('?')[0]==='/api/auth/sign-up/email'){
   const cookie=request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('faultline.pending='))?.slice('faultline.pending='.length);
   demand(!cookie||cookie.length<100,'ENROLLMENT_REQUIRED','Invitation capability is invalid.',403);
   const body=(typeof request.body==='string'?Object.fromEntries(new URLSearchParams(request.body)):request.body) as {email?:unknown;name?:unknown;password?:unknown;workspace_name?:unknown};
   demand(typeof body?.email==='string'&&body.email.length<=254,'INVALID_INPUT','Provide a valid email address.',400);
   let permission:{hash:string;email:string};
   const publicSignup=typeof body.workspace_name==='string';
   if(cookie&&!publicSignup){
    demand(authPool,'DEPENDENCY_UNAVAILABLE','Authentication database unavailable.',503);
    const pending=(await authPool.query(identitySql('SELECT * FROM auth.pending_enrollment($1)'),[byteHash(cookie)])).rows[0];
    demand(pending,'ENROLLMENT_REQUIRED','Invitation capability is expired or consumed.',403);
    demand(body.email.toLowerCase()===pending.intended_email.toLowerCase(),'IDENTITY_MISMATCH','Use the invited identity.',403);
    permission={hash:byteHash(cookie),email:pending.intended_email};
   }else{
    demand(config.publicSignupEnabled,'SIGNUP_DISABLED','Public account creation is not enabled for this installation.',403);
    await verifyRuntimeRole();
    const name=typeof body.name==='string'?body.name.trim():'';
    const workspaceName=typeof body.workspace_name==='string'?body.workspace_name.trim():name?name+' workspace':'';
    demand(name.length>=1&&name.length<=200,'INVALID_INPUT','Provide your name.',400);
    demand(workspaceName.length>=1&&workspaceName.length<=200,'INVALID_INPUT','Provide a workspace name.',400);
    const capabilityHash=byteHash(randomBytes(32));
    try{await requireDatabase().query('SELECT * FROM faultline.prepare_public_signup($1,$2,$3,$4)',[capabilityHash,body.email,randomUUID(),workspaceName]);}
    catch(error){
     if(error&&typeof error==='object'&&'message' in error&&String(error.message).includes('Account already exists'))throw new DomainError('ACCOUNT_EXISTS','An account already exists for this email. Sign in instead.',409);
     throw error;
    }
    permission={hash:capabilityHash,email:body.email};
   }
   const headers=fromNodeHeaders(request.headers);headers.delete('content-length');headers.set('content-type','application/json');
   const req=new Request(new URL(request.url,config.origin),{method:request.method,headers,body:JSON.stringify({email:body.email,name:body.name,password:body.password})});
   try{response=await enrollmentContext.run(permission,()=>auth!.handler(req));}
   catch(error){if(publicSignup)await requireDatabase().query('SELECT faultline.cancel_public_signup($1)',[permission.hash]).catch(()=>{});throw error;}
   if(publicSignup&&!response.ok)await requireDatabase().query('SELECT faultline.cancel_public_signup($1)',[permission.hash]).catch(()=>{});
  }else{
   const req=new Request(new URL(request.url,config.origin),{method:request.method,headers:fromNodeHeaders(request.headers),...(request.body?{body:typeof request.body==='string'?request.body:JSON.stringify(request.body)}:{})});
   response=await auth.handler(req);
  }
  response.headers.forEach((value,name)=>{if(name.toLowerCase()!=='set-cookie')reply.header(name,value);});
  const cookies=response.headers.getSetCookie();
  if(request.url.split('?')[0]==='/api/auth/sign-up/email'&&response.ok)cookies.push('faultline.pending=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'+(config.production?'; Secure':''));
  if(cookies.length)reply.header('set-cookie',cookies);
  reply.code(response.status);return response.body?await response.text():null;
 }});
 app.get('/api/v1/session',async r=>{const s=await session(r);demand(s,'SESSION_REQUIRED','Sign in to continue.',401);return data(r,{user:{id:s.user.id,email:s.user.email,name:s.user.name},csrf_token:csrf(config.authSecret,s.session.id)});});
 app.get('/api/v1/workspaces',async r=>list(r,await workspaces.listWorkspaces((await actor(r)).id)));
 app.post('/api/v1/workspaces',{schema:{body:object({name:string(200)})}},async(r,reply)=>{reply.code(201);return data(r,await workspaces.createWorkspace(await actor(r),(r.body as {name:string}).name,key(r)));});
 app.get('/api/v1/workspaces/:workspaceId',{schema:{params:scoped}},async r=>data(r,await workspaces.getWorkspace(ws(r),(await actor(r)).id)));
 app.patch('/api/v1/workspaces/:workspaceId',{schema:{params:scoped,body:object({name:string(200)})}},async r=>data(r,await workspaces.renameWorkspace(ws(r),(await actor(r)).id,key(r),(r.body as {name:string}).name,match(r))));
 app.get('/api/v1/workspaces/:workspaceId/cases',{schema:{params:scoped,querystring:object({q:{type:'string',maxLength:200},lifecycle:{enum:['open','closed']},archived:{enum:['true','false']},cursor:{type:'string',maxLength:1000},limit:{type:'string',pattern:'^[0-9]{1,3}$'}},[])}},async r=>{const query=r.query as {q?:string;archived?:string;lifecycle?:string;cursor?:string;limit?:string};const result=await cases.listCases(ws(r),(await actor(r)).id,{...query,limit:query.limit?Number(query.limit):50});return {...data(r,result.data),page:result.page};});
 const caseProps={title:string(200),question:string(2000),affected_flow:string(2000)};
 app.post('/api/v1/workspaces/:workspaceId/cases',{schema:{params:scoped,body:object(caseProps,['title','question'])}},async(r,reply)=>{reply.code(201);return data(r,await cases.createCase(ws(r),(await actor(r)).id,key(r),r.body as cases.CaseInput));});
 app.get('/api/v1/workspaces/:workspaceId/cases/:caseId',{schema:{params:caseScoped}},async r=>data(r,await cases.getCase(ws(r),(await actor(r)).id,cid(r))));
 app.patch('/api/v1/workspaces/:workspaceId/cases/:caseId',{schema:{params:caseScoped,body:{...object(caseProps,[]),minProperties:1}}},async r=>data(r,await cases.updateCase(ws(r),(await actor(r)).id,key(r),cid(r),r.body as Partial<cases.CaseInput>,match(r))));
 app.post('/api/v1/workspaces/:workspaceId/cases/:caseId/archive',{schema:{params:caseScoped,body:object({archived:{type:'boolean'}})}},async r=>data(r,await cases.archiveCase(ws(r),(await actor(r)).id,key(r),cid(r),(r.body as {archived:boolean}).archived,match(r))));
 app.get('/api/v1/workspaces/:workspaceId/members',{schema:{params:scoped}},async r=>{const user=await actor(r);await transaction(ws(r),tx=>workspaces.access(tx,ws(r),user.id,['owner']));return list(r,(await requireDatabase().query('SELECT * FROM faultline.member_summary($1,$2)',[ws(r),user.id])).rows);});
 app.post('/api/v1/workspaces/:workspaceId/invitations',{schema:{params:scoped,body:object({intended_email:{type:'string',format:'email',maxLength:254},role:{enum:['analyst','viewer']},expires_at:{type:'string',format:'date-time'}})}},async(r,reply)=>{reply.code(201);return data(r,await workspaces.invite(ws(r),(await actor(r)).id,key(r),r.body as {intended_email:string;role:'analyst'|'viewer';expires_at:string}));});
 app.post('/api/v1/invitations/claim',{schema:{body:object({token:string(100)})}},async(r,reply)=>{
  origin(r);await verifyRuntimeRole();demand(key(r).length>=8&&key(r).length<=160,'IDEMPOTENCY_REQUIRED','Provide an Idempotency-Key.',400);
  const s=await session(r,true);if(s)await actor(r);
  const result=await workspaces.claimInvitation((r.body as {token:string}).token,s?.user??null,key(r));
  if('capability' in result){reply.header('set-cookie','faultline.pending='+result.capability+'; Max-Age=600; Path=/; HttpOnly; SameSite=Lax'+(config.production?'; Secure':''));const {capability,...safe}=result;return data(r,safe);}
  return data(r,result);
 });
 app.delete('/api/v1/workspaces/:workspaceId/invitations/:invitationId',{schema:{params:object({workspaceId:uid,invitationId:uid})}},async(r,reply)=>{await workspaces.revokeInvite(ws(r),(await actor(r)).id,key(r),(r.params as {invitationId:string}).invitationId,match(r));return reply.code(204).send();});
 const memberParams=object({workspaceId:uid,memberId:string(128)});
 app.patch('/api/v1/workspaces/:workspaceId/members/:memberId',{schema:{params:memberParams,body:object({role:{enum:['owner','analyst','viewer']}})}},async r=>data(r,await workspaces.changeMember(ws(r),(await actor(r)).id,key(r),(r.params as {memberId:string}).memberId,(r.body as {role:workspaces.Role}).role,match(r))));
 app.delete('/api/v1/workspaces/:workspaceId/members/:memberId',{schema:{params:memberParams}},async(r,reply)=>{await workspaces.changeMember(ws(r),(await actor(r)).id,key(r),(r.params as {memberId:string}).memberId,null,match(r));return reply.code(204).send();});
 app.post('/api/v1/workspaces/:workspaceId/owner-transfer',{schema:{params:scoped,body:object({member_id:string(128)})}},async r=>data(r,await workspaces.changeMember(ws(r),(await actor(r)).id,key(r),(r.body as {member_id:string}).member_id,'owner',match(r),true)));
 if(process.env.FAULTLINE_DOWNLOAD_TRACE==='true')app.addHook('onResponse',async(r,reply)=>{if(r.method==='GET'&&/^\/api\/v1\/workspaces\/[a-f0-9-]{36}\/cases\/[a-f0-9-]{36}\/exports\/[a-f0-9-]{36}$/.test(r.url))console.log(JSON.stringify({diagnostic:'authenticated_export_response',request_id:r.id,path:r.url,status:reply.statusCode}));});
 await registerInvestigationRoutes(app,{actor,key,match,data});
 await registerDataRoutes(app,{actor,key,match,data});
 await registerPrivacyRoutes(app,{actor,key,match,data});
 await registerControlRoutes(app,{actor,key,match,data});
 await registerProviderRoutes(app,{actor,key,match,data});
 await registerAgentRoutes(app,{actor,key,match,data});
 await registerExperimentRoutes(app,{actor,key,match,data});
 await registerTargetRoutes(app,{actor,key,match,data});
 if(process.env.FAULTLINE_HOSTING_PROFILE!=='vercel-supabase'&&await fs.stat(path.resolve('dist/web')).then(()=>true).catch(()=>false)){
  await app.register(fastifyStatic,{root:path.resolve('dist/web'),wildcard:false});
  app.setNotFoundHandler((request,reply)=>{if(request.url.startsWith('/api/')||request.url.startsWith('/health/')||request.url.startsWith('/assets/'))return reply.code(404).send({error:{code:'NOT_FOUND',message:'Operation unavailable.',retryable:false,field_errors:[]},meta:{request_id:request.id}});return reply.type('text/html').sendFile('index.html');});
 }
 return app;
}
