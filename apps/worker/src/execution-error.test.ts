import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainError} from '../../../packages/core/src/errors.js';
import {ConnectorError} from '../../../packages/core/src/connectors/wire.js';
import {executionErrorCode} from './execution-error.js';

test('worker preserves typed model/budget failures and hides untrusted error details',()=>{
 assert.equal(executionErrorCode(new ConnectorError('MODEL_REFUSED_OR_TRUNCATED','Private provider detail')),'MODEL_REFUSED_OR_TRUNCATED');
 assert.equal(executionErrorCode(new DomainError('MODEL_BUDGET_EXHAUSTED','Private budget detail')),'MODEL_BUDGET_EXHAUSTED');
 for(const error of [new Error('private SQL/password'),{code:'MODEL_TRUNCATED',message:'untrusted object'},new ConnectorError('secret token','hidden')])assert.equal(executionErrorCode(error),'EXECUTION_FAILED');
});
