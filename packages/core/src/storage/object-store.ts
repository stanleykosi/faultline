export interface StoredObject {
 key:string;
 sha256:string;
 size_bytes:number;
}

/** Immutable workspace-scoped evidence storage. Consumers must drain reads to EOF. */
export interface ObjectStore {
 put(wid:string,bytes:Buffer):Promise<StoredObject>;
 putStream(wid:string,input:AsyncIterable<Uint8Array>,limit?:number):Promise<StoredObject>;
 read(wid:string,key:string):Promise<Buffer>;
 readStream(wid:string,key:string,limit?:number):AsyncGenerator<Buffer>;
 remove(wid:string,key:string):Promise<unknown>;
 health():Promise<void>;
}
