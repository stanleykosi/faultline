import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {planStorageReconciliation} from './reconciliation.js';
test('offline reconciliation restores missing accounting only from verified bytes and preserves ambiguous orphan reservations',()=>{
 const cid=randomUUID(),other=randomUUID(),a='a'.repeat(64),b='b'.repeat(64),inventory=[{key:a,sha256:a,size_bytes:20,kind:'object' as const},{key:b,sha256:b,size_bytes:30,kind:'object' as const}],refs=[{case_id:other,object_key:b,size_bytes:30}],durable=[{case_id:cid,object_key:a,size_bytes:20}],account={used_bytes:0,reserved_bytes:200,ceiling:1000};
 const complete=planStorageReconciliation(cid,inventory,refs,durable,account,[100,100]);assert.equal(complete.used_bytes,20);assert.equal(complete.reserved_bytes,0);assert.equal(complete.release_reservations,true);assert.deepEqual(complete.add_references,[{object_key:a,size_bytes:20}]);
 const partial={key:'.partial-'+randomUUID(),sha256:'c'.repeat(64),size_bytes:50,kind:'partial' as const},ambiguous=planStorageReconciliation(cid,[...inventory,partial],refs,durable,account,[100,100]);assert.equal(ambiguous.release_reservations,false);assert.equal(ambiguous.reserved_bytes,200);assert.equal(ambiguous.retained_unreferenced_bytes,50);assert.equal(ambiguous.retained_partial_count,1);
 assert.throws(()=>planStorageReconciliation(cid,[inventory[0]!],refs,durable,account,[]),/no verified/);assert.throws(()=>planStorageReconciliation(cid,inventory,refs,[{...durable[0]!,size_bytes:21}],account,[]),/length differs/);assert.throws(()=>planStorageReconciliation(cid,[...inventory,partial],refs,durable,{...account,ceiling:100},[200]),/budget/);assert.equal(refs.length,1);assert.equal(inventory.length,2);
});
