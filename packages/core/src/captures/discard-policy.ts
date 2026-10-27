import {demand} from '../errors.js';

export function requireVisibleImport(record:{stage:string}|null|undefined):void {
  demand(record && record.stage !== 'discarded', 'NOT_FOUND', 'Import unavailable.', 404);
}

/** Logical discard keeps all raw bytes and retention bindings intact. */
export function requireDiscardableImport(record:{stage:string;snapshot_id?:string|null;job_id?:string|null}, dependencies:{snapshot:boolean;activeJob:boolean}) {
  requireVisibleImport(record);
  demand(['staged','mapped','review_ready','blocked'].includes(record.stage) && !record.snapshot_id && !record.job_id && !dependencies.snapshot && !dependencies.activeJob, 'IMPORT_IMMUTABLE', 'Only an unqueued, uncaptured staged import can be discarded.', 409);
}
