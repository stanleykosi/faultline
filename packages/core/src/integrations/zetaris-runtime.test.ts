import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hash} from '../canonical.js';
import {ConnectorError} from '../connectors/wire.js';
import {ZETARIS_PROTOCOL,type ZetarisApi,type ZetarisCaptureRequest,type ZetarisCaptureResult} from '../connectors/zetaris/index.js';
import {buildZetarisCaptureRequest,validateZetarisRuntimeSourceConfig,ZetarisRuntimeRegistry,type ZetarisCurrentCaseInput,type ZetarisRuntimeAdapterFactory,type ZetarisRuntimeSourceConfig} from './zetaris-runtime.js';

const metric='a'.repeat(64),comparison='b'.repeat(64),contract='c'.repeat(64),credential='synthetic-zetaris-secret';
const source:ZetarisRuntimeSourceConfig={
  schema_version:1,protocol:ZETARIS_PROTOCOL,adapter_id:'workspace_contract_v1',workspace_id:'workspace_one',source_id:'zetaris_one',approved_origin:'https://zetaris.example.test',contract_hash:contract,approved_account_scope:'faultline_reader',
  approved_views:[
    {id:'sessions_public',role:'sessions',identifier:'approved.session_facts',columns:{record_id:'event_id',occurred_at:'occurred_at',release_id:'release_id',session_id:'session_id',cohort:'cohort',case_key:'case_key',flow_key:'flow_key',conversion_status:'converted'}},
    {id:'releases_public',role:'releases',identifier:'approved.release_facts',columns:{record_id:'record_id',occurred_at:'released_at',release_id:'release_id',case_key:'case_key',summary:'summary'}},
  ],approved_view_ids:['sessions_public','releases_public'],
};
const input:ZetarisCurrentCaseInput={workspace_id:'workspace_one',case_id:'case_one',revision_id:'revision_one',metric_hash:metric,comparison_hash:comparison,template_id:'release_exposure',view_ids:{sessions:'sessions_public',releases:'releases_public'},from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',flow_key:'checkout',release_id:'release_a'};

function code(run:()=>unknown):string|undefined{try{run();}catch(error){return error instanceof ConnectorError?error.code:undefined;}}
function signal():ZetarisCaptureResult['rows'][number]{
  const value={signal_id:'release_exposure:event_one:release_one',relationship:'release_exposure' as const,occurred_at:'2026-10-01T12:34:56.789Z',release_id:'release_a',session_id:'session_one',cohort:'mobile',symptom_ref:null,summary:'Checkout request was observed.',context_value:'false',lineage:[{view_id:'sessions_public',role:'sessions' as const,record_id:'event_one'},{view_id:'releases_public',role:'releases' as const,record_id:'release_one'}] as ZetarisCaptureResult['rows'][number]['lineage']};
  return {...value,content_hash:hash(value)};
}
function capture(request:ZetarisCaptureRequest,status:ZetarisCaptureResult['status']='complete',overrides:Partial<ZetarisCaptureResult>={}):ZetarisCaptureResult{
  const complete=status==='complete';
  return {protocol:ZETARIS_PROTOCOL,adapter_version:ZETARIS_PROTOCOL,status,reason_code:complete?null:`ZETARIS_${status.toUpperCase()}`,admissible:complete,workspace_id:request.workspace_id,source_id:'zetaris_one',case_id:request.case_id,revision_id:request.revision_id,metric_hash:request.metric_hash,comparison_hash:request.comparison_hash,template_id:request.template.id,template_version:1,template_hash:hash('template'),input_hash:hash(request),query_hash:hash('query'),selected_views:{sessions:'sessions_public',releases:'releases_public'},requested_bounds:{from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'},read_account_scope:'faultline_reader',provider_version:'contract-fixture',started_at:'2026-10-02T01:00:00.000Z',ended_at:'2026-10-02T01:00:01.000Z',rows:complete?[signal()]:[],observed_row_count:complete?1:0,pages:[{index:0,page_id:'page_one',requested_cursor:null,next_cursor:null,terminal:true,row_count:complete?1:0,accepted_row_count:complete?1:0,byte_count:credential.length,body_hash:hash('raw'),metadata_hash:hash('metadata'),observed_at:'2026-10-02T01:00:00.500Z',request_id:'request_one',raw_bytes:Buffer.from(credential)}],close:{status:'succeeded',closed_at:'2026-10-02T01:00:01.000Z',request_id:'close_one',error_code:null},limitations:['Supplementary association evidence only.'],capture_hash:hash({request,status}),...overrides};
}
function factory(apiFor:(request:ZetarisCaptureRequest)=>ZetarisCaptureResult):ZetarisRuntimeAdapterFactory{
  const api:ZetarisApi={capture:async request=>apiFor(request)};
  return {adapter_id:source.adapter_id,approved_origin:source.approved_origin,contract_hash:source.contract_hash,probe:async()=>({status:'available',checked_at:'2026-10-02T01:00:00.000Z',provider_version:'fixture',observed_account_scope:source.approved_account_scope,reason_code:null,read_only:true}),createApi:async()=>api};
}

test('strict source config and current-case input construct only the approved finite request',()=>{
  assert.deepEqual(validateZetarisRuntimeSourceConfig(source).approved_view_ids,source.approved_view_ids);
  const request=buildZetarisCaptureRequest(source,input);
  assert.equal(request.protocol,ZETARIS_PROTOCOL);assert.equal(request.template.id,'release_exposure');assert.deepEqual(request.view_ids,input.view_ids);assert.deepEqual(request.caps,{page_size:100,max_pages:10,max_rows:1000,max_page_bytes:1_000_000,max_total_bytes:10_000_000});
  assert.equal(code(()=>validateZetarisRuntimeSourceConfig({...source,approved_origin:'http://zetaris.example.test'})),'UNSAFE_PROVIDER_URL');
  assert.equal(code(()=>validateZetarisRuntimeSourceConfig({...source,approved_view_ids:['sessions_public']})),'INVALID_ZETARIS_RUNTIME_CONFIG');
  assert.equal(code(()=>buildZetarisCaptureRequest(source,{...input,view_ids:{sessions:'private_sessions',releases:'releases_public'}})),'ZETARIS_VIEW_UNAUTHORIZED');
  assert.equal(code(()=>buildZetarisCaptureRequest(source,{...input,sql:'select *' } as ZetarisCurrentCaseInput)),'INVALID_ZETARIS_CAPTURE_INPUT');
});

test('an unavailable contract adapter is an explicit blocked result and performs no capture',async()=>{
  const runtime=new ZetarisRuntimeRegistry(),result=await runtime.capture(source,input,credential);
  assert.equal(result.runtime_status,'blocked');assert.equal(result.reason_code,'ZETARIS_ADAPTER_NOT_REGISTERED');assert.equal(result.public_result,null);assert.deepEqual(result.raw_pages,[]);assert.deepEqual(result.evidence_drafts,[]);
  const probe=await runtime.probe(source,credential);assert.deepEqual(probe,{runtime_status:'blocked',reason_code:'ZETARIS_ADAPTER_NOT_REGISTERED',probe:null});
});

test('a complete admissible capture splits protected bytes and maps bounded restricted evidence with exact time',async()=>{
  const runtime=new ZetarisRuntimeRegistry();runtime.register(factory(request=>capture(request)));
  const probe=await runtime.probe(source,credential);assert.equal(probe.runtime_status,'probed');
  const result=await runtime.capture(source,input,credential);assert.equal(result.runtime_status,'captured');if(result.runtime_status!=='captured')return;
  assert.equal(result.public_result.status,'complete');assert.equal(result.public_result.pages.length,1);assert.equal(Object.hasOwn(result.public_result.pages[0]!,'raw_bytes'),false);assert.doesNotMatch(JSON.stringify(result.public_result),new RegExp(credential));
  assert.equal(result.raw_pages[0]!.raw_bytes.toString(),credential);assert.equal(result.evidence_drafts.length,1);
  const evidence=result.evidence_drafts[0]!;assert.equal(evidence.source_kind,'federated_query');assert.equal(evidence.redaction_status,'restricted');assert.equal(evidence.event_time.at,'2026-10-01T12:34:56.789000Z');assert.match(evidence.text,/supplementary association evidence does not establish aggregate causation/);assert.equal(Object.hasOwn(evidence,'claim'),false);assert.equal(Object.hasOwn(evidence,'metric'),false);
});

test('partial, failed, cancelled, and complete but inadmissible captures create no evidence',async()=>{
  for(const [status,admissible] of [['partial',false],['failed',false],['cancelled',false],['complete',false]] as const){
    const runtime=new ZetarisRuntimeRegistry();runtime.register(factory(request=>capture(request,status,{admissible})));
    const result=await runtime.capture(source,input,credential);assert.equal(result.runtime_status,'captured');if(result.runtime_status==='captured')assert.deepEqual(result.evidence_drafts,[],`${status}/${admissible}`);
  }
});

test('a complete capture rejects a hash-invalid normalized signal instead of partially admitting evidence',async()=>{
  const runtime=new ZetarisRuntimeRegistry();runtime.register(factory(request=>{const result=capture(request);result.rows[0]!.content_hash='d'.repeat(64);return result;}));
  await assert.rejects(runtime.capture(source,input,credential),(error:unknown)=>error instanceof ConnectorError&&error.code==='ZETARIS_CAPTURE_INVALID');
});

test('credentials reflected outside protected raw pages are rejected before publication',async()=>{
  const runtime=new ZetarisRuntimeRegistry();runtime.register(factory(request=>{const result=capture(request),row=result.rows[0]!;row.summary=`provider echoed ${credential}`;const {content_hash:_,...base}=row;row.content_hash=hash(base);return result;}));
  await assert.rejects(runtime.capture(source,input,credential),(error:unknown)=>error instanceof ConnectorError&&error.code==='PROVIDER_SECRET_REFLECTION');
});
