import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidenceRecords} from './parser.js';

const captured='2026-10-11T20:00:00.000Z';
const mapping={record_kind:'release' as const,schema_version:1 as const,id:['metadata','id'],text:['metadata','description'],provenance:['metadata','commit']};
const release=(commit:unknown)=>({metadata:{id:'release-1',description:'Reported release record',commit},deployment_status:'deployed'});
test('finite reported release references survive normalization without deployment or verification promotion',()=>{
 const r=normalizeEvidenceRecords(Buffer.from(JSON.stringify([release('abc123-user-attested')])), 'json','release','source-1',captured,mapping);
 assert.equal(r.canFinalize,true);assert.equal(r.records[0]!.provenance,'abc123-user-attested');
 assert.equal(r.records[0]!.deployment_status,'not_proven_by_release_record');
 assert.equal(r.records[0]!.verification_status,'not_established_by_import');
 assert.equal(r.records[0]!.event_time.kind,'unknown');
 assert(r.issues.some(i=>i.code==='UNVERIFIED_DEPLOYMENT_CLAIM'));
});
test('reported references are bounded strings and conflicting references cannot silently replace an evidence identity',()=>{
 for(const value of [23,{},'x'.repeat(1001)]){
  const r=normalizeEvidenceRecords(Buffer.from(JSON.stringify([release(value)])),'json','release','source-1',captured,mapping);
  assert.equal(r.canFinalize,false);assert.equal(r.counts.accepted,0);assert(r.issues.some(i=>i.code==='INVALID_PROVENANCE'));
 }
 const conflict=normalizeEvidenceRecords(Buffer.from(JSON.stringify([release('old'),release('new')])),'json','release','source-1',captured,mapping);
 assert.equal(conflict.canFinalize,false);assert.equal(conflict.counts.conflicts,1);assert(conflict.issues.some(i=>i.code==='CONFLICTING_DUPLICATE'));
});
