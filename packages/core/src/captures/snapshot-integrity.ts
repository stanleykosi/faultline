import type {FaultlineSnapshot} from '../../../contracts/src/generated.js';
import {objects} from '../storage/objects.js';
import {demand,DomainError} from '../errors.js';
import {createHash} from 'node:crypto';
import {canonical} from '../canonical.js';
import {verifyOnceInScope} from '../verification/scope.js';

type ObjectReader=Pick<typeof objects,'readStream'>;
type DigestInput={source_id:string;coverage:unknown;mapping_hash:string;raw_hash:string;content_hash:string};
/** Accepted manifests bind private original canonical bytes, not only database metadata. */
export async function verifySnapshotBytes(wid:string,snapshot:Pick<FaultlineSnapshot,'workspace_id'|'files'>,objectKey:string,reader:ObjectReader=objects,digestInput?:DigestInput):Promise<void>{
 return verifyOnceInScope(reader,
  ()=>createHash('sha256').update(canonical({wid,snapshot,objectKey,digestInput:digestInput??null})).digest('hex'),
  ()=>verifyUncachedSnapshotBytes(wid,snapshot,objectKey,reader,digestInput));
}

async function verifyUncachedSnapshotBytes(wid:string,snapshot:Pick<FaultlineSnapshot,'workspace_id'|'files'>,objectKey:string,reader:ObjectReader,digestInput?:DigestInput):Promise<void>{
 demand(snapshot.workspace_id===wid&&/^[a-f0-9]{64}$/.test(objectKey)&&Array.isArray(snapshot.files)&&snapshot.files.length===1,'ARTIFACT_CORRUPT','Snapshot canonical manifest identity differs.',409);
 const file=snapshot.files[0]!;
 demand(file.path==='canonical/'+objectKey+'.json'&&file.sha256===objectKey&&file.media_type==='application/json'&&Number.isSafeInteger(file.size_bytes)&&file.size_bytes>=0&&file.size_bytes<=268435456,'ARTIFACT_CORRUPT','Snapshot canonical descriptor differs.',409);
 let total=0;const digest=digestInput?createHash('sha256'):null;
 if(digestInput){demand(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(digestInput.source_id)&&[digestInput.mapping_hash,digestInput.raw_hash,digestInput.content_hash].every(value=>/^[a-f0-9]{64}$/.test(value)),'ARTIFACT_CORRUPT','Snapshot provenance binding is invalid.',409);digest!.update('{"coverage":'+canonical(digestInput.coverage)+',"mapping_hash":'+canonical(digestInput.mapping_hash)+',"raw_hash":'+canonical(digestInput.raw_hash)+',"records":');}
 try{for await(const chunk of reader.readStream(wid,objectKey,Math.max(1,file.size_bytes))){total+=chunk.length;digest?.update(chunk);}}
 catch(error){if(error instanceof DomainError&&['BYTE_LIMIT','ARTIFACT_CORRUPT'].includes(error.code))throw new DomainError('ARTIFACT_CORRUPT','Snapshot canonical bytes differ from the accepted manifest.',409);if((error as NodeJS.ErrnoException).code==='ENOENT')throw new DomainError('ARTIFACT_UNAVAILABLE','Snapshot canonical bytes are unavailable.',409);throw error;}
 demand(total===file.size_bytes,'ARTIFACT_CORRUPT','Snapshot canonical byte size differs from its accepted manifest.',409);
 if(digestInput){digest!.update(',"source_id":'+canonical(digestInput.source_id)+'}');demand(digest!.digest('hex')===digestInput.content_hash,'ARTIFACT_CORRUPT','Snapshot full content hash differs from its accepted provenance.',409);}
}
