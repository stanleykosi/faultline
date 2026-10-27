import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationBody} from './transport.js';

test('generic import accepts explicit finite property paths and preserves literal dotted headers',()=>{
 const mapping={kind:'analytics',event_id_path:'id',session_id_path:['properties','$session_id'],event_time_path:['meta','at'],event_name_path:'event',device_path:['properties','device'],device_map:[{source_value:'phone',cohort:'mobile'}],precision_policy:'lossless_utc_microseconds'};
 assert.deepEqual(operationBody('saveImportMapping',mapping),mapping);
 const literal={...mapping,session_id_path:'properties.$session_id'};
 assert.equal(operationBody<typeof literal>('saveImportMapping',literal).session_id_path,'properties.$session_id');
 const support={kind:'support',record_id_path:['ticket','id'],text_path:['ticket','text'],event_time_path:['ticket','time']};
 assert.deepEqual(operationBody('saveImportMapping',support),support);
});
test('unsafe or unbounded path arrays and strings are refused before mapping publication',()=>{
 const mapping={kind:'analytics',event_id_path:'id',session_id_path:'session',event_time_path:'at',event_name_path:'event',device_path:'device',device_map:[{source_value:'phone',cohort:'mobile'}],precision_policy:'lossless_utc_microseconds'};
 for(const path of [[],['__proto__','session'],['props','constructor'],['prototype'],[1],[''],['x'.repeat(129)],Array(9).fill('next'),'__proto__']){
  assert.throws(()=>operationBody('saveImportMapping',{...mapping,session_id_path:path}),(e:unknown)=>(e as {code?:string}).code==='INVALID_INPUT');
 }
});
