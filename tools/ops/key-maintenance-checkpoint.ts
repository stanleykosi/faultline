import {createHmac,timingSafeEqual} from 'node:crypto';
import {canonical,byteHash,hash} from '../../packages/core/src/canonical.js';
import {demand} from '../../packages/core/src/errors.js';

export type CheckpointEnvelope={identity:string;ciphertext:string;aad:string;key_version:string};
export type StagedEnvelope={identity:string;source_key_version:string;source_ciphertext_sha256:string;plaintext_sha256:string};
export type ReencryptionCheckpoint={
 schema_version:1;operation_id:string;active_key_version:string;status:'in_progress'|'complete';
 cursor:string|null;committed_inventory_hash:string;remaining_hash:string;final_inventory_hash:string|null;total_rows:number;rewritten:number;already_current:number;
 staged:StagedEnvelope[];started_at:string;updated_at:string;completed_at:string|null;signature:string;
};

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const version=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const identity=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/;
const envelopeIndex=(row:CheckpointEnvelope)=>({identity:row.identity,key_version:row.key_version,ciphertext_sha256:byteHash(Buffer.from(row.ciphertext))});

export function checkpointInventoryHash(rows:readonly CheckpointEnvelope[]):string{
 const ordered=[...rows].sort((a,b)=>a.identity.localeCompare(b.identity));
 demand(ordered.length<=10000&&ordered.every((row,index)=>identity.test(row.identity)&&version.test(row.key_version)&&typeof row.aad==='string'&&row.aad.length<=1024&&typeof row.ciphertext==='string'&&(index===0||ordered[index-1]!.identity!==row.identity)),'KEY_REENCRYPTION_INVENTORY_INVALID','Checkpoint inventory must contain at most 10000 unique bounded envelopes.',409);
 return hash(ordered.map(envelopeIndex));
}

function unsigned(checkpoint:ReencryptionCheckpoint){const {signature,...body}=checkpoint;return body;}
function signature(body:Record<string,unknown>,key:Buffer){demand(key.length===32,'KEY_REENCRYPTION_CHECKPOINT_KEY','Checkpoint requires the active 256-bit encryption key.',409);return createHmac('sha256',key).update('faultline:key-reencryption-checkpoint:v1\0').update(canonical(body)).digest('hex');}
export function signReencryptionCheckpoint(body:Omit<ReencryptionCheckpoint,'signature'>,key:Buffer):ReencryptionCheckpoint{return {...body,signature:signature(body as unknown as Record<string,unknown>,key)};}

export function verifyReencryptionCheckpoint(value:unknown,key:Buffer,activeVersion:string):ReencryptionCheckpoint{
 demand(value&&typeof value==='object'&&!Array.isArray(value),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint must be an object.',409);
 const row=value as ReencryptionCheckpoint;
 demand(Object.keys(row).sort().join(',')==='active_key_version,already_current,committed_inventory_hash,completed_at,cursor,final_inventory_hash,operation_id,remaining_hash,rewritten,schema_version,signature,staged,started_at,status,total_rows,updated_at','KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint has unknown or missing fields.',409);
 demand(row.schema_version===1&&uuid.test(row.operation_id)&&version.test(row.active_key_version)&&['in_progress','complete'].includes(row.status)&&sha.test(row.committed_inventory_hash)&&sha.test(row.remaining_hash)&&Number.isSafeInteger(row.total_rows)&&row.total_rows>=0&&row.total_rows<=10000&&Number.isSafeInteger(row.rewritten)&&row.rewritten>=0&&Number.isSafeInteger(row.already_current)&&row.already_current>=0&&row.rewritten+row.already_current<=row.total_rows&&Array.isArray(row.staged)&&row.staged.length<=250&&row.staged.every(item=>identity.test(item.identity)&&version.test(item.source_key_version)&&sha.test(item.source_ciphertext_sha256)&&sha.test(item.plaintext_sha256))&&typeof row.signature==='string'&&/^[a-f0-9]{64}$/.test(row.signature),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint fields are malformed or outside the finite batch bounds.',409);
 demand(row.active_key_version===activeVersion,'KEY_REENCRYPTION_CHECKPOINT_SCOPE','Checkpoint belongs to a different active key version.',409);
 demand(row.cursor===null||identity.test(row.cursor),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint cursor is malformed.',409);
 const completedCount=row.rewritten+row.already_current,orderedStaged=[...row.staged].sort((a,b)=>a.identity.localeCompare(b.identity));
 demand(row.status==='complete'?completedCount===row.total_rows&&row.staged.length===0&&row.cursor===null:completedCount+row.staged.length<=row.total_rows&&(completedCount===0?row.cursor===null:row.cursor!==null)&&orderedStaged.every((item,index)=>item.identity===row.staged[index]?.identity&&(index===0||orderedStaged[index-1]!.identity < item.identity)&&(!row.cursor||item.identity > row.cursor)),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint cursor, counters and staged identities disagree.',409);
 demand((row.final_inventory_hash===null||sha.test(row.final_inventory_hash))&&Number.isFinite(Date.parse(row.started_at))&&Number.isFinite(Date.parse(row.updated_at))&&(row.completed_at===null||Number.isFinite(Date.parse(row.completed_at)))&&(row.status==='complete' ? row.completed_at!==null&&row.final_inventory_hash!==null&&row.final_inventory_hash===row.committed_inventory_hash&&row.staged.length===0&&row.cursor===null&&row.remaining_hash===checkpointInventoryHash([]) : row.completed_at===null&&row.final_inventory_hash===null),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint timestamps or terminal state are inconsistent.',409);
 const wanted=signature(unsigned(row) as unknown as Record<string,unknown>,key),actual=Buffer.from(row.signature,'hex'),expected=Buffer.from(wanted,'hex');
 demand(actual.length===expected.length&&timingSafeEqual(actual,expected),'KEY_REENCRYPTION_CHECKPOINT_SIGNATURE','Checkpoint authentication failed.',409);
 return row;
}

export function startReencryptionCheckpoint(input:{operation_id:string;active_key_version:string;rows:readonly CheckpointEnvelope[];now?:string},key:Buffer):ReencryptionCheckpoint{
 demand(uuid.test(input.operation_id)&&version.test(input.active_key_version),'KEY_REENCRYPTION_CHECKPOINT_INVALID','Checkpoint identity and key version must be exact.',409);
 const now=input.now??new Date().toISOString(),total=input.rows.length;
 return signReencryptionCheckpoint({schema_version:1,operation_id:input.operation_id,active_key_version:input.active_key_version,status:'in_progress',cursor:null,committed_inventory_hash:checkpointInventoryHash([]),remaining_hash:checkpointInventoryHash(input.rows),final_inventory_hash:null,total_rows:total,rewritten:0,already_current:0,staged:[],started_at:now,updated_at:now,completed_at:null},key);
}

export function stageReencryptionBatch(checkpoint:ReencryptionCheckpoint,rows:readonly CheckpointEnvelope[],remaining:readonly CheckpointEnvelope[],plaintextHash:(row:CheckpointEnvelope)=>string,key:Buffer,now=new Date().toISOString()):ReencryptionCheckpoint{
 demand(checkpoint.status==='in_progress'&&checkpoint.staged.length===0&&rows.length>0&&rows.length<=250,'KEY_REENCRYPTION_CHECKPOINT_STATE','Only one nonempty finite batch can be staged at a time.',409);
 const ordered=[...rows].sort((a,b)=>a.identity.localeCompare(b.identity));
 demand(ordered.length===rows.length&&ordered.every((row,index)=>index===0||ordered[index-1]!.identity!==row.identity)&&(!checkpoint.cursor||ordered[0]!.identity>checkpoint.cursor),'KEY_REENCRYPTION_BATCH_ORDER','Batch identities must be unique and after the durable cursor.',409);
 demand(checkpointInventoryHash([...ordered,...remaining])===checkpoint.remaining_hash,'KEY_REENCRYPTION_INVENTORY_CHANGED','Unprocessed ciphertext inventory changed before staging.',409);
 const staged=ordered.map(row=>({identity:row.identity,source_key_version:row.key_version,source_ciphertext_sha256:byteHash(Buffer.from(row.ciphertext)),plaintext_sha256:plaintextHash(row)}));
 return signReencryptionCheckpoint({...unsigned(checkpoint),staged,remaining_hash:checkpointInventoryHash(remaining),updated_at:now} as Omit<ReencryptionCheckpoint,'signature'>,key);
}

export function completeReencryptionBatch(checkpoint:ReencryptionCheckpoint,counts:{rewritten:number;already_current:number},rows:readonly CheckpointEnvelope[],key:Buffer,now=new Date().toISOString()):ReencryptionCheckpoint{
 demand(checkpoint.status==='in_progress'&&checkpoint.staged.length>0&&Number.isSafeInteger(counts.rewritten)&&counts.rewritten>=0&&Number.isSafeInteger(counts.already_current)&&counts.already_current>=0&&counts.rewritten+counts.already_current===checkpoint.staged.length,'KEY_REENCRYPTION_CHECKPOINT_STATE','Batch completion must account for every staged envelope.',409);
 const cursor=checkpoint.staged.at(-1)!.identity,processed=[...rows].filter(row=>row.identity<=cursor).sort((a,b)=>a.identity.localeCompare(b.identity));
 demand(processed.length===checkpoint.rewritten+checkpoint.already_current+checkpoint.staged.length&&processed.every(row=>row.key_version===checkpoint.active_key_version),'KEY_REENCRYPTION_CHECKPOINT_STATE','Committed prefix must be complete and use the active key version.',409);
 const body={...unsigned(checkpoint),cursor,committed_inventory_hash:checkpointInventoryHash(processed),rewritten:checkpoint.rewritten+counts.rewritten,already_current:checkpoint.already_current+counts.already_current,staged:[],updated_at:now};
 return signReencryptionCheckpoint(body as Omit<ReencryptionCheckpoint,'signature'>,key);
}

export function completeReencryptionOperation(checkpoint:ReencryptionCheckpoint,rows:readonly CheckpointEnvelope[],key:Buffer,now=new Date().toISOString()):ReencryptionCheckpoint{
 demand(checkpoint.status==='in_progress'&&checkpoint.staged.length===0&&checkpoint.remaining_hash===checkpointInventoryHash([])&&rows.length===checkpoint.total_rows&&checkpoint.committed_inventory_hash===checkpointInventoryHash(rows),'KEY_REENCRYPTION_CHECKPOINT_STATE','Operation can complete only after the exact inventory is exhausted and committed prefix matches.',409);
 demand(rows.every(row=>row.key_version===checkpoint.active_key_version),'KEY_REENCRYPTION_CHECKPOINT_STATE','Every completed envelope must use the active key version.',409);
 return signReencryptionCheckpoint({...unsigned(checkpoint),status:'complete',cursor:null,final_inventory_hash:checkpointInventoryHash(rows),completed_at:now,updated_at:now},key);
}

export function validateCheckpointResume(checkpoint:ReencryptionCheckpoint,rows:readonly CheckpointEnvelope[],activeVersion:string,plaintextHash:(row:CheckpointEnvelope)=>string):{stagedRows:CheckpointEnvelope[];remainingRows:CheckpointEnvelope[]} {
 demand(checkpoint.status==='in_progress'&&checkpoint.active_key_version===activeVersion,'KEY_REENCRYPTION_CHECKPOINT_STATE','Only an in-progress checkpoint for the current active key can resume.',409);
 const ordered=[...rows].sort((a,b)=>a.identity.localeCompare(b.identity)),byId=new Map(ordered.map(row=>[row.identity,row]));
 demand(byId.size===ordered.length&&ordered.length===checkpoint.total_rows,'KEY_REENCRYPTION_INVENTORY_CHANGED','Envelope count or identities changed since the offline operation started.',409);
 const processed=ordered.filter(row=>checkpoint.cursor!==null&&row.identity<=checkpoint.cursor);
 demand(processed.length===checkpoint.rewritten+checkpoint.already_current&&processed.every(row=>row.key_version===activeVersion)&&checkpointInventoryHash(processed)===checkpoint.committed_inventory_hash,'KEY_REENCRYPTION_INVENTORY_CHANGED','A committed envelope changed after its batch completed.',409);
 const stagedRows=checkpoint.staged.map(item=>{const row=byId.get(item.identity);demand(row,'KEY_REENCRYPTION_INVENTORY_CHANGED','A staged envelope disappeared.',409);const actualCipherHash=byteHash(Buffer.from(row.ciphertext));if(row.key_version===item.source_key_version)demand(actualCipherHash===item.source_ciphertext_sha256,'KEY_REENCRYPTION_INVENTORY_CHANGED','A staged source envelope changed before commit.',409);else if(row.key_version===activeVersion)demand(plaintextHash(row)===item.plaintext_sha256,'KEY_REENCRYPTION_INVENTORY_CHANGED','A staged active envelope does not authenticate to its pre-commit plaintext.',409);else demand(false,'KEY_REENCRYPTION_INVENTORY_CHANGED','A staged envelope changed to an unreviewed key version.',409);return row;});
 const stagedIds=new Set(checkpoint.staged.map(item=>item.identity)),remainingRows=ordered.filter(row=>(checkpoint.cursor===null||row.identity>checkpoint.cursor)&&!stagedIds.has(row.identity));
 demand(checkpointInventoryHash(remainingRows)===checkpoint.remaining_hash,'KEY_REENCRYPTION_INVENTORY_CHANGED','Unprocessed envelopes changed while the operation was paused.',409);
 return {stagedRows,remainingRows};
}
