import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHostedBuildContext,inspectHostedImportClosure} from '../../scripts/package-hosted-context.mjs';

const controls=['api.routes.json','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json'];
const explicit=['ops/images/Dockerfile','scripts/generate-contracts.mjs','scripts/generate-runtime-migrations.mjs','scripts/hosted-private-runtime.mjs','scripts/hosted-supervisor.mjs','scripts/initialize-private-volume.mjs','scripts/package-hosted-context.mjs','scripts/start-hosted.mjs'];
const featureFiles=['apps/api/package.json','apps/api/src/investigation-routes.ts','apps/api/src/main.ts','apps/web/index.html','apps/web/package.json','apps/web/src/features/providers/CredentialReplacement.tsx','apps/web/src/features/providers/ModelProfiles.tsx','apps/web/src/features/providers/Sources.tsx','apps/web/src/main.tsx','apps/web/src/theme.css','apps/web/src/theme-colors.css','apps/web/src/theme-icon.svg','apps/web/tsconfig.json','apps/web/vite.config.ts','config/defaults.json','contracts/capture.schema.json','fixtures/checkout-site/server.mjs','packages/core/package.json','packages/core/src/api-bind.ts','packages/core/src/reports/render.ts','packages/core/src/reports/service.ts','packages/core/src/reports/zip.ts','packages/core/src/secrets/keyring.ts','packages/core/src/secrets/replacements.ts','packages/core/src/service.ts','packages/database/package.json','packages/database/src/runtime-migrations.ts','tools/ops/migrate.ts'];
const migrationNames=['0001-foundation','0002-enrollment','0003-authority','0004-pending-idempotency','0005-data','0006-runtime','0007-lease-recovery','0008-investigation','0009-integrity','0010-report-bindings','0011-runtime-controls','0012-verification','0013-provider-services','0014-privacy-retention','0015-account-source-controls','0016-command-case-association','0017-cleanup-account-receipts','0018-legacy-case-receipts','0019-approved-scoped-purge','0020-policy-retention','0021-scoped-purge-audit-columns','0022-readonly-preflight-capacity','0023-frozen-redaction-previews','0024-staging-catalog','0025-model-budget-extensions','0026-managed-demo-cases','0027-secret-replacements','0028-scoped-purge-current-content'];

async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-hosting-fixture-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),destination=path.join(base,'context');await fs.mkdir(source);
 const put=async(relative,body='synthetic source')=>{const file=path.join(source,...relative.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);};
 const migrations=migrationNames.map(name=>`packages/database/migrations/${name}.sql`);
 const files=[...controls,...explicit,...featureFiles,...migrations].sort((a,b)=>a.localeCompare(b));
 for(const file of files)await put(file,file.endsWith('.sql')?'synthetic reviewed migration':'synthetic source');
 await put('ops/staging/hosted-build-inputs.json',JSON.stringify({schemaVersion:1,files}));
 return {base,source,destination,files,put};
}

async function listFiles(directory,root=directory,result=[]){
 for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await listFiles(file,root,result);else result.push(path.relative(root,file).split(path.sep).join('/'));}
 return result.sort();
}

test('clean context copies only the exact manifest, all 29 SQL migrations, and no unlisted private markers',async t=>{
 const f=await fixture(t);
 for(const file of ['apps/web/.envrc','config/session-token.txt','apps/unrelated-worktree/private.txt','apps/web/src/Unlisted.tsx','unrelated-root/local.txt','packages/core/src/secrets/credentials.ts','packages/core/src/secrets/unreviewed.ts','packages/core/src/reports/unreviewed.ts'])await f.put(file,'SYNTHETIC-SECRET-MARKER');
 const result=await createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),files=await listFiles(f.destination);
 assert.deepEqual(files,result.files);
 assert.deepEqual(result.files,f.files);
 for(const file of [...controls,...explicit,...featureFiles])assert.ok(files.includes(file),`expected allowlisted file ${file}`);
 assert.deepEqual(files.filter(file=>/^packages\/database\/migrations\/\d{4}-.*\.sql$/.test(file)),migrationNames.map(name=>`packages/database/migrations/${name}.sql`));
 for(const marker of ['apps/web/.envrc','config/session-token.txt','apps/unrelated-worktree/private.txt','apps/web/src/Unlisted.tsx','unrelated-root/local.txt','packages/core/src/secrets/credentials.ts','packages/core/src/secrets/unreviewed.ts','packages/core/src/reports/unreviewed.ts'])assert.ok(!files.includes(marker),`unexpected copied path ${marker}`);
 for(const file of files)assert.ok(!(await fs.readFile(path.join(f.destination,...file.split('/')))).includes('SYNTHETIC-SECRET-MARKER'));
});

test('manifest cannot authorize .envrc, token files, unrelated worktrees, report data or test files',async t=>{
 const f=await fixture(t),unsafe=['apps/web/.envrc','config/session-token.txt','apps/unrelated-worktree/private.txt','apps/web/src/Unlisted.test.tsx','packages/core/src/secrets/credentials.ts','packages/core/src/secrets/unreviewed.ts','packages/core/src/reports/unreviewed.ts'].sort((a,b)=>a.localeCompare(b));
 for(const file of unsafe)await f.put(file,'SYNTHETIC-SECRET-MARKER');
 await f.put('ops/staging/hosted-build-inputs.json',JSON.stringify({schemaVersion:1,files:[...f.files,...unsafe].sort((a,b)=>a.localeCompare(b))}));
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),/HOSTED_CONTEXT_INPUT_NOT_ALLOWLISTED/);
 await assert.rejects(fs.lstat(f.destination),error=>error.code==='ENOENT');
});

test('a symlink in a listed source path fails before any build context is published',async t=>{
 const f=await fixture(t),outside=path.join(f.base,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'main.ts'),'SYNTHETIC-SECRET-MARKER');
 const listedDir=path.join(f.source,'apps/api/src');await fs.rm(listedDir,{recursive:true,force:true});
 await fs.symlink(outside,listedDir,process.platform==='win32'?'junction':'dir');
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),/HOSTED_CONTEXT_SYMLINK_REFUSED/);
 await assert.rejects(fs.lstat(f.destination),error=>error.code==='ENOENT');
});

test('existing and source-contained destinations fail closed',async t=>{
 const f=await fixture(t);await fs.mkdir(f.destination);
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),/HOSTED_CONTEXT_DESTINATION_EXISTS/);
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:path.join(f.source,'context')}),/HOSTED_CONTEXT_DESTINATION_MUST_BE_DISJOINT/);
});

test('local relative import closure covers reviewed exceptions and classifies generated dist outputs',async t=>{
 const f=await fixture(t);
 await f.put('apps/api/src/investigation-routes.ts',"import {buildReport} from '../../../packages/core/src/reports/service.js';\n");
 await f.put('apps/web/src/features/providers/ModelProfiles.tsx',"import {CredentialReplacement} from './CredentialReplacement';\n");
 await f.put('apps/web/src/features/providers/Sources.tsx',"export {CredentialReplacement} from './CredentialReplacement';\n");
 await f.put('apps/web/src/main.tsx',"import './theme.css';\n");
 await f.put('apps/web/src/theme.css',"@import './theme-colors.css';\n.brand { background-image: url('./theme-icon.svg'); }\n");
 await f.put('apps/web/src/theme-colors.css','body { color: #123; }');
 await f.put('apps/web/src/theme-icon.svg','<svg xmlns="http://www.w3.org/2000/svg"/>');
 await f.put('scripts/start-hosted.mjs',"await import('../dist/server/packages/core/src/api-bind.js');\nawait import('../dist/server/apps/api/src/main.js');\n");
 const closure=await inspectHostedImportClosure({sourceRoot:f.source,files:f.files});
 assert.deepEqual(closure.missingFromManifest,[]);
 assert.deepEqual(closure.notAllowlisted,[]);
 assert.deepEqual(closure.unresolvedImports,[]);
 assert.deepEqual(closure.generatedServerOutputs,['dist/server/apps/api/src/main.js','dist/server/packages/core/src/api-bind.js']);
 const result=await createHostedBuildContext({sourceRoot:f.source,destination:f.destination});
 const files=await listFiles(f.destination);
 assert.deepEqual(files,result.files);
 assert.ok(files.includes('packages/core/src/reports/service.ts'));
 assert.ok(files.includes('apps/web/src/features/providers/CredentialReplacement.tsx'));
 assert.ok(!files.some(file=>file.startsWith('dist/')));
});

test('missing source import target is an independent closure failure',async t=>{
 const f=await fixture(t);await f.put('apps/api/src/main.ts',"import './missing-module.js';\n");
 const closure=await inspectHostedImportClosure({sourceRoot:f.source,files:f.files});
 assert.deepEqual(closure.unresolvedImports,["apps/api/src/main.ts -> ./missing-module.js"]);
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),/HOSTED_CONTEXT_IMPORT_TARGET_MISSING/);
 await assert.rejects(fs.lstat(f.destination),error=>error.code==='ENOENT');
});

test('existing allowed relative imports must be explicitly present in the manifest',async t=>{
 const f=await fixture(t);await f.put('apps/api/src/main.ts',"import './unlisted-module.js';\n");await f.put('apps/api/src/unlisted-module.ts','export const sourceOnly=true;');
 const closure=await inspectHostedImportClosure({sourceRoot:f.source,files:f.files});
 assert.deepEqual(closure.missingFromManifest,['apps/api/src/unlisted-module.ts']);
 await assert.rejects(createHostedBuildContext({sourceRoot:f.source,destination:f.destination}),/HOSTED_CONTEXT_IMPORT_NOT_IN_MANIFEST/);
 await assert.rejects(fs.lstat(f.destination),error=>error.code==='ENOENT');
});
