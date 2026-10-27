import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID,generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import {recoveryReceiptDiagnostics} from './recovery-receipts.js';
import {byteHash,canonical} from '../canonical.js';

async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-recovery-diagnostics-')),keys=generateKeyPairSync('ed25519'),publicPath=path.join(root,'.runtime/keys/report-public.pem');await fs.mkdir(path.join(root,'reports/application'),{recursive:true});await fs.mkdir(path.join(root,'.runtime/backups'),{recursive:true});await fs.mkdir(path.dirname(publicPath),{recursive:true});await fs.writeFile(publicPath,keys.publicKey.export({format:'pem',type:'spki'}));return {root,privateKey:keys.privateKey,publicKey:keys.publicKey,publicPath};}
async function put(root:string,operation:'backup'|'restore',id:string,value:Record<string,unknown>,privateKey:KeyObject,publicKey:KeyObject){const unsigned={...value},receipt_signature={schema_version:1,signer_sha256:byteHash(publicKey.export({format:'der',type:'spki'})),signature:sign(null,Buffer.from(canonical(unsigned)),privateKey).toString('base64')};await fs.writeFile(path.join(root,'reports/application',`ops-${operation}-${id}.json`),JSON.stringify({...unsigned,receipt_signature}));}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('diagnostics reports signed archive evidence and restore only when bound to that archive',async()=>{
 const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic encrypted backup bytes');
 try{
  const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archiveHash=digest(archive),manifestHash='a'.repeat(64);await fs.writeFile(archivePath,archive);
  await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,checked_at:'2026-10-14T10:00:00.000Z',key_versions:['active','retiring'],archive_path:archivePath,archive_sha256:archiveHash,manifest_hash:manifestHash},privateKey,publicKey);
  await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,checked_at:'2026-10-14T10:05:00.000Z',key_versions:['active','retiring'],archive_sha256:archiveHash,manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
  const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'verified');assert.equal(result.backup.detail,'authenticated_archive');assert.deepEqual(result.backup.key_versions,['active','retiring']);assert.equal(result.backup.recorded_at,'2026-10-14T10:00:00.000Z');assert.equal(result.restore.status,'verified');assert.equal(result.restore.detail,'isolated_restore_bound_to_archive');assert.deepEqual(result.restore.key_versions,['active','retiring']);assert.equal(result.restore.recorded_at,'2026-10-14T10:05:00.000Z');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('tampered archive bytes and unbound restore reports never project as verified',async()=>{
 const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic backup');
 try{
  const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),manifestHash='b'.repeat(64);await fs.writeFile(archivePath,Buffer.from('changed backup'));
  await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,archive_path:archivePath,archive_sha256:digest(archive),manifest_hash:manifestHash},privateKey,publicKey);
  await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,archive_sha256:digest(archive),manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
  const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'unverified');assert.equal(result.restore.status,'unverified');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unsigned or altered receipt data remains unverified and an empty directory is not a pass',async()=>{
 const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID();
 try{
  const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archive=Buffer.from('synthetic backup');await fs.writeFile(archivePath,archive);
  await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,archive_path:archivePath,archive_sha256:digest(archive),manifest_hash:'c'.repeat(64)},privateKey,publicKey);
  const reportPath=path.join(root,'reports/application',`ops-backup-${backupId}.json`),report=JSON.parse(await fs.readFile(reportPath,'utf8'));report.status='failed';await fs.writeFile(reportPath,JSON.stringify(report));
  assert.equal((await recoveryReceiptDiagnostics(root,publicPath)).backup.status,'unverified');
  await fs.rm(reportPath);const empty=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(empty.backup.status,'not_run');assert.equal(empty.restore.status,'not_run');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('recovery receipts fail closed when signed key inventory differs or restore predates backup',async()=>{
 const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic encrypted backup bytes');
 try{
  const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archiveHash=digest(archive),manifestHash='d'.repeat(64);await fs.writeFile(archivePath,archive);
  await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,checked_at:'2026-10-14T10:05:00.000Z',key_versions:['active','retiring'],archive_path:archivePath,archive_sha256:archiveHash,manifest_hash:manifestHash},privateKey,publicKey);
  await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,checked_at:'2026-10-14T10:04:00.000Z',key_versions:['active'],archive_sha256:archiveHash,manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
  const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'verified');assert.equal(result.restore.status,'unverified');assert.equal(result.restore.key_versions,null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
