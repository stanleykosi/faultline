import {validateContract} from '../../../contracts/src/validate.js';
import type {FaultlineVerificationResult} from '../../../contracts/src/generated.js';

/** Current list truth is derived; the immutable stored verdict is never rewritten. */
export function listedVerificationResult(value:FaultlineVerificationResult,freshness:'fresh'|'stale'):FaultlineVerificationResult {
 const projected = freshness==='fresh' ? {...value,freshness} : {...value,freshness,correction:value.correction==='validated'?'inconclusive' as const:value.correction,production_claim_eligible:false,reasons:[...new Set(['stale_inputs',...value.reasons])].slice(0,30)};
 return validateContract<FaultlineVerificationResult>('verification-result',projected);
}
