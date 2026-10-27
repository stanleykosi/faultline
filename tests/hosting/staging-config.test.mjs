import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const vercel=JSON.parse(await fs.readFile(new URL('../../ops/staging/vercel.json.example',import.meta.url),'utf8'));
const deployedVercel=JSON.parse(await fs.readFile(new URL('../../vercel.json',import.meta.url),'utf8'));
const railway=JSON.parse(await fs.readFile(new URL('../../ops/staging/railway.json.example',import.meta.url),'utf8'));
const dockerfile=await fs.readFile(new URL('../../ops/images/Dockerfile',import.meta.url),'utf8');
const hostedStart=await fs.readFile(new URL('../../scripts/start-hosted.mjs',import.meta.url),'utf8');
const operatorRoles=await fs.readFile(new URL('../../tools/ops/roles.ts',import.meta.url),'utf8');
const operatorBootstrap=await fs.readFile(new URL('../../tools/ops/bootstrap.ts',import.meta.url),'utf8');

test('Vercel draft builds the static Vite output and keeps API proxy ahead of SPA fallback',()=>{
 assert.equal(vercel.installCommand,'pnpm install --frozen-lockfile');
 assert.equal(vercel.buildCommand,'pnpm contracts:generate && pnpm build:web');
 assert.equal(vercel.outputDirectory,'dist/web');
 assert.equal(vercel.rewrites[0].source,'/api');
 assert.equal(vercel.rewrites[1].source,'/api/:path*');
 assert.match(vercel.rewrites[1].destination,/\.invalid\/api\/:path\*$/);
 assert.equal(vercel.rewrites.at(-1).source,'/(.*)');
});

test('Vercel routes the API function before static assets and the SPA fallback',()=>{
 assert.equal(deployedVercel.outputDirectory,'dist/web');
 assert.equal(deployedVercel.rewrites,undefined);
 assert.deepEqual(deployedVercel.routes.slice(0,2),[{src:'^/api(?:/.*)?$',dest:'/api/index'},{src:'^/health/.*$',dest:'/api/index'}]);
 assert.deepEqual(deployedVercel.routes[2],{handle:'filesystem'});
 assert.deepEqual(deployedVercel.routes.at(-1),{src:'^/.*$',dest:'/index.html'});
 assert.equal(deployedVercel.daemons.worker.entrypoint,'Dockerfile');
 assert.doesNotMatch(JSON.stringify(deployedVercel),/railway\.app|token|secret/i);
});

test('Railway example uses hosted target/readiness without an automatic migration command or secret values',()=>{
 assert.equal(railway.build.builder,'DOCKERFILE');
 assert.equal(railway.build.dockerfilePath,'ops/images/Dockerfile');
 assert.equal(railway.deploy.startCommand,'node scripts/start-hosted.mjs');
 assert.equal(railway.deploy.healthcheckPath,'/health/ready');
 assert.equal(railway.deploy.preDeployCommand,undefined);
 assert.doesNotMatch(JSON.stringify(railway),/MIGRATION_DATABASE_URL|AUTH_SECRET|DATABASE_URL|replace-with-real/i);
});

test('Docker recipe retains non-root runtime, SQL migration files and explicit hosted/operator targets',()=>{
 assert.match(dockerfile,/COPY --from=build --chown=node:node \/app\/api\.routes\.json \.\/api\.routes\.json/);
 assert.match(dockerfile,/COPY --from=build --chown=node:node \/app\/packages\/database\/migrations \.\/packages\/database\/migrations/);
 assert.match(dockerfile,/COPY --from=build --chown=node:node \/app\/dist\/server \.\/dist\/server/);
 assert.match(dockerfile,/COPY --from=build --chown=node:node \/app\/scripts\/hosted-private-runtime\.mjs \.\/scripts\/hosted-private-runtime\.mjs/);
 assert.match(dockerfile,/test "\$\(id -u node\)" = "1000" && test "\$\(id -g node\)" = "1000"/);
 assert.match(dockerfile,/RUN test "\$\(id -u node\)" = "1000"[^\r\n]*mkdir -p \/data\/objects[^\r\n]*\r?\nUSER node:node\r?\nFROM runtime AS api/);
 assert.match(dockerfile,/FROM runtime AS operator\r?\nUSER root\r?\nRUN mkdir -p \/app\/reports\/application[^\r\n]*\r?\nUSER node:node\r?\nENTRYPOINT \["node"\]/);
 assert.match(dockerfile,/FROM runtime AS hosted[\s\S]*CMD \["node","scripts\/start-hosted\.mjs"\]\s*$/);
 assert.ok(dockerfile.indexOf('FROM runtime AS operator')<dockerfile.indexOf('FROM runtime AS hosted'));
 assert.match(dockerfile,/ENTRYPOINT \["node"\]\nCMD \["--help"\]/);
});

test('root-only volume initializer target contains only Node and the finite initializer source',()=>{
 const start=dockerfile.indexOf('FROM ${NODE_BASE_IMAGE} AS volume-init'),end=dockerfile.indexOf('FROM ${NODE_BASE_IMAGE} AS build');
 assert.ok(start>=0&&end>start);
 const target=dockerfile.slice(start,end);
 assert.match(target,/COPY --chown=root:root scripts\/initialize-private-volume\.mjs \.\/initialize-private-volume\.mjs/);
 assert.match(target,/USER root:root\s+ENTRYPOINT \["node","\/opt\/faultline-volume-init\/initialize-private-volume\.mjs"\]/);
 assert.doesNotMatch(target,/COPY.*(?:dist\/server|packages\/database|apps\/|fixtures\/)/);
});

test('hosted startup sanitizes sealed/operator inputs before config loading and child spawn',()=>{
 assert.match(hostedStart,/import \{prepareHostedPrivateRuntime\} from '\.\/hosted-private-runtime\.mjs'/);
 const prepare=hostedStart.indexOf('await prepareHostedPrivateRuntime()');
 const config=hostedStart.indexOf("import('../dist/server/packages/core/src/config.js')");
 const supervisor=hostedStart.indexOf('await superviseHosted(');
 assert.ok(prepare>=0&&config>prepare&&supervisor>config);
 assert.doesNotMatch(hostedStart,/import \{config\} from ['"]\.\.\/dist\/server\/packages\/core\/src\/config/);
});

test('operator role setup has a restricted login-only phase before schema-dependent grants',()=>{
 const prepare=operatorRoles.indexOf("process.argv.includes('--prepare-logins')");
 const authority=operatorRoles.indexOf("CREATE ROLE faultline_authority NOLOGIN");
 const grant=operatorRoles.indexOf('GRANT USAGE ON SCHEMA faultline,auth');
 assert.ok(authority>0&&prepare>authority&&grant>prepare);
 assert.match(operatorRoles,/CREATE ROLE '\+role\+' LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD/);
 assert.match(operatorRoles,/CREATE ROLE faultline_authority NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT'[\s\S]*?if\(process\.argv\.includes\('--prepare-logins'\)\)console\.log\([\s\S]*?else\{[\s\S]*?GRANT USAGE ON SCHEMA faultline,auth/);
});

test('hosted database verifier checks exact migrations, restricted roles, and denied DDL',async()=>{
 const source=await fs.readFile(new URL('../../tools/ops/verify-hosted-database.ts',import.meta.url),'utf8');
 assert.match(source,/runtimeMigrations/);
 assert.match(source,/migrations\.length===runtimeMigrations\.length/);
 assert.match(source,/rolsuper/);
 assert.match(source,/rolbypassrls/);
 assert.match(source,/has_memberships/);
 assert.match(source,/owns_runtime_tables/);
 assert.match(source,/code\?:string/);
 assert.match(source,/==='42501'/);
 assert.match(source,/installation_read:false/);
 assert.doesNotMatch(source,/console\.log\([^\n]*(?:DATABASE_URL|connectionString)/);
});

test('operator bootstrap can prepare and consume one private capability in one isolated process',()=>{
 assert.match(operatorBootstrap,/process\.argv\.includes\('--complete'\)/);
 assert.match(operatorBootstrap,/if\(prepareOnly\|\|complete\)/);
 assert.match(operatorBootstrap,/if\(!prepareOnly\)/);
 assert.ok(operatorBootstrap.indexOf("mode,'bootstrap'")<operatorBootstrap.indexOf('identity.api.signUpEmail'));
 assert.ok(operatorBootstrap.indexOf('identity.api.signUpEmail')<operatorBootstrap.indexOf('await fs.unlink(file)'));
 assert.match(operatorBootstrap,/fs\.mkdir\(path\.dirname\(file\)/);
 assert.doesNotMatch(operatorBootstrap,/fs\.mkdir\('\.runtime'/);
});
