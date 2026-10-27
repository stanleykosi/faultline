import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentCommands,resolveVercelCli} from './deploy-vercel.mjs';
test('one command uploads source for a combined remote deployment without local build or automatic live-domain replacement',()=>{
 const commands=deploymentCommands('/synthetic/context');assert.equal(commands.length,2);assert.ok(commands.every(c=>c.cwd==='/synthetic/context'));
 assert.equal(commands[0].args[0],'link');const deploy=commands[1].args;assert.equal(deploy[0],'deploy');assert.ok(deploy.includes('--prod'));assert.ok(deploy.includes('--skip-domain'));assert.ok(!deploy.includes('--prebuilt'));assert.ok(!commands.some(c=>c.args.includes('build')));
 const dry=deploymentCommands('/synthetic/context',{dry:true})[1].args;assert.ok(dry.includes('--dry'));assert.ok(!dry.includes('--prod'));
});
test('missing CLI fails explicitly instead of installing software or changing authentication',async()=>{
 await assert.rejects(resolveVercelCli({PATH:''}),/Install and authenticate/);
});
