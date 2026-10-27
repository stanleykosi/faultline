import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {buildServer} from '../../apps/api/src/server.js';
import {pool,authPool,transaction,verifyRuntimeRole,verifyAuthRuntimeRole} from '../../packages/database/src/client.js';
import {auth} from '../../packages/core/src/identity/auth.js';
const development=JSON.parse(await fs.readFile('.runtime/development-config.json','utf8'));
assert.ok(process.env.DATABASE_URL?.includes('127.0.0.1:'+development.port+'/faultline'),'Dedicated local development database required');
assert.ok(process.env.MIGRATION_DATABASE_URL,'Operator pool required only in this isolated test process');
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL}),app=await buildServer();
const origin='http://localhost:3000';
type User={cookie:string;csrf:string;id:string;email:string};
function cookies(response:{headers:Record<string,unknown>}):string{const values=response.headers['set-cookie'];return (Array.isArray(values)?values:[values]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');}
async function login(email:string,password:string):Promise<User>{
 const response=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});
 assert.equal(response.statusCode,200,response.body);const cookie=cookies(response),session=await app.inject({url:'/api/v1/session',headers:{cookie}});assert.equal(session.statusCode,200,session.body);return {cookie,csrf:session.json().data.csrf_token,id:session.json().data.user.id,email};
}
async function call(user:User|null,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,key=randomUUID(),revision?:number){
 return app.inject({method,url,headers:{origin,...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),'idempotency-key':key,...(payload===undefined?{}:{'content-type':'application/json'}),...(revision===undefined?{}:{'if-match':String(revision)})},...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
}
const owner=await login(development.ownerEmail,development.ownerPassword),tag=randomUUID().slice(0,8);
const alpha=(await call(owner,'POST','/api/v1/workspaces',{name:'Alpha '+tag})).json().data;
const beta=(await call(owner,'POST','/api/v1/workspaces',{name:'Beta '+tag})).json().data;
const root=(wid:string)=>'/api/v1/workspaces/'+wid;
async function newInvited(email:string,role='viewer',wid=alpha.id){
 const invitation=await call(owner,'POST',root(wid)+'/invitations',{intended_email:email,role,expires_at:new Date(Date.now()+3600000).toISOString()});
 assert.equal(invitation.statusCode,201,invitation.body);const value=invitation.json().data,key=randomUUID();
 const pending=await call(null,'POST','/api/v1/invitations/claim',{token:value.token},key);assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().data.status,'enrollment_required');
 const repeated=await call(null,'POST','/api/v1/invitations/claim',{token:value.token},key);assert.equal(cookies(repeated),cookies(pending),'Pending capability must replay identically');
 const password=randomUUID()+'long';const signup=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin,cookie:cookies(pending)},payload:{email,password,name:'Invited test user'}});
 assert.equal(signup.statusCode,200,signup.body);return {user:await login(email,password),invitation:value};
}
let caseId:string,viewer:User;
test('real runtime roles cannot own tables or bypass RLS',async()=>{await verifyRuntimeRole();await verifyAuthRuntimeRole();const role=(await pool!.query('SELECT current_user')).rows[0];assert.equal(role.current_user,'faultline_api');const rows=await pool!.query('SELECT id FROM faultline.cases');assert.equal(rows.rowCount,0,'Unscoped connection must see no cases');});
test('auth expiry dates remain native Date while domain event timestamps retain all six decimal digits',async()=>{
 const sql="SELECT '2026-09-01T01:00:00.123456Z'::timestamptz AS instant";
 const domain=(await pool!.query(sql)).rows[0].instant,identity=(await authPool!.query(sql)).rows[0].instant;
 assert.equal(typeof domain,'string');assert.match(domain,/\.123456/);
 assert(identity instanceof Date);assert.equal(identity.toISOString(),'2026-09-01T01:00:00.123Z');
});
test('idempotent workspace/case effects replay exact committed IDs and changed body conflicts',async()=>{
 const key=randomUUID(),input={title:'Session regression '+tag,question:'Why did mobile completion fall?',affected_flow:'Checkout'};
 const first=await call(owner,'POST',root(alpha.id)+'/cases',input,key),retry=await call(owner,'POST',root(alpha.id)+'/cases',input,key);
 assert.equal(first.statusCode,201,first.body);assert.equal(retry.json().data.id,first.json().data.id);caseId=first.json().data.id;
 const conflict=await call(owner,'POST',root(alpha.id)+'/cases',{...input,title:'changed'},key);assert.equal(conflict.statusCode,409);
 const workspaceKey=randomUUID(),a=await call(owner,'POST','/api/v1/workspaces',{name:'Replay '+tag},workspaceKey),b=await call(owner,'POST','/api/v1/workspaces',{name:'Replay '+tag},workspaceKey);assert.equal(a.statusCode,201,a.body);assert.equal(b.statusCode,201,b.body);assert.equal(a.json().data.id,b.json().data.id);
 const count=(await admin.query('SELECT count(*)::int n FROM faultline.cases WHERE id=$1',[caseId])).rows[0].n;assert.equal(count,1);
});
test('fresh anonymous invite enrolls through actual Better Auth and grants stored viewer role once',async()=>{
 const result=await newInvited('viewer-'+tag+'@example.test');viewer=result.user;
 const role=(await admin.query('SELECT role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[alpha.id,viewer.id])).rows[0].role;assert.equal(role,'viewer');
 const cleared=(await admin.query('SELECT "enrollmentHash" FROM auth."user" WHERE id=$1',[viewer.id])).rows[0].enrollmentHash;assert.equal(cleared,null);
 const replay=await call(viewer,'POST','/api/v1/invitations/claim',{token:result.invitation.token});assert.equal(replay.statusCode,409,'A new command cannot consume a claimed invitation');
});
test('viewer reads Alpha but cross-workspace IDs and viewer writes cannot bypass membership',async()=>{
 const permitted=await call(viewer,'GET',root(alpha.id)+'/cases/'+caseId);assert.equal(permitted.statusCode,200);
 const foreign=await call(viewer,'GET',root(beta.id)+'/cases/'+caseId);assert.equal(foreign.statusCode,404);
 const mutation=await call(viewer,'PATCH',root(alpha.id)+'/cases/'+caseId,{title:'forged title'},undefined,permitted.json().data.revision);assert.equal(mutation.statusCode,403);
 const members=await call(viewer,'GET',root(alpha.id)+'/members');assert.equal(members.statusCode,403);
 const unchanged=await call(owner,'GET',root(alpha.id)+'/cases/'+caseId);assert.equal(unchanged.json().data.title,'Session regression '+tag);
});
test('existing viewer may claim Beta invitation with principal authority and retry committed claim',async()=>{
 const invitation=(await call(owner,'POST',root(beta.id)+'/invitations',{intended_email:viewer.email,role:'analyst',expires_at:new Date(Date.now()+3600000).toISOString()})).json().data;
 const key=randomUUID(),claim=await call(viewer,'POST','/api/v1/invitations/claim',{token:invitation.token},key);assert.equal(claim.statusCode,200,claim.body);assert.equal(claim.json().data.status,'claimed');
 const replay=await call(viewer,'POST','/api/v1/invitations/claim',{token:invitation.token},key);assert.equal(replay.statusCode,200,replay.body);
 const role=(await admin.query('SELECT role FROM faultline.memberships WHERE workspace_id=$1 AND user_id=$2',[beta.id,viewer.id])).rows[0].role;assert.equal(role,'analyst');
});
test('strict invitation fields reject client owner/workspace elevation and encryption protects private replay capability',async()=>{
 const invalid=await call(owner,'POST',root(alpha.id)+'/invitations',{intended_email:'bad-'+tag+'@example.test',role:'owner',workspace_id:beta.id,expires_at:new Date(Date.now()+3600000).toISOString()});assert.equal(invalid.statusCode,400);
 const invitation=(await call(owner,'POST',root(alpha.id)+'/invitations',{intended_email:'encrypted-'+tag+'@example.test',role:'analyst',expires_at:new Date(Date.now()+3600000).toISOString()})).json().data;
 const receipts=(await admin.query("SELECT result::text FROM faultline.idempotency WHERE workspace_id=$1 AND operation='invite'",[alpha.id])).rows;
 assert.ok(receipts.every(x=>!x.result.includes(invitation.token)));assert.ok(receipts.every(x=>x.result.includes('encrypted')));
 const revoked=await call(owner,'DELETE',root(alpha.id)+'/invitations/'+invitation.id,undefined,undefined,invitation.revision);assert.equal(revoked.statusCode,204,revoked.body);
 const claim=await call(null,'POST','/api/v1/invitations/claim',{token:invitation.token});assert.equal(claim.statusCode,409);
});
test('case edits create immutable revisions; stale edits, revision/audit mutation and pooled scope leakage fail',async()=>{
 const current=(await call(owner,'GET',root(alpha.id)+'/cases/'+caseId)).json().data;
 const edited=await call(owner,'PATCH',root(alpha.id)+'/cases/'+caseId,{question:'Which competing explanation survives controls?'},undefined,current.revision);assert.equal(edited.statusCode,200,edited.body);assert.notEqual(edited.json().data.active_revision_id,current.active_revision_id);
 const stale=await call(owner,'PATCH',root(alpha.id)+'/cases/'+caseId,{title:'stale'},undefined,current.revision);assert.equal(stale.statusCode,409);
 const revisions=(await admin.query('SELECT count(*)::int n FROM faultline.case_revisions WHERE case_id=$1',[caseId])).rows[0].n;assert.equal(revisions,2);
 await assert.rejects(()=>transaction(alpha.id,tx=>tx.query('UPDATE faultline.case_revisions SET content_hash=$1 WHERE case_id=$2',['0'.repeat(64),caseId])),/permission denied/);
 await assert.rejects(()=>transaction(alpha.id,tx=>tx.query('DELETE FROM faultline.audit WHERE workspace_id=$1',[alpha.id])),/permission denied/);
 await assert.rejects(()=>transaction(alpha.id,async()=>{throw new Error('forced rollback');}),/forced rollback/);
 assert.equal((await pool!.query('SELECT id FROM faultline.cases')).rowCount,0);
});
test('expired generated session cannot read or mutate even with its previously valid signed cookie',async()=>{
 const result=await newInvited('expired-'+tag+'@example.test','viewer',alpha.id);
 const active=await auth!.api.getSession({headers:new Headers({cookie:result.user.cookie})});assert.equal(active?.user.id,result.user.id);
 const sessions=(await admin.query('SELECT id FROM auth.session WHERE "userId"=$1 AND id=$2',[result.user.id,active!.session.id])).rows;
 assert.equal(sessions.length,1,'Only the new generated actor session may be expired.');
 assert.equal((await call(result.user,'GET',root(alpha.id)+'/cases/'+caseId)).statusCode,200);
 await admin.query('UPDATE auth.session SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1 AND "userId"=$2',[sessions[0].id,result.user.id]);
 assert.equal((await call(result.user,'GET',root(alpha.id)+'/cases/'+caseId)).statusCode,401);
 assert.equal((await call(result.user,'POST',root(alpha.id)+'/cases',{title:'forged after expiry',question:'must fail'})).statusCode,401);
});
test('sign-out revokes server session and old session cannot mutate',async()=>{
 const result=await call(viewer,'POST','/api/auth/sign-out',{});assert.equal(result.statusCode,200,result.body);
 const read=await call(viewer,'GET',root(alpha.id)+'/cases/'+caseId);assert.equal(read.statusCode,401);
 const write=await call(viewer,'POST',root(alpha.id)+'/cases',{title:'forged after logout',question:'must fail'});assert.equal(write.statusCode,401);
});
test.after(async()=>{await app.close();await pool?.end();await authPool?.end();await admin.end();});

