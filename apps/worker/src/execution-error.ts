import {DomainError} from '../../../packages/core/src/errors.js';
import {ConnectorError} from '../../../packages/core/src/connectors/wire.js';

/** Keep typed redacted failure reasons; never publish arbitrary provider/SQL text. */
export function executionErrorCode(error:unknown):string {
 return (error instanceof DomainError||error instanceof ConnectorError)&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'EXECUTION_FAILED';
}
