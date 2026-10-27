import {test} from 'node:test';
import assert from 'node:assert/strict';
import {type Tx} from '../../../database/src/client.js';
import {hash, byteHash, canonical} from '../canonical.js';
import {DomainError} from '../errors.js';
import {buildPolicyRetentionImpact, retentionEffectiveAt, retentionPatch, signPolicyRetentionReview, readPolicyRetentionReview, assertPolicyRetentionReview, assertResourceRetainedTx, policyRetentionDeadline, type RetentionResource} from './policy.js';
import {cleanPolicyObjects, type PolicyObjectReceipt} from './policy-cleanup.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID, generateKeyPairSync, sign, type KeyObject} from 'node:crypto';
import {recoveryReceiptDiagnostics} from './recovery-receipts.js';

// policy
const policy={raw_upload_retention_days:30,canonical_event_retention_days:180,attachment_retention_days:90,report_retention_days:365,audit_retention_days:365};
const asOf='2026-10-11T00:00:00.000Z',effective='2026-10-18T00:00:00.000Z',secret='explicit-test-harness-signing-secret-32bytes';
function resource(kind:RetentionResource['resource_kind'],id:string,captured:string,field:RetentionResource['policy_field'],extras:Partial<RetentionResource>={}):RetentionResource{return {resource_kind:kind,resource_id:id,case_id:'case-a',captured_at:captured,content_hash:hash(id),revision_id:'revision-a',resource_revision:null,object_keys:[],policy_field:field,binding:{table:kind},snapshot_ids:[],evidence_ids:[],artifact_ids:[],shared_reference_count:0,...extras};}
const raw=resource('raw_import','raw','2026-10-09T00:00:00.000Z','raw_upload_retention_days',{binding:{table:'imports',event_time:'2001-01-01T00:00:00Z'}});
const snapshot=resource('snapshot','snapshot','2026-09-01T00:00:00.000Z','canonical_event_retention_days',{object_keys:['a'.repeat(64)],snapshot_ids:['snapshot'],shared_reference_count:1});
const attachment=resource('evidence_artifact','attachment','2026-09-15T00:00:00.000Z','attachment_retention_days',{evidence_ids:['evidence'],artifact_ids:['attachment'],object_keys:['b'.repeat(64)]});
const report=resource('report','report','2026-10-10T00:00:00.000Z','report_retention_days',{snapshot_ids:['snapshot'],evidence_ids:['evidence'],binding:{table:'report_versions',input_manifest_hash:'frozen-report-input'}});
const download=resource('report_export','download','2026-10-11T00:00:00.000Z','report_retention_days',{artifact_ids:['attachment'],binding:{table:'report_exports',report_id:'report'},object_keys:['c'.repeat(64)]});
const other=resource('snapshot','unrelated','2026-10-09T00:00:00.000Z','canonical_event_retention_days',{case_id:'other-case',snapshot_ids:['unrelated']});
test('explicit clock fixture: server capture age, grace, cited reports/downloads, and shared objects are deterministic',()=>{
 const impact=buildPolicyRetentionImpact([raw,snapshot,attachment,report,download,other],policy,retentionPatch({raw_upload_retention_days:30,canonical_event_retention_days:1,attachment_retention_days:1}),asOf,effective),get=(id:string)=>impact.resources.find(r=>r.resource_id===id)!;
 assert.equal(get('raw').age_days,2);assert.equal(get('raw').expires_at,'2026-11-08T00:00:00.000Z'); // Old event occurrence does not age a new upload.
 assert.equal(get('snapshot').age_days,40);assert.equal(get('snapshot').expires_at,effective);assert.equal(get('snapshot').previous_expires_at,'2027-02-28T00:00:00.000Z');
 assert.equal(get('snapshot').shared_reference_count,1);assert.equal(get('unrelated').case_id,'other-case');
 assert.deepEqual(get('report').caused_by.map(r=>r.resource_id),['attachment','snapshot']);assert.equal(get('report').expires_at,effective);assert.equal(get('report').content_hash,hash('report'));assert.equal(get('report').revision_id,'revision-a');
 assert.deepEqual(get('download').caused_by.map(r=>r.resource_id),['attachment','report']);assert.equal(get('download').expires_at,effective);assert.equal(impact.affected_citations,2);assert.equal(impact.physical_cleanup,'pending_separate_review');
 assert.deepEqual(get('snapshot').cited_reports.map(r=>r.resource_id),['report']);assert.deepEqual(get('attachment').report_downloads.map(r=>r.resource_id),['download']);assert.equal(impact.counts.total,6);
 assert.equal(retentionEffectiveAt(asOf),effective);assert.equal(retentionEffectiveAt(asOf,'2026-10-25T00:00:00.000Z'),'2026-10-25T00:00:00.000Z');
 assert.throws(()=>retentionEffectiveAt(asOf,'2026-10-17T23:59:59.999Z'),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_GRACE_REQUIRED');
 assert.throws(()=>retentionPatch({raw_upload_retention_days:1.5}),/integral days/);
 const changed=buildPolicyRetentionImpact([raw,snapshot,attachment,{...report,content_hash:hash('new-citation')},download,other],policy,{canonical_event_retention_days:1},asOf,effective);assert.notEqual(hash(changed),hash(buildPolicyRetentionImpact([raw,snapshot,attachment,report,download,other],policy,{canonical_event_retention_days:1},asOf,effective)));
 const rawOnly=buildPolicyRetentionImpact([raw,snapshot,report],policy,{raw_upload_retention_days:1},asOf,effective);assert.deepEqual(rawOnly.resources.map(r=>r.resource_id),['raw']); // Raw expiry cannot consume the independent canonical lifetime.
 const entries=[{resource_kind:'snapshot',resource_id:'snapshot',expires_at:'2026-12-01T00:00:00.000Z',binding:{retention_direct:true,direct_expires_at:'2026-12-01T00:00:00.000Z',policy_field:'canonical_event_retention_days',caused_by:[]}},{resource_kind:'evidence_artifact',resource_id:'attachment',expires_at:effective,binding:{retention_direct:true,direct_expires_at:effective,policy_field:'attachment_retention_days',caused_by:[]}},{resource_kind:'report',resource_id:'report',expires_at:effective,binding:{retention_direct:false,policy_field:'report_retention_days',caused_by:[{resource_kind:'snapshot',resource_id:'snapshot'},{resource_kind:'evidence_artifact',resource_id:'attachment'}]}}];
 assert.equal(policyRetentionDeadline(entries[2]!,entries,{canonical_event_retention_days:90}),Date.parse('2026-12-01T00:00:00.000Z')); // Extending the attachment period removes its earlier scheduled deadline; the still-current snapshot period remains authoritative.
 assert.equal(policyRetentionDeadline(entries[2]!,entries,{}),null);
});
test('signed review rejects tampering/stale citations and expiry guards deny pending bytes without older-policy fallback',async()=>{
 const review={version:1 as const,purpose:'policy-retention' as const,workspace_id:'wid',principal_id:'owner',policy_revision:3,previous_policy_hash:hash(policy),policy_hash:hash({...policy,canonical_event_retention_days:1}),patch_hash:hash({canonical_event_retention_days:1}),as_of:asOf,effective_at:effective,impact_hash:hash({citations:['report-v1']}),expires_at:'2026-10-11T00:05:00.000Z'};
 const token=signPolicyRetentionReview(review,secret),parsed=readPolicyRetentionReview(token,Date.parse('2026-10-11T00:01:00.000Z'),secret);assert.deepEqual(parsed,review);assertPolicyRetentionReview(parsed,{...review,principal_id:'owner'});
 assert.throws(()=>assertPolicyRetentionReview(parsed,{...review,impact_hash:hash({citations:['report-v2']})}),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_IMPACT_CHANGED');
 assert.throws(()=>assertPolicyRetentionReview(parsed,{...review,principal_id:'demoted-owner'}),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_IMPACT_CHANGED');
 assert.throws(()=>readPolicyRetentionReview(token.slice(0,-1)+(token.endsWith('A')?'B':'A'),Date.parse(asOf),secret),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_REVIEW_REQUIRED');
 assert.throws(()=>readPolicyRetentionReview(token,Date.parse('2026-10-11T00:05:00.000Z'),secret),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_REVIEW_EXPIRED');
 const scheduled={resource_kind:'snapshot',resource_id:'snapshot',change_id:'new',status:'scheduled',change_status:'scheduled',expires_at:'2001-01-01T00:00:00.000Z',binding:{policy_field:'canonical_event_retention_days',caused_by:[]}};
 const tx={query:async(sql:string)=>({rows:sql.includes('JOIN faultline.policy_retention_changes')?[scheduled]:sql.includes('workspace_policies')?[{value:{...policy,canonical_event_retention_days:1}}]:sql.includes('SELECT id,patch,status')?[{id:'new',patch:{canonical_event_retention_days:1},status:'scheduled',effective_at:'2001-01-01T00:00:00.000Z'},{id:'older',patch:{canonical_event_retention_days:365},status:'scheduled',effective_at:'2000-01-01T00:00:00.000Z'}]:sql.includes('SELECT resource_kind,resource_id,binding')?[scheduled]:[]})} as unknown as Tx;
 await assert.rejects(assertResourceRetainedTx(tx,'wid','snapshot','snapshot'),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_EXPIRED');
 const bytesStillPresent={query:async()=>({rows:[{...scheduled,status:'expired_pending_cleanup',expired_at:'2001-01-01T00:00:00.000Z'}]})} as unknown as Tx;
 await assert.rejects(assertResourceRetainedTx(bytesStillPresent,'wid','snapshot','snapshot'),(e:unknown)=>e instanceof DomainError&&e.code==='RETENTION_EXPIRED');
});

// policy cleanup
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
function journal(rows:PolicyObjectReceipt[]=[]){return new Map(rows.map(row=>[row.object_key,row]));}

test("retention cleanup journals exact unshared removals and explicitly preserves shared bytes", async () => {
 // policy object cleanup skips committed items and records exact unshared removals
 {
  const rows=journal([{object_key:a,status:'removed'}]),calls:string[]=[];
    const result=await cleanPolicyObjects({keys:[a,b],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
    assert.deepEqual(calls,[b]);assert.deepEqual(result,{status:'complete',removed:2,retained_shared:0,failed:0});assert.equal(rows.get(b)?.status,'removed');
 }
 // shared bytes are retained explicitly while the scoped resource can finish cleanup
 {
  const rows=journal(),calls:string[]=[];
    const result=await cleanPolicyObjects({keys:[a,b],existing:[],sharedKeys:new Set([a]),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
    assert.deepEqual(calls,[b]);assert.deepEqual(result,{status:'complete',removed:1,retained_shared:1,failed:0});assert.equal(rows.get(a)?.status,'retained_shared');
 }
});

test("retention cleanup retries crashes and failures but rejects invalid journals", async () => {
 // a failed remove stays retryable and does not imply cleanup success
 {
  const rows=journal(),calls:string[]=[];let fail=true;
    const result=await cleanPolicyObjects({keys:[a],existing:[],sharedKeys:new Set(),remove:async key=>{calls.push(key);if(fail)throw Error('synthetic unlink failure');},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
    assert.deepEqual(result,{status:'pending',removed:0,retained_shared:0,failed:1});assert.equal(rows.get(a)?.status,'failed');
    fail=false;
    const retry=await cleanPolicyObjects({keys:[a],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{calls.push(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
    assert.deepEqual(retry,{status:'complete',removed:1,retained_shared:0,failed:0});assert.equal(calls.length,2);assert.equal(rows.get(a)?.status,'removed');
 }
 // crash after unlink but before journal commit retries safely as already absent
 {
  const rows=journal(),present=new Set([a]);let loseCommit=true,unlinkCalls=0;
    const remove=async(key:string)=>{unlinkCalls++;present.delete(key);};
    const record=async(key:string,status:PolicyObjectReceipt['status'],error_code:string|null)=>{if(status==='removed'&&loseCommit){loseCommit=false;throw Error('synthetic transaction loss after unlink');}rows.set(key,{object_key:key,status,error_code});};
    const first=await cleanPolicyObjects({keys:[a],existing:[],sharedKeys:new Set(),remove,record});
    assert.equal(first.status,'pending');assert.equal(rows.get(a)?.status,'failed');assert.equal(present.has(a),false);
    const second=await cleanPolicyObjects({keys:[a],existing:[...rows.values()],sharedKeys:new Set(),remove:async key=>{unlinkCalls++;present.delete(key);},record:async(key,status,error_code)=>{rows.set(key,{object_key:key,status,error_code});}});
    assert.equal(second.status,'complete');assert.equal(rows.get(a)?.status,'removed');assert.equal(unlinkCalls,2);assert.equal(present.has(a),false);
 }
 // malformed, duplicated, and foreign journal objects reject before cleanup
 {
  let calls=0;const remove=async()=>{calls++;};const record=async()=>{};
    await assert.rejects(cleanPolicyObjects({keys:['../private'],existing:[],sharedKeys:new Set(),remove,record}),/exact unique object hashes/);
    await assert.rejects(cleanPolicyObjects({keys:[a,a],existing:[],sharedKeys:new Set(),remove,record}),/exact unique object hashes/);
    await assert.rejects(cleanPolicyObjects({keys:[a],existing:[{object_key:b,status:'removed'}],sharedKeys:new Set(),remove,record}),/journal differs/);
    assert.equal(calls,0);
 }
});

// recovery receipts
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-recovery-diagnostics-')),keys=generateKeyPairSync('ed25519'),publicPath=path.join(root,'.runtime/keys/report-public.pem');await fs.mkdir(path.join(root,'reports/application'),{recursive:true});await fs.mkdir(path.join(root,'.runtime/backups'),{recursive:true});await fs.mkdir(path.dirname(publicPath),{recursive:true});await fs.writeFile(publicPath,keys.publicKey.export({format:'pem',type:'spki'}));return {root,privateKey:keys.privateKey,publicKey:keys.publicKey,publicPath};}
async function put(root:string,operation:'backup'|'restore',id:string,value:Record<string,unknown>,privateKey:KeyObject,publicKey:KeyObject){const unsigned={...value},receipt_signature={schema_version:1,signer_sha256:byteHash(publicKey.export({format:'der',type:'spki'})),signature:sign(null,Buffer.from(canonical(unsigned)),privateKey).toString('base64')};await fs.writeFile(path.join(root,'reports/application',`ops-${operation}-${id}.json`),JSON.stringify({...unsigned,receipt_signature}));}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test("recovery diagnostics verify signed archive, restore, key and time bindings", async () => {
 // diagnostics reports signed archive evidence and restore only when bound to that archive
 {
  const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic encrypted backup bytes');
    try{
     const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archiveHash=digest(archive),manifestHash='a'.repeat(64);await fs.writeFile(archivePath,archive);
     await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,checked_at:'2026-10-14T10:00:00.000Z',key_versions:['active','retiring'],archive_path:archivePath,archive_sha256:archiveHash,manifest_hash:manifestHash},privateKey,publicKey);
     await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,checked_at:'2026-10-14T10:05:00.000Z',key_versions:['active','retiring'],archive_sha256:archiveHash,manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
     const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'verified');assert.equal(result.backup.detail,'authenticated_archive');assert.deepEqual(result.backup.key_versions,['active','retiring']);assert.equal(result.backup.recorded_at,'2026-10-14T10:00:00.000Z');assert.equal(result.restore.status,'verified');assert.equal(result.restore.detail,'isolated_restore_bound_to_archive');assert.deepEqual(result.restore.key_versions,['active','retiring']);assert.equal(result.restore.recorded_at,'2026-10-14T10:05:00.000Z');
    }finally{await fs.rm(root,{recursive:true,force:true});}
 }
 // tampered archive bytes and unbound restore reports never project as verified
 {
  const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic backup');
    try{
     const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),manifestHash='b'.repeat(64);await fs.writeFile(archivePath,Buffer.from('changed backup'));
     await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,archive_path:archivePath,archive_sha256:digest(archive),manifest_hash:manifestHash},privateKey,publicKey);
     await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,archive_sha256:digest(archive),manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
     const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'unverified');assert.equal(result.restore.status,'unverified');
    }finally{await fs.rm(root,{recursive:true,force:true});}
 }
 // unsigned or altered receipt data remains unverified and an empty directory is not a pass
 {
  const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID();
    try{
     const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archive=Buffer.from('synthetic backup');await fs.writeFile(archivePath,archive);
     await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,archive_path:archivePath,archive_sha256:digest(archive),manifest_hash:'c'.repeat(64)},privateKey,publicKey);
     const reportPath=path.join(root,'reports/application',`ops-backup-${backupId}.json`),report=JSON.parse(await fs.readFile(reportPath,'utf8'));report.status='failed';await fs.writeFile(reportPath,JSON.stringify(report));
     assert.equal((await recoveryReceiptDiagnostics(root,publicPath)).backup.status,'unverified');
     await fs.rm(reportPath);const empty=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(empty.backup.status,'not_run');assert.equal(empty.restore.status,'not_run');
    }finally{await fs.rm(root,{recursive:true,force:true});}
 }
 // recovery receipts fail closed when signed key inventory differs or restore predates backup
 {
  const {root,privateKey,publicKey,publicPath}=await setup(),backupId=randomUUID(),restoreId=randomUUID(),archive=Buffer.from('synthetic encrypted backup bytes');
    try{
     const archivePath=path.join(root,'.runtime/backups',`faultline-${backupId}.flbackup`),archiveHash=digest(archive),manifestHash='d'.repeat(64);await fs.writeFile(archivePath,archive);
     await put(root,'backup',backupId,{operation:'backup',status:'complete_restore_not_run',id:backupId,checked_at:'2026-10-14T10:05:00.000Z',key_versions:['active','retiring'],archive_path:archivePath,archive_sha256:archiveHash,manifest_hash:manifestHash},privateKey,publicKey);
     await put(root,'restore',restoreId,{operation:'restore',status:'isolated_restore_verified',id:restoreId,checked_at:'2026-10-14T10:04:00.000Z',key_versions:['active'],archive_sha256:archiveHash,manifest_hash:manifestHash,runtime_roles_verified:true,auth_tenant_access:false,tenant_without_scope_rows:0},privateKey,publicKey);
     const result=await recoveryReceiptDiagnostics(root,publicPath);assert.equal(result.backup.status,'verified');assert.equal(result.restore.status,'unverified');assert.equal(result.restore.key_versions,null);
    }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});
