import test from 'node:test';
import assert from 'node:assert/strict';
import {DomainError} from '../errors.js';
import {assertAgentMemoryRecallPlanCurrent,investigationMemoryCatalogHash,type AgentMemoryRecallPlan} from './memory.js';
import {assertZetarisAgentCapturePlanCurrent,type ZetarisAgentCapturePlan} from '../integrations/service.js';

function stale(code:string,fn:()=>unknown){assert.throws(fn,error=>error instanceof DomainError&&error.code===code);}

const memory:AgentMemoryRecallPlan={schema_version:1,kind:'meterless_recall',revision_id:'33333333-3333-4333-8333-333333333333',query:'mobile checkout',query_hash:'a'.repeat(64),catalog_hash:'b'.repeat(64),max_results:5};
const zetaris:ZetarisAgentCapturePlan={schema_version:1,kind:'zetaris_federated_query',source_id:'11111111-1111-4111-8111-111111111111',source_name:'Checked source',source_revision:3,config_hash:'c'.repeat(64),probe_binding_hash:'d'.repeat(64),credential_version:2,approved_origin:'https://example.test',approved_account_scope:'read:workspace',request:{workspace_id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',revision_id:'33333333-3333-4333-8333-333333333333',metric_hash:'e'.repeat(64),comparison_hash:'f'.repeat(64),template_id:'release_exposure',view_ids:{sessions:'sessions-v1',releases:'releases-v1'},from:'2026-10-01T00:00:00.000Z',to:'2026-10-08T00:00:00.000Z',case_key:'case',flow_key:'checkout',release_id:'release-1'},request_hash:'1'.repeat(64)};

test('reviewed Meterless recall fails closed when the query or catalog changes',()=>{
 assert.doesNotThrow(()=>assertAgentMemoryRecallPlanCurrent(memory,structuredClone(memory)));
 stale('STALE_AGENT_MEMORY',()=>assertAgentMemoryRecallPlanCurrent(memory,{...memory,catalog_hash:'9'.repeat(64)}));
 stale('STALE_AGENT_MEMORY',()=>assertAgentMemoryRecallPlanCurrent(memory,{...memory,query:'another case'}));
});

test('Meterless catalog binding is order-invariant and changes with latest feedback',()=>{
 const capsule={capsule_id:'11111111-1111-4111-8111-111111111111',capsule_hash:'a'.repeat(64),authority:{current_revision_id:'r'}} as any,authority=[{capsule_id:capsule.capsule_id,evidence:[{id:'b'},{id:'a'}]}],feedback=[{capsule_id:capsule.capsule_id,id:'22222222-2222-4222-8222-222222222222',kind:'helpful',created_at:'2026-10-21T12:00:00.000Z'}];
 const first=investigationMemoryCatalogHash([capsule],authority,feedback),same=investigationMemoryCatalogHash([capsule],[...authority].reverse(),[...feedback].reverse()),changed=investigationMemoryCatalogHash([capsule],authority,[{...feedback[0],kind:'wrong'}]);
 assert.equal(first,same);assert.notEqual(first,changed);
});

test('reviewed Zetaris execution fails closed when source, binding, filters, or caps change',()=>{
 assert.doesNotThrow(()=>assertZetarisAgentCapturePlanCurrent(zetaris,structuredClone(zetaris)));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,config_hash:'9'.repeat(64)}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,source_id:'99999999-9999-4999-8999-999999999999'}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,request:{...zetaris.request,release_id:'release-2'}}));
 stale('STALE_SOURCE',()=>assertZetarisAgentCapturePlanCurrent(zetaris,{...zetaris,request:{...zetaris.request,caps:{max_rows:500}}}));
});
