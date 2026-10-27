import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const root=process.cwd();
const password=()=>randomBytes(32).toString('base64url');
async function freePort():Promise<number>{
  const server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;
}

test('fresh Supabase profile installs and replays under a non-superuser without touching managed auth',{timeout:600_000},async(context)=>{
  const id=randomUUID(),directory=path.join(root,'reports','application','supabase-install-'+id);
  const startedAt=new Date().toISOString();
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const port=await freePort(),operatorPassword=password(),installerPassword=password(),authSecret=password()+password(),bootstrapPassword=password();
  const runtimePasswords={API_DATABASE_PASSWORD:password(),AUTH_DATABASE_PASSWORD:password(),QUEUE_DATABASE_PASSWORD:password(),DISPATCHER_DATABASE_PASSWORD:password()};
  const privateValues=[operatorPassword,installerPassword,authSecret,bootstrapPassword,...Object.values(runtimePasswords)];
  const sanitize=(value:string)=>privateValues.reduce((text,secret)=>text.replaceAll(secret,'[REDACTED]'),value).replace(/postgres(?:ql)?:\/\/\S+/g,'[DATABASE_URL]');
  const logLines:string[]=[],steps:{name:string;exitCode:number|null;output:string}[]=[];
  const cluster=new EmbeddedPostgres({databaseDir:path.join(directory,'postgres'),user:'synthetic_operator',password:operatorPassword,port,authMethod:'scram-sha-256',persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1'],onLog:(line)=>logLines.push(sanitize(line)),onError:(line)=>logLines.push(sanitize(String(line)))});
  let started=false,admin:pg.Client|undefined,target:pg.Client|undefined;
  const url=(role:string,secret:string,database='faultline_acceptance')=>`postgresql://${role}:${encodeURIComponent(secret)}@127.0.0.1:${port}/${database}`;
  const installerUrl=url('synthetic_installer',installerPassword);
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'development',FAULTLINE_SYNTHETIC_INSTALL:'true',AUTH_DATABASE_SCHEMA:'faultline_identity',AUTH_SECRET:authSecret,APP_ORIGIN:'http://localhost:3000',MODEL_PROVIDER:'none',RUNNER_MODE:'disabled',OBJECT_STORE:'filesystem',ALLOW_FIXTURE_ADAPTERS:'false',MIGRATION_DATABASE_URL:installerUrl,DATABASE_URL:url('faultline_api',runtimePasswords.API_DATABASE_PASSWORD),AUTH_DATABASE_URL:url('faultline_auth',runtimePasswords.AUTH_DATABASE_PASSWORD),QUEUE_DATABASE_URL:url('faultline_queue',runtimePasswords.QUEUE_DATABASE_PASSWORD),DISPATCHER_DATABASE_URL:url('faultline_dispatcher',runtimePasswords.DISPATCHER_DATABASE_PASSWORD),...runtimePasswords};
  async function command(name:string,file:string,args:string[]=[],changes:NodeJS.ProcessEnv={}){
    context.signal.throwIfAborted();
    const stepStarted=new Date().toISOString();
    const result=await new Promise<{exitCode:number|null;output:string}>((resolve,reject)=>{
      const childEnv={...env,...changes};delete childEnv.NODE_TEST_CONTEXT;
      const child=spawn(process.execPath,['--import','tsx',file,...args],{cwd:root,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:240_000,signal:context.signal});
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      child.once('error',reject);child.once('exit',exitCode=>resolve({exitCode,output:sanitize(output)}));
    });
    steps.push({name,...result});
    await fs.appendFile(path.join(directory,'step-timings.jsonl'),JSON.stringify({name,started_at:stepStarted,finished_at:new Date().toISOString(),exit_code:result.exitCode})+'\n');
    context.signal.throwIfAborted();return result;
  }
  async function managedSnapshot(){
    assert.ok(target);
    return (await target.query(`SELECT jsonb_build_object(
      'schema',(SELECT jsonb_build_object('owner',nspowner,'acl',nspacl::text) FROM pg_namespace WHERE nspname='auth'),
      'table',(SELECT jsonb_build_object('owner',relowner,'acl',relacl::text) FROM pg_class WHERE oid='auth.managed_users'::regclass),
      'rows',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth.managed_users t),
      'function',(SELECT jsonb_build_object('definition',pg_get_functiondef(oid),'owner',proowner,'acl',proacl::text) FROM pg_proc WHERE oid='auth.uid()'::regprocedure)
    ) AS snapshot`)).rows[0].snapshot;
  }
  try{
    await cluster.initialise();await cluster.start();started=true;
    admin=cluster.getPgClient('postgres','127.0.0.1');await admin.connect();
    await admin.query('CREATE ROLE synthetic_installer LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE PASSWORD $1'.replace('$1',"'"+installerPassword+"'"));
    await admin.query('CREATE ROLE synthetic_managed_auth NOLOGIN');
    await admin.query('CREATE DATABASE faultline_acceptance OWNER synthetic_installer');
    target=cluster.getPgClient('faultline_acceptance','127.0.0.1');await target.connect();
    await target.query(`CREATE SCHEMA auth AUTHORIZATION synthetic_managed_auth;
      CREATE TABLE auth.managed_users(id text PRIMARY KEY, value text NOT NULL);
      INSERT INTO auth.managed_users VALUES('managed-sentinel','must survive unchanged');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
      ALTER TABLE auth.managed_users OWNER TO synthetic_managed_auth;
      ALTER FUNCTION auth.uid() OWNER TO synthetic_managed_auth;
      REVOKE ALL ON SCHEMA auth FROM PUBLIC;REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;`);
    const before=await managedSnapshot();
    const authority=(await target.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='synthetic_installer'")).rows[0];
    assert.deepEqual(authority,{rolsuper:false,rolbypassrls:false,rolcreaterole:true});
    const install=await command('fresh_install','tools/ops/migrate-supabase.ts',['--install-fresh']);
    assert.equal(install.exitCode,0,install.output);
    assert.deepEqual(await managedSnapshot(),before,'managed auth rows, owners, ACLs and function must remain unchanged');
    const files=(await fs.readdir(path.join(root,'packages/database/migrations'))).filter(name=>/^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
    const ledger=(await target.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows as {id:string;checksum:string}[];
    assert.equal(ledger.length,files.length);
    for(const [index,file] of files.entries()){
      const source=await fs.readFile(path.join(root,'packages/database/migrations',file),'utf8');
      assert.equal(ledger[index]!.id,file.slice(0,-4));
      assert.equal(ledger[index]!.checksum,createHash('sha256').update(source.replace(/\bauth\b/g,'faultline_identity')).digest('hex'));
    }
    assert.equal((await target.query("SELECT identity_schema FROM faultline.hosting_profile WHERE singleton")).rows[0].identity_schema,'faultline_identity');
    const installed=(await target.query("SELECT to_regclass('faultline_identity.\"user\"') AS users,to_regclass('pgboss.job') AS jobs")).rows[0];
    assert.ok(installed.users);assert.ok(installed.jobs);
    const replay=await command('replay_upgrade','tools/ops/migrate-supabase.ts',['--upgrade']);
    assert.equal(replay.exitCode,0,replay.output);
    assert.deepEqual((await target.query('SELECT id,checksum FROM faultline.schema_migrations ORDER BY id')).rows,ledger);
    const keyringPath=path.join(directory,'synthetic-keyring.json');
    await fs.writeFile(keyringPath,JSON.stringify({active:'synthetic',keys:{synthetic:randomBytes(32).toString('base64')}}),{flag:'wx',mode:0o600});
    const bootstrap=await command('synthetic_operator_bootstrap','tools/ops/bootstrap.ts',['--complete'],{
      BOOTSTRAP_EMAIL:'bootstrap-'+id+'@example.test',BOOTSTRAP_PASSWORD:bootstrapPassword,BOOTSTRAP_NAME:'Synthetic bootstrap owner',BOOTSTRAP_WORKSPACE:'Synthetic initial workspace',BOOTSTRAP_TOKEN_PATH:path.join(directory,'synthetic-bootstrap-token'),
    });
    assert.equal(bootstrap.exitCode,0,bootstrap.output);
    const identity=await command('connected_identity_and_direct_upload','tests/integration/vercel-supabase-upload.test.ts',[],{
      FAULTLINE_SUPABASE_ACCEPTANCE_FIXTURE:'generated-cluster',FAULTLINE_HOSTING_PROFILE:'vercel-supabase',PROCESS_ROLE:'api',PUBLIC_SIGNUP_ENABLED:'true',
      OBJECT_STORE:'supabase',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_STORAGE_BUCKET:'synthetic-evidence',SUPABASE_UPLOAD_BUCKET:'synthetic-uploads',SUPABASE_STORAGE_SERVICE_KEY:'synthetic-private-service-key',
      SECRET_KEYRING_PATH:keyringPath,SYNTHETIC_ASSERTION_DATABASE_URL:url('synthetic_operator',operatorPassword),SYNTHETIC_EVIDENCE_DIR:directory,
    });
    assert.equal(identity.exitCode,0,identity.output);
    const cross=await command('cross_profile_rejected','tools/ops/migrate.ts',[],{AUTH_DATABASE_SCHEMA:'auth'});
    assert.notEqual(cross.exitCode,0,cross.output);assert.match(cross.output,/MIGRATION_CHANGED|HOSTING_PROFILE_MISMATCH/);
    assert.deepEqual(await managedSnapshot(),before);
    context.signal.throwIfAborted();
    const last=ledger.at(-1)!;
    await target.query('UPDATE faultline.schema_migrations SET checksum=$1 WHERE id=$2',['0'.repeat(64),last.id]);
    const mismatch=await command('checksum_mismatch_rejected','tools/ops/migrate-supabase.ts',['--upgrade']);
    assert.notEqual(mismatch.exitCode,0,mismatch.output);assert.match(mismatch.output,/MIGRATION_CHANGED/);
    await target.query('UPDATE faultline.schema_migrations SET checksum=$1 WHERE id=$2',[last.checksum,last.id]);
    const api=new pg.Client({connectionString:env.DATABASE_URL});await api.connect();
    try{await assert.rejects(api.query('SELECT * FROM auth.managed_users'),(error:unknown)=>(error as {code?:string}).code==='42501');}finally{await api.end();}
    const auth=new pg.Client({connectionString:env.AUTH_DATABASE_URL});await auth.connect();
    try{
      assert.equal((await auth.query('SELECT count(*)::int AS count FROM faultline_identity."user"')).rows[0].count,2);
      await assert.rejects(auth.query('SELECT * FROM faultline.workspaces'),(error:unknown)=>(error as {code?:string}).code==='42501');
    }finally{await auth.end();}
    assert.deepEqual(await managedSnapshot(),before);
    await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({status:'passed_isolated_postgres_not_live_supabase',id,startedAt,finishedAt:new Date().toISOString(),port,database:'faultline_acceptance',installerSuperuser:false,migrations:ledger,managedAuthPreserved:true,steps},null,2)+'\n',{flag:'wx'});
  }catch(error){await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({status:'failed',id,startedAt,finishedAt:new Date().toISOString(),error:sanitize(error instanceof Error?error.stack??error.message:String(error)),steps},null,2)+'\n',{flag:'wx'});throw error;}
  finally{
    await target?.end().catch(()=>{});await admin?.end().catch(()=>{});
    if(started)await cluster.stop();
    await fs.writeFile(path.join(directory,'postgres.log'),logLines.join('\n')+'\n',{flag:'wx'});
    console.log('Synthetic Supabase-profile installation evidence: '+directory+' (cluster stopped; generated files retained).');
  }
});
