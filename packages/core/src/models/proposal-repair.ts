import {ModelWireError} from './gateway.js';

/** Repair instructions contain only product-owned wording and finite diagnostics.
 * Rejected provider text is never added to a subsequent model request. */
export function proposalRepairMessage(code:string,error:unknown):string {
 const safeCode=/^[A-Z][A-Z_]{1,63}$/.test(code)?code:'INVALID_MODEL_PROPOSAL';
 const issue=error instanceof ModelWireError&&safeCode==='MODEL_NUMERIC_CLAIM_UNSUPPORTED'?error.numeric_issue:undefined;
 const detail=issue?.kind==='number_word'&&issue.word
  ?' Forbidden number word: '+issue.word+'. All human prose must avoid number words, including one/ones/once used as pronouns or conjunctions. Say if/when instead of once; name cohorts instead of one/ones.'
  :issue?.kind==='number_symbol'?' All human prose must omit digits, numeric symbols and percentages. Deterministic panels own quantities.':'';
 return 'Schema/domain validation failed with '+safeCode+'.'+detail+' Return only the required object with the same original revision/input binding and allowed evidence. Do not change facts, controls, or acquire new authority.';
}
