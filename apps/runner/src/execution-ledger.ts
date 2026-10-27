import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {canonical} from '../../../packages/core/src/canonical.js';
import {DomainError, demand} from '../../../packages/core/src/errors.js';
import type {HardenedSandboxExecution} from './sandbox-provider.js';

const DIGEST = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 10_000;
const LOCK_WAIT_MS = 5_000;

export type ExecutionStatus = 'reserved' | 'running' | 'cancel_requested' | 'containment_unknown' | 'completed' | 'cancelled';
type Base = {version: 1; revision: number; execution_key: string; task_sha256: string; updated_at: string; recovery_task: unknown | null};
export type ExecutionLedgerRecord =
  | Base & {status: 'reserved' | 'running' | 'cancel_requested'; execution: null}
  | Base & {status: 'containment_unknown' | 'cancelled'; execution: null; recovery_task: null}
  | Base & {status: 'completed'; execution: HardenedSandboxExecution; recovery_task: null};
export type ExecutionLedgerTransition = Pick<ExecutionLedgerRecord, 'status' | 'updated_at' | 'execution' | 'recovery_task'>;

export interface RunnerExecutionLedger {
  reserve(executionKey: string, taskSha256: string): Promise<{created: boolean; record: ExecutionLedgerRecord}>;
  read(executionKey: string): Promise<ExecutionLedgerRecord | null>;
  listNonterminal(): Promise<ExecutionLedgerRecord[]>;
  transition(executionKey: string, taskSha256: string, expected: readonly ExecutionStatus[], next: ExecutionLedgerTransition): Promise<{applied: boolean; record: ExecutionLedgerRecord}>;
}

const transitions: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  reserved: ['running', 'cancelled', 'containment_unknown'],
  running: ['completed', 'cancel_requested', 'cancelled', 'containment_unknown'],
  cancel_requested: ['cancelled', 'containment_unknown'],
  completed: [], cancelled: [], containment_unknown: [],
};

function validate(record: ExecutionLedgerRecord): ExecutionLedgerRecord {
  demand(record?.version === 1 && Number.isSafeInteger(record.revision) && record.revision > 0 && KEY.test(record.execution_key) && DIGEST.test(record.task_sha256) && typeof record.updated_at === 'string' && Number.isFinite(Date.parse(record.updated_at)) && Object.hasOwn(transitions, record.status), 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger record is invalid.', 503);
  demand(record.status === 'completed' ? record.execution !== null && record.execution.taskSha256 === record.task_sha256 && record.recovery_task === null : record.execution === null, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger binding is invalid.', 503);
  demand(['reserved','running','cancel_requested'].includes(record.status) || record.recovery_task === null, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Terminal runner records cannot retain recovery input.', 503);
  demand(Buffer.byteLength(canonical(record)) <= MAX_RECORD_BYTES, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger record exceeds its finite bound.', 503);
  return record;
}

function nextRecord(current: ExecutionLedgerRecord, expected: readonly ExecutionStatus[], next: ExecutionLedgerTransition): ExecutionLedgerRecord | null {
  if (!expected.includes(current.status)) return null;
  demand(transitions[current.status].includes(next.status), 'RUNNER_EXECUTION_TRANSITION_INVALID', 'Runner execution state transition is not allowed.', 409);
  return validate({...next, version: 1, revision: current.revision + 1, execution_key: current.execution_key, task_sha256: current.task_sha256} as ExecutionLedgerRecord);
}

const filename = (root: string, key: string) => path.join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function acquireLock(file: string): Promise<{handle: fs.FileHandle; release: () => Promise<void>}> {
  const deadline = Date.now() + LOCK_WAIT_MS, token = randomUUID(); let handle: fs.FileHandle | null = null;
  while (!handle) {
    try { handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); await handle.writeFile(token); await handle.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; demand(Date.now() < deadline, 'RUNNER_EXECUTION_LEDGER_BUSY', 'Runner execution ledger transition is busy.', 503); await wait(10); }
  }
  return {handle, release: async () => { await handle!.close(); try { if (await fs.readFile(file, 'utf8') === token) await fs.unlink(file); } catch {} }};
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try { const directory = await fs.open(directoryPath, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (process.platform === 'win32' && (code === 'EPERM' || code === 'EINVAL')) return; throw error; }
}

export class MemoryRunnerExecutionLedger implements RunnerExecutionLedger {
  readonly #records = new Map<string, ExecutionLedgerRecord>();
  async reserve(executionKey: string, taskSha256: string) {
    const existing = this.#records.get(executionKey);
    if (existing) { demand(existing.task_sha256 === taskSha256, 'RUNNER_EXECUTION_CONFLICT', 'Execution key was already bound to another task.', 409); return {created: false, record: structuredClone(existing)}; }
    const record = validate({version: 1, revision: 1, execution_key: executionKey, task_sha256: taskSha256, status: 'reserved', updated_at: new Date().toISOString(), recovery_task: null, execution: null});
    this.#records.set(executionKey, record); return {created: true, record: structuredClone(record)};
  }
  async read(executionKey: string) { const record = this.#records.get(executionKey); return record ? structuredClone(record) : null; }
  async listNonterminal() { return [...this.#records.values()].filter(record => !['completed','cancelled','containment_unknown'].includes(record.status)).map(record => structuredClone(record)); }
  async transition(executionKey: string, taskSha256: string, expected: readonly ExecutionStatus[], next: ExecutionLedgerTransition) {
    const current = this.#records.get(executionKey); demand(current?.task_sha256 === taskSha256, 'RUNNER_EXECUTION_CONFLICT', 'Execution ledger update does not match its reservation.', 409);
    const record = nextRecord(current, expected, next); if (!record) return {applied: false, record: structuredClone(current)};
    this.#records.set(executionKey, record); return {applied: true, record: structuredClone(record)};
  }
}

export class FileRunnerExecutionLedger implements RunnerExecutionLedger {
  readonly #root: string;
  readonly #maximumRecords: number;
  private constructor(root: string, maximumRecords: number) { this.#root = root; this.#maximumRecords = maximumRecords; }

  static async open(root: string, maximumRecords = MAX_RECORDS): Promise<FileRunnerExecutionLedger> {
    demand(path.isAbsolute(root) && path.resolve(root) === root, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger path must be absolute.', 503);
    demand(Number.isSafeInteger(maximumRecords) && maximumRecords > 0 && maximumRecords <= MAX_RECORDS, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger capacity is invalid.', 503);
    await fs.mkdir(root, {recursive: true, mode: 0o700}); const stat = await fs.lstat(root);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger must be a private directory.', 503);
    const files = (await fs.readdir(root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); demand(files.length <= maximumRecords, 'RUNNER_EXECUTION_LEDGER_FULL', 'Runner execution ledger reached its finite record bound.', 503);
    return new FileRunnerExecutionLedger(root, maximumRecords);
  }

  async reserve(executionKey: string, taskSha256: string) {
    demand(KEY.test(executionKey) && DIGEST.test(taskSha256), 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution identity is invalid.', 503);
    const record = validate({version: 1, revision: 1, execution_key: executionKey, task_sha256: taskSha256, status: 'reserved', updated_at: new Date().toISOString(), recovery_task: null, execution: null});
    const file = filename(this.#root, executionKey), lock = await acquireLock(path.join(this.#root, '.capacity.lock'));
    try {
      const existing = await this.read(executionKey); if (existing) { demand(existing.task_sha256 === taskSha256, 'RUNNER_EXECUTION_CONFLICT', 'Execution key was already bound to another task.', 409); return {created: false, record: existing}; }
      const files = (await fs.readdir(this.#root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); demand(files.length < this.#maximumRecords, 'RUNNER_EXECUTION_LEDGER_FULL', 'Runner execution ledger reached its finite record bound.', 503);
      const handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); try { await handle.writeFile(canonical(record)); await handle.sync(); } finally { await handle.close(); } await syncDirectory(this.#root); return {created: true, record};
    } finally { await lock.release(); }
  }

  async read(executionKey: string): Promise<ExecutionLedgerRecord | null> {
    demand(KEY.test(executionKey), 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution identity is invalid.', 503);
    try { const file = filename(this.#root, executionKey), stat = await fs.lstat(file); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_RECORD_BYTES, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger record is invalid.', 503); return validate(JSON.parse(await fs.readFile(file, 'utf8')) as ExecutionLedgerRecord); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; if (error instanceof DomainError) throw error; throw new DomainError('RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger record is unreadable.', 503); }
  }

  async listNonterminal(): Promise<ExecutionLedgerRecord[]> {
    const names = (await fs.readdir(this.#root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    demand(names.length <= this.#maximumRecords, 'RUNNER_EXECUTION_LEDGER_FULL', 'Runner execution ledger reached its finite record bound.', 503);
    const records: ExecutionLedgerRecord[] = [];
    for (const name of names) { const file = path.join(this.#root, name), stat = await fs.lstat(file); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_RECORD_BYTES, 'RUNNER_EXECUTION_LEDGER_INVALID', 'Runner execution ledger record is invalid.', 503); const record = validate(JSON.parse(await fs.readFile(file, 'utf8')) as ExecutionLedgerRecord); if (!['completed','cancelled','containment_unknown'].includes(record.status)) records.push(record); }
    return records;
  }

  async transition(executionKey: string, taskSha256: string, expected: readonly ExecutionStatus[], next: ExecutionLedgerTransition) {
    const target = filename(this.#root, executionKey), lock = await acquireLock(`${target}.lock`), token = randomUUID();
    try {
      const current = await this.read(executionKey); demand(current?.task_sha256 === taskSha256, 'RUNNER_EXECUTION_CONFLICT', 'Execution ledger update does not match its reservation.', 409);
      const record = nextRecord(current, expected, next); if (!record) return {applied: false, record: current};
      const temporary = `${target}.${process.pid}.${token}.tmp`, output = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await output.writeFile(canonical(record)); await output.sync(); } finally { await output.close(); }
      await fs.rename(temporary, target); await syncDirectory(this.#root); return {applied: true, record};
    } finally { await lock.release(); }
  }
}
