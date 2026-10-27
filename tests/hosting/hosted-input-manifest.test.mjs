import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';

const manifestUrl=new URL('../../ops/staging/hosted-build-inputs.json',import.meta.url);
const migrationDirectory=new URL('../../packages/database/migrations/',import.meta.url);
const runtimeManifestUrl=new URL('../../packages/database/src/runtime-migrations.ts',import.meta.url);

test('frozen hosted inputs include the exact contiguous migration set and generated runtime hashes',async()=>{
 const manifest=JSON.parse(await fs.readFile(manifestUrl,'utf8'));
 assert.equal(manifest.schemaVersion,1);
 assert.ok(Array.isArray(manifest.files));
 assert.deepEqual(manifest.files,[...manifest.files].sort((a,b)=>a.localeCompare(b)));
 assert.equal(new Set(manifest.files).size,manifest.files.length);
 const sourceNames=(await fs.readdir(migrationDirectory)).filter(name=>/^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
 const migrationPaths=manifest.files.filter(name=>name.startsWith('packages/database/migrations/'));
 assert.equal(sourceNames.length,29);
 assert.deepEqual(sourceNames.map((name,index)=>name.slice(0,4)),Array.from({length:29},(_,index)=>String(index+1).padStart(4,'0')));
 assert.deepEqual(migrationPaths,sourceNames.map(name=>`packages/database/migrations/${name}`));
 assert.ok(manifest.files.includes('packages/database/src/runtime-migrations.ts'));
 const runtimeSource=await fs.readFile(runtimeManifestUrl,'utf8');
 const runtimeJson=runtimeSource.match(/^export const runtimeMigrations = (\[[\s\S]*\]) as const;\s*$/m)?.[1];
 assert.ok(runtimeJson,'runtime migration manifest must retain its generated JSON representation');
 const runtimeMigrations=JSON.parse(runtimeJson);
 assert.deepEqual(runtimeMigrations.map(item=>item.id),sourceNames.map(name=>name.slice(0,-4)));
 for(let index=0;index<sourceNames.length;index++){
  const sql=await fs.readFile(new URL(sourceNames[index],migrationDirectory),'utf8');
  const expected=createHash('sha256').update(sql).digest('hex');
  assert.equal(runtimeMigrations[index].checksum,expected,`runtime checksum for ${sourceNames[index]}`);
 }
});

test('reviewed exception modules and hosted secret-management sources stay in the source manifest',async()=>{
 const manifest=JSON.parse(await fs.readFile(manifestUrl,'utf8'));
 for(const source of ['packages/core/src/reports/render.ts','packages/core/src/reports/service.ts','packages/core/src/reports/zip.ts','apps/web/src/features/providers/CredentialReplacement.tsx','packages/core/src/secrets/keyring.ts','packages/core/src/secrets/replacements.ts','scripts/hosted-private-runtime.mjs','scripts/initialize-private-volume.mjs']){
  assert.ok(manifest.files.includes(source),`missing public source module ${source}`);
  const stat=await fs.stat(new URL(`../../${source}`,import.meta.url));
  assert.ok(stat.isFile());
 }
});
