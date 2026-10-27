import fs from 'node:fs';
import path from 'node:path';
import {Ajv2020} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {DomainError} from '../../core/src/errors.js';
export const ajv = new Ajv2020({strict:true,allErrors:true});
(addFormats as unknown as (instance:Ajv2020)=>void)(ajv);
ajv.addFormat('binary',{type:'string',validate:()=>true});
for(const name of fs.readdirSync(path.resolve('contracts')).filter(x=>x.endsWith('.schema.json'))){
 ajv.addSchema(JSON.parse(fs.readFileSync(path.resolve('contracts',name),'utf8')));
}
export function validateContract<T>(name:string,value:unknown):T {
 const validator=ajv.getSchema('https://faultline.invalid/contracts/'+name+'.schema.json');
 if(!validator)throw new Error('Unknown contract '+name);
 if(!validator(value))throw new DomainError('INVALID_INPUT','Input does not match '+name+': '+ajv.errorsText(validator.errors),400);
 return value as T;
}
export function strictBody<T>(schema:object,value:unknown):T {
 const validator=ajv.compile(schema);
 if(!validator(value))throw new DomainError('INVALID_INPUT',ajv.errorsText(validator.errors),400);
 return value as T;
}

