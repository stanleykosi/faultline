import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {FileRunnerExecutionLedger, MemoryRunnerExecutionLedger} from './execution-ledger.js';

const key = 'task_execution_nonce_0001', task = 'a'.repeat(64);
const completedTransition = () => ({status:'completed' as const,updated_at:new Date().toISOString(),recovery_task:null,execution:{executionId:'provider-run',taskSha256:task,programSha256:'b'.repeat(64),resultSha256:'c'.repeat(64),result:{ok:true}}});

test('memory ledger binds one task and replays the completed result', async () => {
  const ledger = new MemoryRunnerExecutionLedger();
  assert.equal((await ledger.reserve(key, task)).created, true);
  assert.equal((await ledger.reserve(key, task)).created, false);
  await ledger.transition(key,task,['reserved'],{status:'running',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null});
  await ledger.transition(key,task,['running'],completedTransition());
  assert.equal((await ledger.reserve(key, task)).record.status, 'completed');
  await assert.rejects(ledger.reserve(key, 'd'.repeat(64)), /another task/i);
});

test('file ledger survives restart and rejects a conflicting task hash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'faultline-executions-'));
  const first = await FileRunnerExecutionLedger.open(root);
  await first.reserve(key, task);
  await first.transition(key,task,['reserved'],{status:'running',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null});
  await first.transition(key,task,['running'],completedTransition());
  const reopened = await FileRunnerExecutionLedger.open(root);
  const replay = await reopened.reserve(key, task);
  assert.equal(replay.created, false); assert.equal(replay.record.status, 'completed');
  await assert.rejects(reopened.reserve(key, 'e'.repeat(64)), /another task/i);
});

test('terminal transitions are irreversible and cancel wins an atomic publication race', async () => {
  const ledger = new MemoryRunnerExecutionLedger(); await ledger.reserve(key,task);
  await ledger.transition(key,task,['reserved'],{status:'running',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null});
  const requested=await ledger.transition(key,task,['running'],{status:'cancel_requested',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null});
  assert.equal(requested.applied,true);
  const publication=await ledger.transition(key,task,['running'],completedTransition());
  assert.equal(publication.applied,false); assert.equal(publication.record.status,'cancel_requested');
  await ledger.transition(key,task,['cancel_requested'],{status:'cancelled',updated_at:new Date().toISOString(),recovery_task:null,execution:null});
  const late=await ledger.transition(key,task,['running'],completedTransition());
  assert.equal(late.applied,false); assert.equal(late.record.status,'cancelled');
});

test('file ledger serializes competing controllers without losing cancel or completion', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-executions-race-')),first=await FileRunnerExecutionLedger.open(root),second=await FileRunnerExecutionLedger.open(root);
  await first.reserve(key,task);await first.transition(key,task,['reserved'],{status:'running',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null});
  const [publication,cancellation]=await Promise.all([
    first.transition(key,task,['running'],completedTransition()),
    second.transition(key,task,['running'],{status:'cancel_requested',updated_at:new Date().toISOString(),recovery_task:{task:true},execution:null}),
  ]);
  assert.equal(Number(publication.applied)+Number(cancellation.applied),1);
  const record=await first.read(key);assert.ok(record?.status==='completed'||record?.status==='cancel_requested');
});

test('file ledger enforces capacity during reservation and remains readable after restart', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-executions-capacity-')),ledger=await FileRunnerExecutionLedger.open(root,2);
  await ledger.reserve(key,task);await ledger.reserve('task_execution_nonce_0002','b'.repeat(64));
  await assert.rejects(ledger.reserve('task_execution_nonce_0003','c'.repeat(64)),/finite record bound/i);
  const reopened=await FileRunnerExecutionLedger.open(root,2);assert.equal((await reopened.read(key))?.status,'reserved');
});

test('file ledger enforces one shared capacity slot across concurrent controllers', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'faultline-executions-shared-capacity-')),first=await FileRunnerExecutionLedger.open(root,1),second=await FileRunnerExecutionLedger.open(root,1),otherKey='task_execution_nonce_0002';
  const outcomes=await Promise.allSettled([first.reserve(key,task),second.reserve(otherKey,'b'.repeat(64))]);
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);const rejected=outcomes.find(item=>item.status==='rejected');assert.match(String(rejected&&rejected.status==='rejected'?rejected.reason:''),/finite record bound/i);
  const reopened=await FileRunnerExecutionLedger.open(root,1),records=await reopened.listNonterminal();assert.equal(records.length,1);assert.ok(records[0]?.execution_key===key||records[0]?.execution_key===otherKey);
});
