import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRecoveryCapacity,MIN_RECOVERY_FREE_BYTES} from '../../tools/ops/recovery-capacity.js';
import {DomainError} from '../../packages/core/src/errors.js';
test('recovery capacity rejects unknown and insufficient storage before any database or object work',()=>{
 for(const bytes of [NaN,Infinity,-1,0,MIN_RECOVERY_FREE_BYTES-1,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertRecoveryCapacity(bytes),(error:unknown)=>error instanceof DomainError&&error.code==='RECOVERY_STORAGE_CAPACITY'&&error.status===503);
 assertRecoveryCapacity(MIN_RECOVERY_FREE_BYTES);assertRecoveryCapacity(MIN_RECOVERY_FREE_BYTES+1);
});
