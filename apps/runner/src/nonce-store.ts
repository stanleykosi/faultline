import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {DomainError, demand} from '../../../packages/core/src/errors.js';

const NONCE = /^[a-f0-9-]{36}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 10_000;

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const directory = await fs.open(directoryPath, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EINVAL')) return;
    throw error;
  }
}

export interface RunnerNonceStore {
  /** Persists a nonce before the protected side effect and returns false on replay. */
  consume(nonce: string, expiresAt: string): Promise<boolean>;
}

function valid(nonce: string, expiresAt: string): number {
  const expiry = Date.parse(expiresAt);
  demand(NONCE.test(nonce) && Number.isFinite(expiry), 'RUNNER_AUTHENTICATION_FAILED', 'Runner nonce or expiry is invalid.', 403);
  return expiry;
}

export class MemoryRunnerNonceStore implements RunnerNonceStore {
  readonly #entries = new Map<string, number>();

  async consume(nonce: string, expiresAt: string): Promise<boolean> {
    const expiry = valid(nonce, expiresAt), now = Date.now();
    for (const [key, until] of this.#entries) if (until < now) this.#entries.delete(key);
    if (this.#entries.has(nonce)) return false;
    this.#entries.set(nonce, expiry);
    return true;
  }
}

interface NonceRecord {version: 1; nonce: string; expires_at: string;}

function parseRecord(line: string): NonceRecord {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new DomainError('RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal contains invalid JSON.', 503); }
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), 'RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal record is invalid.', 503);
  const record = value as Partial<NonceRecord>;
  demand(Object.keys(record).sort().join(',') === 'expires_at,nonce,version' && record.version === 1 && typeof record.nonce === 'string' && typeof record.expires_at === 'string', 'RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal record is invalid.', 503);
  valid(record.nonce, record.expires_at);
  return record as NonceRecord;
}

/**
 * Append-only replay journal for a controller-mounted private persistent path.
 * A successful append is synced before execution begins. Expired entries are
 * compacted when the finite record ceiling is reached.
 */
export class FileRunnerNonceStore implements RunnerNonceStore {
  readonly #root: string;
  private constructor(root: string) { this.#root = root; }

  static async open(file: string): Promise<FileRunnerNonceStore> {
    demand(path.isAbsolute(file) && path.resolve(file) === file, 'RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal path must be absolute.', 503);
    await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
    let text = '';
    try {
      const stat = await fs.lstat(file);
      demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES, 'RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal is not a bounded regular file.', 503);
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lines = text.split('\n').filter(Boolean);
    demand(lines.length <= MAX_RECORDS, 'RUNNER_NONCE_STORE_INVALID', 'Runner nonce journal exceeds its finite record bound.', 503);
    const root = `${file}.records`; await fs.mkdir(root,{recursive:true,mode:0o700}); const rootStat=await fs.lstat(root);
    demand(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'RUNNER_NONCE_STORE_INVALID','Runner nonce records must be a private directory.',503);
    const now = Date.now();
    for (const line of lines) {
      const record = parseRecord(line), expiry = Date.parse(record.expires_at);
      if (expiry >= now) {
        const marker=path.join(root,`${createHash('sha256').update(record.nonce).digest('hex')}.json`);
        try{const handle=await fs.open(marker,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      }
    }
    demand((await fs.readdir(root)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length<=MAX_RECORDS,'RUNNER_NONCE_STORE_INVALID','Runner nonce records exceed their finite bound.',503);
    return new FileRunnerNonceStore(root);
  }

  async consume(nonce: string, expiresAt: string): Promise<boolean> {
    valid(nonce, expiresAt);
    let names=(await fs.readdir(this.#root)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
    if(names.length>=MAX_RECORDS){
      const now=Date.now();
      for(const name of names){const marker=path.join(this.#root,name);try{const record=parseRecord(await fs.readFile(marker,'utf8'));if(Date.parse(record.expires_at)<now)await fs.unlink(marker);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      names=(await fs.readdir(this.#root)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
    }
    demand(names.length<MAX_RECORDS,'RUNNER_NONCE_STORE_FULL','Runner nonce store reached its finite record bound.',503);
    const marker=path.join(this.#root,`${createHash('sha256').update(nonce).digest('hex')}.json`),temporary=`${marker}.${process.pid}.${randomUUID()}.tmp`,record:NonceRecord={version:1,nonce,expires_at:expiresAt};
    const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
    try{await fs.link(temporary,marker);await syncDirectory(this.#root);return true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
    finally{try{await fs.unlink(temporary);}catch{}}
  }
}
