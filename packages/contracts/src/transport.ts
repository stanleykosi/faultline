import fs from 'node:fs';
import {ajv} from './validate.js';
import {DomainError} from '../../core/src/errors.js';
const inventory=JSON.parse(fs.readFileSync('api.routes.json','utf8')) as {httpOperations:{operationId:string;request:{bodySchema:object|null}}[]};
export function operationBody<T>(operationId:string,value:unknown):T{
 const schema=inventory.httpOperations.find(x=>x.operationId===operationId)?.request.bodySchema;
 if(!schema)throw new Error('No body contract for '+operationId);
 const validator=ajv.compile(schema);if(!validator(value))throw new DomainError('INVALID_INPUT',ajv.errorsText(validator.errors),400);return value as T;
}

