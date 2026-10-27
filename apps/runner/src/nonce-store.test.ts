import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileRunnerNonceStore, MemoryRunnerNonceStore} from './nonce-store.js';

const expiry = () => new Date(Date.now() + 60_000).toISOString();
const nonce = '00000000-0000-4000-8000-000000000001';

test('memory nonce store admits once and rejects replay', async () => {
  const store = new MemoryRunnerNonceStore();
  assert.equal(await store.consume(nonce, expiry()), true);
  assert.equal(await store.consume(nonce, expiry()), false);
});

test('file nonce store rejects replay after controller restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-'));
  const file = path.join(root, 'journal.jsonl');
  const first = await FileRunnerNonceStore.open(file);
  assert.equal(await first.consume(nonce, expiry()), true);
  const reopened = await FileRunnerNonceStore.open(file);
  assert.equal(await reopened.consume(nonce, expiry()), false);
});

test('file nonce store admits one nonce across concurrent controller instances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-concurrent-')),file=path.join(root,'journal.jsonl');
  const first=await FileRunnerNonceStore.open(file),second=await FileRunnerNonceStore.open(file),results=await Promise.all([first.consume(nonce,expiry()),second.consume(nonce,expiry())]);
  assert.deepEqual(results.sort(),[false,true]);
});

test('file nonce store rejects a non-absolute path and malformed journal', async () => {
  await assert.rejects(FileRunnerNonceStore.open('relative.jsonl'), /absolute/i);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-nonces-invalid-'));
  const file = path.join(root, 'journal.jsonl');
  await fs.writeFile(file, '{bad}\n');
  await assert.rejects(FileRunnerNonceStore.open(file), /invalid JSON/i);
});
