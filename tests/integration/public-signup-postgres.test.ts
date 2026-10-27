import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildServer} from '../../apps/api/src/server.js';
import {byteHash} from '../../packages/core/src/canonical.js';
import {config} from '../../packages/core/src/config.js';
import {pool,authPool} from '../../packages/database/src/client.js';

const origin='http://localhost:3000';
assert.equal(config.publicSignupEnabled,true,'Run this focused test with PUBLIC_SIGNUP_ENABLED=true.');
assert.ok(process.env.MIGRATION_DATABASE_URL,'The isolated operator connection is required for acceptance assertions.');
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DATABASE_URL}),app=await buildServer(),tag=randomUUID().slice(0,8);
const createdEmails:string[]=[];

function cookies(response:{headers:Record<string,unknown>}):string{
 const values=response.headers['set-cookie'];
 return (Array.isArray(values)?values:[values]).filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
}
async function signup(email:string,workspaceName:string,extra:Record<string,unknown>={},cookie?:string){
 createdEmails.push(email);
 return app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin,...(cookie?{cookie}:{})},payload:{name:'Generated Signup '+tag,email,password:'Generated-'+randomUUID(),workspace_name:workspaceName,...extra}});
}
async function account(cookie:string){
 const session=await app.inject({url:'/api/v1/session',headers:{cookie}}),workspaces=await app.inject({url:'/api/v1/workspaces',headers:{cookie}});
 assert.equal(session.statusCode,200,session.body);assert.equal(workspaces.statusCode,200,workspaces.body);
 return {session:session.json().data,workspaces:workspaces.json().data as Array<{id:string;name:string;role:string}>};
}

test('public signup is unavailable before protected installation bootstrap',async()=>{
 const client=await admin.connect();
 try{
  await client.query('BEGIN');await client.query('UPDATE faultline.installation SET bootstrapped_at=NULL WHERE singleton');await client.query('SAVEPOINT signup_gate');
  await assert.rejects(()=>client.query('SELECT * FROM faultline.prepare_public_signup($1,$2,$3,$4)',[byteHash(randomBytes(32)),'prebootstrap-'+tag+'@example.test',randomUUID(),'Blocked workspace']),/Installation bootstrap required/);
  await client.query('ROLLBACK TO SAVEPOINT signup_gate');await client.query('ROLLBACK');
 }finally{client.release();}
});

test('configured signup atomically creates one isolated owner workspace and survives sign-out/sign-in',async()=>{
 const email='public-owner-'+tag+'@example.test',workspaceName='Public owner '+tag;
 const response=await signup(email,workspaceName,{role:'viewer',workspace_id:randomUUID()});
 assert.equal(response.statusCode,200,response.body);
 const cookie=cookies(response),first=await account(cookie);
  assert.equal(first.workspaces.length,1);assert.equal(first.workspaces[0]!.name,workspaceName);assert.equal(first.workspaces[0]!.role,'owner');
  const userId=first.session.user.id,workspaceId=first.workspaces[0]!.id;
 const persisted=(await admin.query("SELECT m.role,a.details->>'mode' AS mode FROM faultline.memberships m JOIN faultline.audit a ON a.workspace_id=m.workspace_id AND a.actor_id=m.user_id AND a.operation='enrollment' WHERE m.workspace_id=$1 AND m.user_id=$2",[workspaceId,userId])).rows;
 assert.deepEqual(persisted,[{role:'owner',mode:'public_signup'}]);
 assert.equal(Number((await admin.query('SELECT count(*) n FROM faultline.memberships WHERE user_id=$1',[userId])).rows[0].n),1);
 assert.equal((await app.inject({method:'POST',url:'/api/auth/sign-out',headers:{origin,cookie},payload:{}})).statusCode,200);
 assert.equal((await app.inject({url:'/api/v1/session',headers:{cookie}})).statusCode,401);
 const loginPassword='Generated-login-'+randomUUID();
 const secondEmail='persistent-'+tag+'@example.test';createdEmails.push(secondEmail);
 const registered=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Persistent owner',email:secondEmail,password:loginPassword,workspace_name:'Persistent '+tag}});
 assert.equal(registered.statusCode,200,registered.body);
 const signedOutCookie=cookies(registered);assert.equal((await app.inject({method:'POST',url:'/api/auth/sign-out',headers:{origin,cookie:signedOutCookie},payload:{}})).statusCode,200);
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email:secondEmail,password:loginPassword}});
  assert.equal(login.statusCode,200,login.body);assert.equal((await account(cookies(login))).workspaces[0]!.name,'Persistent '+tag);
});

test('explicit signup ignores a stale invitation cookie without broadening another workspace',async()=>{
 const email='stale-cookie-'+tag+'@example.test',response=await signup(email,'Stale cookie '+tag,{},'faultline.pending=stale-generated-capability');
 assert.equal(response.statusCode,200,response.body);
  const current=await account(cookies(response));assert.equal(current.workspaces.length,1);assert.equal(current.workspaces[0]!.role,'owner');
 assert.match(String(response.headers['set-cookie']),/faultline\.pending=.*Max-Age=0/);
});

test('separate public owners cannot read each other workspace and duplicate signup creates no second tenant',async()=>{
 const firstEmail='isolated-a-'+tag+'@example.test',secondEmail='isolated-b-'+tag+'@example.test',password='Generated-'+randomUUID();createdEmails.push(firstEmail,secondEmail);
 const first=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Isolated A',email:firstEmail,password,workspace_name:'Isolated A '+tag}});
 const second=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Isolated B',email:secondEmail,password,workspace_name:'Isolated B '+tag}});
 assert.equal(first.statusCode,200,first.body);assert.equal(second.statusCode,200,second.body);
  const a=await account(cookies(first)),b=await account(cookies(second));assert.notEqual(a.workspaces[0]!.id,b.workspaces[0]!.id);
  assert.equal((await app.inject({url:'/api/v1/workspaces/'+b.workspaces[0]!.id,headers:{cookie:cookies(first)}})).statusCode,404);
 const duplicate=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Duplicate',email:firstEmail,password:'Generated-'+randomUUID(),workspace_name:'Duplicate '+tag}});
 assert.equal(duplicate.statusCode,409,duplicate.body);
 assert.equal(Number((await admin.query('SELECT count(*) n FROM auth."user" WHERE lower(email)=lower($1)',[firstEmail])).rows[0].n),1);
 assert.equal(Number((await admin.query('SELECT count(*) n FROM faultline.memberships m JOIN auth."user" u ON u.id=m.user_id WHERE lower(u.email)=lower($1)',[firstEmail])).rows[0].n),1);
});

test('origin and password failures leave no user, workspace, membership, or pending capability',async()=>{
 const badOrigin='bad-origin-'+tag+'@example.test',shortPassword='short-password-'+tag+'@example.test';createdEmails.push(badOrigin,shortPassword);
 const denied=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin:'https://attacker.invalid'},payload:{name:'Denied',email:badOrigin,password:'Generated-'+randomUUID(),workspace_name:'Denied'}});
 assert.equal(denied.statusCode,403);
 const short=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Short',email:shortPassword,password:'short',workspace_name:'Short'}});
 assert.notEqual(short.statusCode,200);
 for(const email of [badOrigin,shortPassword]){
  assert.equal(Number((await admin.query('SELECT count(*) n FROM auth."user" WHERE lower(email)=lower($1)',[email])).rows[0].n),0);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM auth.enrollment_capabilities WHERE lower(intended_email)=lower($1) AND consumed_at IS NULL',[email])).rows[0].n),0);
 }
});

test('default-off runtime switch rejects a generated registration before persistence',async()=>{
 const email='disabled-'+tag+'@example.test';createdEmails.push(email);config.publicSignupEnabled=false;
 try{
  const response=await app.inject({method:'POST',url:'/api/auth/sign-up/email',headers:{origin},payload:{name:'Disabled',email,password:'Generated-'+randomUUID(),workspace_name:'Disabled'}});
  assert.equal(response.statusCode,403,response.body);assert.equal(response.json().error.code,'SIGNUP_DISABLED');
  assert.equal(Number((await admin.query('SELECT count(*) n FROM auth."user" WHERE lower(email)=lower($1)',[email])).rows[0].n),0);
 }finally{config.publicSignupEnabled=true;}
});

test.after(async()=>{
 for(const email of createdEmails){assert.equal(Number((await admin.query('SELECT count(*) n FROM auth."user" WHERE lower(email)=lower($1)',[email])).rows[0].n)<=1,true);}
 await app.close();await Promise.allSettled([pool?.end(),authPool?.end()]);await admin.end();
});
