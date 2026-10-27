import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRunnerBuildContext} from '../../scripts/package-runner-context.mjs';

test('runner deployment context is allowlisted and selects only the external controller entry point',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-runner-context-test-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const destination=path.join(parent,'context');
 const result=await createRunnerBuildContext({sourceRoot:process.cwd(),destination});
 const config=JSON.parse(await fs.readFile(path.join(destination,'railway.json'),'utf8'));
 assert.equal(config.build.dockerfilePath,'ops/images/Runner.Dockerfile');
 assert.equal(config.deploy.startCommand,'node --max-old-space-size=128 dist/server/apps/runner/src/external-main.js');
 assert.equal(config.deploy.healthcheckPath,'/health/ready');
 assert.ok(result.files.includes('apps/runner/src/railway-sandbox.ts'));
 assert.ok(result.files.includes('ops/images/Runner.Dockerfile'));
 assert.ok(!result.files.some(file=>file.startsWith('reports/')||file.startsWith('.runtime/')||file.includes('.env')));
});
