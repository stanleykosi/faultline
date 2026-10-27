import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
const runtime=path.resolve('.runtime');await fs.mkdir(runtime,{recursive:true,mode:0o700});
const secretsFile=path.join(runtime,'development-config.json');let values;
try{values=JSON.parse(await fs.readFile(secretsFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;
 values={port:54329,admin:randomBytes(32).toString('base64url'),api:randomBytes(32).toString('base64url'),auth:randomBytes(32).toString('base64url'),queue:randomBytes(32).toString('base64url'),dispatcher:randomBytes(32).toString('base64url'),authSecret:randomBytes(48).toString('base64url'),ownerEmail:'owner@faultline.local',ownerPassword:randomBytes(24).toString('base64url')};
 await fs.writeFile(secretsFile,JSON.stringify(values),{flag:'wx',mode:0o600});
}
const pg=new EmbeddedPostgres({databaseDir:path.join(runtime,'postgres17'),user:'faultline_operator',password:values.admin,port:values.port,authMethod:'scram-sha-256',persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>console.error('Native PostgreSQL reported an error; inspect its local startup status.')});
if(!await fs.stat(path.join(runtime,'postgres17','PG_VERSION')).then(()=>true).catch(()=>false))await pg.initialise();
await pg.start();
const client=pg.getPgClient('postgres','127.0.0.1');await client.connect();
const exists=await client.query("SELECT 1 FROM pg_database WHERE datname='faultline'");if(!exists.rowCount)await client.query("CREATE DATABASE faultline TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");
console.log('Native PostgreSQL '+(await client.query('SHOW server_version')).rows[0].server_version+' listening only on 127.0.0.1:'+values.port);await client.end();
const url=(role,password)=>'postgresql://'+role+':'+encodeURIComponent(password)+'@127.0.0.1:'+values.port+'/faultline';
const local=[
 'APP_ORIGIN=http://localhost:3000','PORT=3000','NODE_ENV=development',
 'DATABASE_URL='+url('faultline_api',values.api),'AUTH_DATABASE_URL='+url('faultline_auth',values.auth),
 'QUEUE_DATABASE_URL='+url('faultline_queue',values.queue),'DISPATCHER_DATABASE_URL='+url('faultline_dispatcher',values.dispatcher),
 'AUTH_SECRET='+values.authSecret,'SECRET_KEYRING_PATH='+path.join(runtime,'keys','keyring.json'),
 'REPORT_SIGNING_KEY_PATH='+path.join(runtime,'keys','report-private.pem'),'OBJECT_STORE_PATH='+path.join(runtime,'objects'),
 'MODEL_PROVIDER=none','RUNNER_MODE=disabled','ALLOW_FIXTURE_ADAPTERS=true'
].join('\n')+'\n';
const ops=['MIGRATION_DATABASE_URL='+url('faultline_operator',values.admin),'AUTH_SECRET='+values.authSecret,'API_DATABASE_PASSWORD='+values.api,'AUTH_DATABASE_PASSWORD='+values.auth,'QUEUE_DATABASE_PASSWORD='+values.queue,'DISPATCHER_DATABASE_PASSWORD='+values.dispatcher,'BOOTSTRAP_EMAIL='+values.ownerEmail,'BOOTSTRAP_PASSWORD='+values.ownerPassword,'BOOTSTRAP_NAME=Development owner','BOOTSTRAP_WORKSPACE=Local investigation workspace'].join('\n')+'\n';
for(const [file,content] of [['.env.local',local],['.env.ops',ops]])if(!await fs.stat(file).then(()=>true).catch(()=>false))await fs.writeFile(file,content,{flag:'wx',mode:0o600});
console.log('Private development configuration prepared. Existing configuration was preserved. Credentials were not printed.');
process.on('SIGINT',()=>void pg.stop().then(()=>process.exit(0)));process.on('SIGTERM',()=>void pg.stop().then(()=>process.exit(0)));
setInterval(()=>{},30_000);

