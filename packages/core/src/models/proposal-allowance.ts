import {DomainError} from '../errors.js';
import {modelOutputAllowance} from './limits.js';

/** A repair that cannot reserve capacity must not hide the rejected response's
 * original validation failure. No reservation, refund or extra call is granted. */
export function proposalReservationFailure(error:unknown,previous?:unknown):unknown {
 return previous!==undefined&&error instanceof DomainError&&['MODEL_BUDGET_EXHAUSTED','MODEL_REPAIR_EXHAUSTED'].includes(error.code)?previous:error;
}

/** Per-call allowance within configured installation and revision policy limits. */
export function proposalOutputAllowance(policyLimit:number,reserved:number,spent:number):number {
 return modelOutputAllowance(policyLimit,reserved,spent);
}
