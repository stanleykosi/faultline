import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {DomainError} from '../../../packages/core/src/errors.js';
import {ConnectorError} from '../../../packages/core/src/connectors/wire.js';
import {executionErrorCode} from './execution-error.js';
import {createPgBossOptions, createPgBossSendOptions, FAULTLINE_DELIVERY_EXPIRY_SECONDS} from './pg-boss-options.js';

describe("execution error", async () => {
  test('worker preserves typed model/budget failures and hides untrusted error details', () => {
      assert.equal(executionErrorCode(new ConnectorError('MODEL_REFUSED_OR_TRUNCATED', 'Private provider detail')), 'MODEL_REFUSED_OR_TRUNCATED');
      assert.equal(executionErrorCode(new DomainError('MODEL_BUDGET_EXHAUSTED', 'Private budget detail')), 'MODEL_BUDGET_EXHAUSTED');
      for (const error of [new Error('private SQL/password'), { code: 'MODEL_TRUNCATED', message: 'untrusted object' }, new ConnectorError('secret token', 'hidden')])
          assert.equal(executionErrorCode(error), 'EXECUTION_FAILED');
  });
});

describe("pg boss options", async () => {
  test('queue options preserve restricted startup with optional named instances',()=>{
    for(const instance of [undefined,'worker-unit-test']){
      const options=createPgBossOptions('postgresql://worker.invalid/faultline',instance);
      assert.equal(options.schema,'pgboss');assert.equal(options.migrate,false);assert.equal(options.max,4);
      assert.equal(options.instanceName,instance);assert.equal(options.supervise,true);
    }
  });

  test('job delivery cannot expire before the longest authenticated external runner request', () => {
      assert.ok(FAULTLINE_DELIVERY_EXPIRY_SECONDS > 660);
      assert.deepEqual(createPgBossSendOptions('outbox-1'), { id: 'outbox-1', retryLimit: 2, expireInSeconds: 720 });
  });
});
