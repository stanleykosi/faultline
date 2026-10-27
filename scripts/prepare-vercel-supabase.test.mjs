import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {allowedSource,prepareVercelSupabase} from './prepare-vercel-supabase.mjs';

test('private and test paths are excluded while required source remains eligible',()=>{
  for(const name of ['.env.local','apps/api/src/.env','apps/api/src/credentials.json','packages/core/src/secrets/owner.ts','apps/web/src/node_modules/x.ts','apps/api/src/auth.test.ts','reports/private.ts']) assert.equal(allowedSource(name),false,name);
  assert.equal(allowedSource('packages/core/src/secrets/keyring.ts'),true);
  assert.equal(allowedSource('apps/web/src/features/reports/Report.tsx'),true);
  assert.equal(allowedSource('apps/api/src/vercel.ts'),true);
});

test('Vercel is the active profile and historical Railway settings remain isolated',async()=>{
  assert.deepEqual(await fs.readFile('vercel.json'),await fs.readFile('ops/hosting/vercel-supabase/vercel.json'));
  assert.deepEqual(await fs.readFile('Dockerfile'),await fs.readFile('ops/hosting/vercel-supabase/Dockerfile'));
  const legacy=JSON.parse(await fs.readFile('ops/hosting/railway/vercel.frontend.json','utf8'));
  assert.deepEqual(legacy.rewrites.slice(0,2).map(rule=>rule.destination),['https://your-faultline-api.invalid/api','https://your-faultline-api.invalid/api/:path*']);
  assert.equal(legacy.rewrites.at(-1).destination,'/index.html');
  for(const [source,snapshot] of [
    ['ops/staging/railway.json.example','railway.json.example'],
    ['ops/staging/railway-runner.json.example','railway-runner.json.example'],
    ['ops/images/Dockerfile','Dockerfile'],
    ['ops/images/Runner.Dockerfile','Runner.Dockerfile'],
  ]) assert.deepEqual(await fs.readFile(source),await fs.readFile('ops/hosting/railway/'+snapshot),source);
});

test('context is allowlisted, hashes exact inputs, and refuses overwrite',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-vercel-test-'));
  const destination=path.join(parent,'context');
  try {
    const result=await prepareVercelSupabase({destination});
    assert.ok(result.fileCount>50);
    const names=result.manifest.map(item=>item.path);
    assert.ok(names.includes('apps/api/src/vercel.ts'));
    assert.ok(names.includes('scripts/initialize-vercel-runtime.mjs'));
    assert.ok(names.includes('config/certs/supabase-root-ca.crt'));
    assert.ok(names.includes('scripts/start-vercel-worker.mjs'));
    assert.ok(names.includes('packages/core/src/secrets/keyring.ts'));
    assert.ok(names.includes('packages/core/src/secrets/replacements.ts'));
    assert.ok(names.every(name=>!name.includes('node_modules')&&!name.includes('.test.')&&!name.startsWith('.env')&&!name.startsWith('reports/')));
    const config=JSON.parse(await fs.readFile(path.join(destination,'vercel.json'),'utf8'));
    assert.match(config.installCommand,/--prod=false/,'production runtime settings must not omit build tools');
    assert.equal(config.functions['api/index.ts'].maxDuration,60);
    assert.equal(config.rewrites,undefined,'named rewrite captures must not enter strict API query schemas');
    assert.equal(config.routes[0].src,'^/api(?:/.*)?$');
    assert.equal(config.routes[0].dest,'/api/index');
    assert.deepEqual(config.routes[2],{handle:'filesystem'});
    assert.equal(await fs.readFile(path.join(destination,'api/index.ts'),'utf8'),"export {default} from '../apps/api/src/vercel.js';\n");
    assert.equal(config.daemons.worker.instances.iad1,1);
    assert.ok(['Dockerfile','Containerfile'].includes(path.posix.basename(config.daemons.worker.entrypoint)));
    assert.ok((await fs.stat(path.join(destination,config.daemons.worker.root,config.daemons.worker.entrypoint))).isFile());
    assert.ok((await fs.stat(path.join(destination,path.posix.dirname(config.daemons.worker.entrypoint),'package.json'))).isFile());
    assert.ok(!JSON.stringify(config).includes('railway.app'));
    assert.equal(await fs.readFile(path.join(destination,'package.json'),'utf8'),await fs.readFile('package.json','utf8'));
    await assert.rejects(prepareVercelSupabase({destination}),/DESTINATION_EXISTS/);
    await assert.rejects(prepareVercelSupabase({destination:path.join(process.cwd(),'artifacts','unsafe')}),/DESTINATION_MUST_BE_DISJOINT|ENOENT/);
    const manifest=JSON.parse(await fs.readFile(path.join(destination,'vercel-context-manifest.json'),'utf8'));
    assert.ok(manifest.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
    for(const file of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(destination,file.path))).digest('hex'),file.sha256,file.path);
    // Treat the first generated context as an isolated synthetic source tree.
    await fs.writeFile(path.join(destination,'.env.local'),'PRIVATE_SENTINEL');
    await fs.writeFile(path.join(destination,'apps/api/src/credentials.json'),'PRIVATE_SENTINEL');
    await fs.writeFile(path.join(destination,'apps/api/src/negative.test.ts'),'PRIVATE_SENTINEL');
    await fs.writeFile(path.join(destination,'unrelated.txt'),'PRIVATE_SENTINEL');
    const second=await prepareVercelSupabase({sourceRoot:destination,destination:path.join(parent,'second')});
    for(const privateFile of ['.env.local','apps/api/src/credentials.json','apps/api/src/negative.test.ts','unrelated.txt']) await assert.rejects(fs.stat(path.join(second.destination,privateFile)),{code:'ENOENT'});
    const outside=path.join(parent,'private-outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside,'leak.ts'),'PRIVATE_SENTINEL');
    await fs.symlink(outside,path.join(destination,'apps/api/src/junction'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(prepareVercelSupabase({sourceRoot:destination,destination:path.join(parent,'third')}),/SYMLINK_REFUSED/);
  } finally {await fs.rm(parent,{recursive:true,force:true});}
});
