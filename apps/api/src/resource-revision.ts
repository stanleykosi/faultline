import {demand} from '../../../packages/core/src/errors.js';

/** Numeric application revisions and approval hashes are not HTTP entity tags.
 * Keep the legacy API header, but never resolve conflicting concurrency bindings. */
export function resourceRevision(headers:Record<string,string|string[]|undefined>,required?:true):string;
export function resourceRevision(headers:Record<string,string|string[]|undefined>,required:false):string|undefined;
export function resourceRevision(headers:Record<string,string|string[]|undefined>,required=true){
 const current=headers['x-faultline-revision'],legacy=headers['if-match'];
 for(const value of [current,legacy])demand(value===undefined||typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x20,]/.test(value),'REVISION_REQUIRED','Provide a single reviewed resource revision.',400);
 demand(current===undefined||legacy===undefined||current===legacy,'REVISION_CONFLICT','Conflicting resource revisions. Refresh and review again.',400);
 const value=current??legacy;
 demand(!required||typeof value==='string','REVISION_REQUIRED','Provide X-Faultline-Revision with the reviewed resource revision.',400);
 return value;
}
