import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {ConnectorError, containsProviderSecret, type ExecutionControl} from '../wire.js';
import {compileZetarisQuery, executeZetarisCapture, ZETARIS_PROTOCOL, ZetarisEvidenceClient, zetarisTemplates, type ZetarisCaptureRequest, type ZetarisConfig, type ZetarisOpenResult, type ZetarisProviderPage, type ZetarisSessionHandle, type ZetarisTransport, type ZetarisApi, type ZetarisCaptureResult} from './index.js';
import {hash} from '../../canonical.js';
import {buildZetarisCaptureRequest, validateZetarisRuntimeSourceConfig, ZetarisRuntimeRegistry, type ZetarisCurrentCaseInput, type ZetarisRuntimeAdapterFactory, type ZetarisRuntimeSourceConfig} from '../../integrations/zetaris-runtime.js';
import {createZetarisRestAdapter, type ZetarisRestHttp} from '../../integrations/zetaris-http.js';
import {ZETARIS_PROJECTION_COLUMNS} from './index.js';
import type {RequestOptions} from '../../integrations/transport.js';
import type {WireResponse} from '../wire.js';

// index
const digest='a'.repeat(64);
const config:ZetarisConfig={workspace_id:'workspace_one',source_id:'zetaris_one',credential:'unit-secret',read_account_scope:'fixture_reader',approved_views:[
  {id:'sessions_public',role:'sessions',identifier:'fixture.session_facts',columns:{record_id:'event_id',occurred_at:'occurred_at',release_id:'release_id',session_id:'session_id',cohort:'device',case_key:'case_key',flow_key:'flow_key',conversion_status:'converted'}},
  {id:'releases_public',role:'releases',identifier:'fixture.release_facts',columns:{record_id:'release_record_id',occurred_at:'released_at',release_id:'release_id',case_key:'case_key',summary:'summary'}},
  {id:'support_public',role:'support',identifier:'fixture.support_facts',columns:{record_id:'ticket_id',occurred_at:'opened_at',release_id:'release_id',session_id:'session_id',case_key:'case_key',symptom_ref:'symptom_code',summary:'summary'}},
  {id:'changes_public',role:'changes',identifier:'fixture.change_facts',columns:{record_id:'change_id',occurred_at:'changed_at',release_id:'release_id',case_key:'case_key',summary:'summary'}},
]};

const filterByTemplate:Record<ZetarisCaptureRequest['template']['id'],ZetarisCaptureRequest['filters']>={
  release_exposure:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',flow_key:'checkout',release_id:'release_a'},
  support_symptoms:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',release_id:'release_a'},
  change_timeline:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',release_id:'release_a'},
  cohort_context:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',flow_key:'checkout',affected_cohort:'mobile',control_cohort:'desktop'},
  contrary_evidence:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',flow_key:'checkout',release_id:'release_a',affected_cohort:'mobile',control_cohort:'desktop'},
  followup_recheck:{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',case_key:'case_one',flow_key:'checkout',release_id:'release_b',affected_cohort:'mobile',control_cohort:'desktop'},
};
const viewsByTemplate:Record<ZetarisCaptureRequest['template']['id'],ZetarisCaptureRequest['view_ids']>={
  release_exposure:{sessions:'sessions_public',releases:'releases_public'},support_symptoms:{support:'support_public',releases:'releases_public'},change_timeline:{changes:'changes_public',releases:'releases_public'},cohort_context:{sessions:'sessions_public',releases:'releases_public'},contrary_evidence:{sessions:'sessions_public',releases:'releases_public'},followup_recheck:{sessions:'sessions_public',releases:'releases_public'},
};
function request(template:ZetarisCaptureRequest['template']['id']='release_exposure',caps:Partial<ZetarisCaptureRequest['caps']>={}):ZetarisCaptureRequest{return {protocol:ZETARIS_PROTOCOL,template:{id:template,version:1},workspace_id:'workspace_one',case_id:'case_one',revision_id:'revision_one',metric_hash:digest,comparison_hash:'b'.repeat(64),view_ids:viewsByTemplate[template],filters:filterByTemplate[template],caps:{page_size:2,max_pages:5,max_rows:10,max_page_bytes:1000,max_total_bytes:5000,...caps}};}
function row(overrides:Record<string,unknown>={}){return {signal_id:'release_exposure:event_one:release_record_one',occurred_at:'2026-10-01T01:00:00Z',release_id:'release_a',session_id:'session_one',cohort:'mobile',symptom_ref:null,summary:null,context_value:'false',primary_record_id:'event_one',related_record_id:'release_record_one',...overrides};}
function page(input:Partial<ZetarisProviderPage>={}):ZetarisProviderPage{const rows=input.rows??[row()];return {page_id:'page_one',requested_cursor:null,next_cursor:null,terminal:true,rows,raw_bytes:Buffer.from(JSON.stringify({rows,unit:input.page_id??'page_one'})),observed_at:'2026-10-01T02:00:00Z',request_id:'provider-page-one',metadata:{source:'fixture'},...input};}

class FixtureTransport implements ZetarisTransport{
  closeCalls=0;pageCalls=0;openSelect='';
  constructor(private readonly options:{loginError?:unknown;openPage?:ZetarisProviderPage;pages?:ZetarisProviderPage[];closeError?:unknown}={}){}
  async login(_input:{credential:string;request_id:string},_control?:ExecutionControl):Promise<ZetarisSessionHandle>{if(this.options.loginError)throw this.options.loginError;return {handle:'private-session',account_scope:'fixture_reader',expires_at:null,provider_version:'observed-unit',request_id:'login-one'};}
  async open(input:{session_handle:string;request_id:string;select:string;page_limit:number},_control?:ExecutionControl):Promise<ZetarisOpenResult>{this.openSelect=input.select;return {query_handle:'private-query',request_id:'open-one',page:this.options.openPage??page()};}
  async page(_input:{session_handle:string;query_handle:string;request_id:string;cursor:string},_control?:ExecutionControl):Promise<ZetarisProviderPage>{this.pageCalls++;const next=this.options.pages?.shift();if(!next)throw new Error('Unexpected unit page call');return next;}
  async close():Promise<{request_id:string;closed_at:string}>{this.closeCalls++;if(this.options.closeError)throw this.options.closeError;return {request_id:'close-one',closed_at:'2026-10-01T03:00:00Z'};}
}

test('all six versioned templates compile only approved views, fixed joins and encoded typed literals',()=>{
  assert.deepEqual(zetarisTemplates.map(item=>item.id).sort(),Object.keys(filterByTemplate).sort());
  for(const id of Object.keys(filterByTemplate) as ZetarisCaptureRequest['template']['id'][]){const compiled=compileZetarisQuery(request(id),config);assert.match(compiled.select,/^SELECT /);assert.match(compiled.select,/INNER JOIN/);assert.match(compiled.select,/FETCH FIRST 11 ROWS ONLY$/);assert.doesNotMatch(compiled.select,/DELETE|INSERT|UPDATE|;|--/);assert.match(compiled.template_hash,/^[a-f0-9]{64}$/);assert.match(compiled.query_hash,/^[a-f0-9]{64}$/);}
  const quoted=request('release_exposure');quoted.filters={...quoted.filters,case_key:"case_o'reilly"};assert.match(compileZetarisQuery(quoted,config).select,/case_o''reilly/);
});

test('capture logs bounded page bytes and lineage, closes the query and is admissible only after explicit terminal state',async()=>{
  const second=page({page_id:'page_two',requested_cursor:'cursor_two',rows:[row({signal_id:'two',primary_record_id:'event_two'})],raw_bytes:Buffer.from('second-page')});
  const transport=new FixtureTransport({openPage:page({terminal:false,next_cursor:'cursor_two',raw_bytes:Buffer.from('first-page')}),pages:[second]});const result=await executeZetarisCapture(new ZetarisEvidenceClient(transport,config),request());
  assert.equal(result.status,'complete');assert.equal(result.admissible,true);assert.equal(result.pages.length,2);assert.equal(result.rows.length,2);assert.equal(result.close.status,'succeeded');assert.equal(transport.closeCalls,1);assert.equal(transport.pageCalls,1);assert.deepEqual(result.rows[0]!.lineage.map(item=>item.view_id),['sessions_public','releases_public']);assert.equal(result.pages[0]!.raw_bytes.toString(),'first-page');assert.match(result.capture_hash,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),/unit-secret|private-session|private-query/);
});

test('unapproved views and schema drift are rejected without converting them to empty evidence',async()=>{
  const unauthorized=request();unauthorized.view_ids={sessions:'private_sessions',releases:'releases_public'};assert.throws(()=>compileZetarisQuery(unauthorized,config),(error:unknown)=>error instanceof ConnectorError&&error.code==='ZETARIS_VIEW_UNAUTHORIZED');
  const missing=row();delete (missing as Partial<typeof missing>).related_record_id;const transport=new FixtureTransport({openPage:page({rows:[missing]})});const result=await new ZetarisEvidenceClient(transport,config).capture(request());assert.equal(result.status,'failed');assert.equal(result.reason_code,'INVALID_ZETARIS_SCHEMA');assert.equal(result.rows.length,0);assert.equal(transport.closeCalls,1);
});

test('expired or unauthorized login remains failed and never opens or closes a query',async()=>{
  const transport=new FixtureTransport({loginError:new ConnectorError('PROVIDER_UNAUTHORIZED','expired')});const result=await new ZetarisEvidenceClient(transport,config).capture(request());assert.equal(result.status,'failed');assert.equal(result.reason_code,'PROVIDER_UNAUTHORIZED');assert.equal(result.close.status,'not_attempted');assert.equal(transport.closeCalls,0);assert.equal(result.admissible,false);
});

test('duplicate and changed page identities are detected and the provider query still closes',async()=>{
  for(const [raw,expected] of [[Buffer.from('same-first'),'ZETARIS_DUPLICATE_PAGE'],[Buffer.from('changed-second'),'ZETARIS_CHANGED_PAGE']] as const){const first=page({page_id:'repeated',terminal:false,next_cursor:'next',raw_bytes:Buffer.from('same-first')}),second=page({page_id:'repeated',requested_cursor:'next',raw_bytes:raw});const transport=new FixtureTransport({openPage:first,pages:[second]});const result=await new ZetarisEvidenceClient(transport,config).capture(request());assert.equal(result.status,'failed');assert.equal(result.reason_code,expected);assert.equal(result.close.status,'succeeded');assert.equal(transport.closeCalls,1);}
});

test('page and row cap exhaustion are visible partial captures rather than complete evidence',async()=>{
  const pageCapTransport=new FixtureTransport({openPage:page({terminal:false,next_cursor:'unread',raw_bytes:Buffer.from('page-cap')})});const pageCap=await new ZetarisEvidenceClient(pageCapTransport,config).capture(request('release_exposure',{max_pages:1}));assert.equal(pageCap.status,'partial');assert.equal(pageCap.reason_code,'ZETARIS_PAGE_CAP');assert.equal(pageCap.admissible,false);assert.equal(pageCapTransport.pageCalls,0);assert.equal(pageCapTransport.closeCalls,1);
  const rowCapTransport=new FixtureTransport({openPage:page({rows:[row(),row({signal_id:'two',primary_record_id:'two'})]})});const rowCap=await new ZetarisEvidenceClient(rowCapTransport,config).capture(request('release_exposure',{max_rows:1}));assert.equal(rowCap.status,'partial');assert.equal(rowCap.reason_code,'ZETARIS_ROW_CAP');assert.equal(rowCap.rows.length,1);assert.equal(rowCap.observed_row_count,2);
});

test('cancellation during pagination returns cancelled and closes in finally',async()=>{
  class CancelTransport extends FixtureTransport{override async page():Promise<ZetarisProviderPage>{const error=new Error('cancelled');error.name='AbortError';throw error;}}
  const transport=new CancelTransport({openPage:page({terminal:false,next_cursor:'next',raw_bytes:Buffer.from('cancel-first')})});const result=await new ZetarisEvidenceClient(transport,config).capture(request());assert.equal(result.status,'cancelled');assert.equal(result.reason_code,'ZETARIS_CANCELLED');assert.equal(result.close.status,'succeeded');assert.equal(transport.closeCalls,1);assert.equal(result.admissible,false);
});

test('close failure invalidates an otherwise complete capture and remains explicit',async()=>{
  const transport=new FixtureTransport({closeError:new ConnectorError('PROVIDER_UNAVAILABLE','close failed')});const result=await new ZetarisEvidenceClient(transport,config).capture(request());assert.equal(result.status,'failed');assert.equal(result.reason_code,'ZETARIS_CLOSE_FAILED');assert.equal(result.close.status,'failed');assert.equal(result.close.error_code,'PROVIDER_UNAVAILABLE');assert.equal(result.admissible,false);
});

test('scope, unexpected fields and changed repeated rows fail closed',async()=>{
  const wrongWorkspace={...request(),workspace_id:'workspace_two'};assert.throws(()=>compileZetarisQuery(wrongWorkspace,config),(error:unknown)=>error instanceof ConnectorError&&error.code==='ZETARIS_WORKSPACE_MISMATCH');
  const extra={...request(),sql:'select secret'} as ZetarisCaptureRequest;assert.throws(()=>compileZetarisQuery(extra,config),(error:unknown)=>error instanceof ConnectorError&&error.code==='INVALID_ZETARIS_REQUEST');
  const first=page({terminal:false,next_cursor:'next',raw_bytes:Buffer.from('first')}),changed=page({page_id:'second',requested_cursor:'next',raw_bytes:Buffer.from('second'),rows:[row({summary:'changed'})]});const result=await new ZetarisEvidenceClient(new FixtureTransport({openPage:first,pages:[changed]}),config).capture(request());assert.equal(result.status,'failed');assert.equal(result.reason_code,'ZETARIS_CHANGED_ROW');
});

// zetaris runtime
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

// Reviewed current REST contract. All network responses here are deterministic
// injected transport fixtures; these tests make no live-provider assertion.
const restSource:ZetarisRuntimeSourceConfig={...source,adapter_id:'zetaris_rest_v1',approved_account_scope:'zetaris:org:73'};
const restConfig={adapter_id:restSource.adapter_id,approved_origin:restSource.approved_origin,contract_hash:contract,organisation_id:73};
const restBinding={credential,approved_origin:restSource.approved_origin,approved_account_scope:restSource.approved_account_scope,contract_hash:contract,source:restSource};
const restRow=(id='event_one'):unknown[]=>[`release_exposure:${id}:release_one`,'2026-10-01T12:34:56.789Z','release_a','session_one','mobile',null,null,'false',id,'release_one'];
const response=(value:unknown,status=200):WireResponse=>({status,headers:{'Content-Type':'application/json','X-Request-ID':'response-123'},body:Buffer.from(JSON.stringify(value))});
class RestFixture implements ZetarisRestHttp {
  calls:{method:string;url:string;options:RequestOptions}[]=[];
  constructor(private responses:(WireResponse|Error|((options:RequestOptions)=>Promise<WireResponse>))[]){}
  async request(method:'GET'|'POST',url:string,options:RequestOptions={}):Promise<WireResponse>{
    this.calls.push({method,url,options});const next=this.responses.shift();if(next instanceof Error)throw next;if(typeof next==='function')return next(options);if(!next)throw Error('Unexpected fixture wire request');return next;
  }
}

test('REST factory probes actual datasource and SQL reads with explicit org and fresh request UUIDs',async()=>{
  const transport=new RestFixture([response({data:[{name:'approved'}]}),response({data:[['1']]})]),factory=createZetarisRestAdapter(restConfig,{transport}),runtime=new ZetarisRuntimeRegistry();runtime.register(factory);
  const outcome=await runtime.probe(restSource,credential);assert.equal(outcome.runtime_status,'probed');if(outcome.runtime_status!=='probed')return;
  assert.equal(outcome.probe.status,'available');assert.equal(outcome.probe.observed_account_scope,null);assert.equal(outcome.probe.reason_code,'ZETARIS_ACCOUNT_SCOPE_NOT_ATTESTED');assert.equal(outcome.probe.provider_version,null);
  assert.deepEqual(transport.calls.map(call=>[call.method,call.url]),[['GET',`${restSource.approved_origin}/api/v1.0/datasource/datasources`],['POST',`${restSource.approved_origin}/api/v1.0/sql-editor/sqls/run`]]);
  for(const call of transport.calls){assert.equal(call.options.headers!.Authorization,`Bearer ${credential}`);assert.equal(call.options.headers!['X-Org-ID'],'73');assert.match(call.options.headers!['X-Request-ID']!,/^[a-f0-9-]{36}$/);assert.deepEqual(call.options.allowedOrigins,[restSource.approved_origin]);assert.equal(call.options.maxBytes,262_144);assert(call.options.signal instanceof AbortSignal);}
  assert.notEqual(transport.calls[0]!.options.headers!['X-Request-ID'],transport.calls[1]!.options.headers!['X-Request-ID']);
  const body=JSON.parse(transport.calls[1]!.options.body!.toString());assert.equal(body.sql,'SELECT 1 LIMIT 1');assert.equal(body.source,'SqlEditor');assert.equal(body.limit,1);assert.match(body.queryId,/^[a-f0-9-]{36}$/);assert.notEqual(body.queryId,transport.calls[1]!.options.headers!['X-Request-ID']);
});

test('REST capture uses the fixed compiler projection, LIMIT sentinel and one real protected response',async()=>{
  const transport=new RestFixture([response({data:[restRow()],columns:ZETARIS_PROJECTION_COLUMNS})]),factory=createZetarisRestAdapter(restConfig,{transport}),runtime=new ZetarisRuntimeRegistry();runtime.register(factory);
  const outcome=await runtime.capture(restSource,{...input,caps:{page_size:2,max_pages:3,max_rows:10}},credential);assert.equal(outcome.runtime_status,'captured');if(outcome.runtime_status!=='captured')return;
  const result=outcome.public_result;assert.equal(result.status,'complete');assert.equal(result.admissible,true);assert.equal(result.rows.length,1);assert.equal(result.pages.length,1);assert.equal(result.close.status,'not_attempted');assert.equal(result.read_account_scope,'zetaris:org:73');assert.equal(result.provider_version,null);assert.equal(outcome.evidence_drafts.length,1);assert.match(result.limitations.join(' '),/does not attest the account scope/);assert.match(result.limitations.join(' '),/execution may continue/);
  const requestBody=JSON.parse(transport.calls[0]!.options.body!.toString());assert.equal(requestBody.limit,3);assert.match(requestBody.sql,/LIMIT 3$/);assert.match(requestBody.sql,/^SELECT /);assert.doesNotMatch(requestBody.sql,/FETCH FIRST/);assert.equal(requestBody.source,'SqlEditor');assert.equal(transport.calls.length,1);assert.equal(result.pages[0]!.body_hash,hashRaw(outcome.raw_pages[0]!.raw_bytes));assert.equal(result.query_hash,hashRaw(Buffer.from(requestBody.sql)));assert.equal(Object.hasOwn(result.pages[0]!,'raw_bytes'),false);assert.doesNotMatch(JSON.stringify(result),new RegExp(credential));
});
function hashRaw(bytes:Buffer):string{return createHash('sha256').update(bytes).digest('hex');}

test('REST row sentinel and effective page capacity remain partial and emit no evidence',async()=>{
  for(const [caps,expected] of [[{page_size:10,max_pages:2,max_rows:1},'ZETARIS_ROW_CAP'],[{page_size:1,max_pages:1,max_rows:10},'ZETARIS_PAGE_CAP']] as const){
    const transport=new RestFixture([response({data:[restRow('one'),restRow('two')]})]),runtime=new ZetarisRuntimeRegistry();runtime.register(createZetarisRestAdapter(restConfig,{transport}));
    const outcome=await runtime.capture(restSource,{...input,caps},credential);assert.equal(outcome.runtime_status,'captured');if(outcome.runtime_status!=='captured')return;assert.equal(outcome.public_result.status,'partial');assert.equal(outcome.public_result.reason_code,expected);assert.equal(outcome.public_result.admissible,false);assert.equal(outcome.public_result.observed_row_count,2);assert.equal(outcome.public_result.rows.length,1);assert.equal(outcome.public_result.pages[0]!.terminal,false);assert.deepEqual(outcome.evidence_drafts,[]);assert.equal(transport.calls.length,1);
  }
});

test('REST additional approved pages cannot enlarge a single response beyond its page size',async()=>{
  for(const rowCount of [11,40]){
    const transport=new RestFixture([response({data:Array.from({length:rowCount},(_,index)=>restRow(`event_${index}`))})]),runtime=new ZetarisRuntimeRegistry();runtime.register(createZetarisRestAdapter(restConfig,{transport}));
    const outcome=await runtime.capture(restSource,{...input,caps:{page_size:10,max_pages:5,max_rows:100}},credential);assert.equal(outcome.runtime_status,'captured');if(outcome.runtime_status!=='captured')return;
    assert.equal(outcome.public_result.status,rowCount===11?'partial':'failed');assert.equal(outcome.public_result.reason_code,rowCount===11?'ZETARIS_PAGE_CAP':'ZETARIS_RESPONSE_ROW_CAP');assert.equal(outcome.public_result.admissible,false);assert(outcome.public_result.rows.length<=10);assert.deepEqual(outcome.evidence_drafts,[]);
    const requestBody=JSON.parse(transport.calls[0]!.options.body!.toString());assert.equal(requestBody.limit,11);assert.match(requestBody.sql,/LIMIT 11$/);assert.equal(transport.calls.length,1);
  }
});

test('REST rejects schema drift, duplicate signals, omitted data, metadata truncation and secret reflection',async()=>{
  const cases:[unknown,string][]=[
    [{data:[restRow().slice(0,9)]},'INVALID_ZETARIS_SCHEMA'],
    [{data:[Object.fromEntries(ZETARIS_PROJECTION_COLUMNS.map((column,index)=>[column,restRow()[index]]))]},'INVALID_ZETARIS_SCHEMA'],
    [{data:[restRow()],columns:[...ZETARIS_PROJECTION_COLUMNS].reverse()},'INVALID_ZETARIS_SCHEMA'],
    [{data:[restRow(),restRow()]},'ZETARIS_DUPLICATE_ROW'],
    [{data:[restRow('one'),[restRow('one')[0],...restRow('two').slice(1)]]},'ZETARIS_DUPLICATE_ROW'],
    [{data:[['wrong-template:one:release_one',...restRow().slice(1)]]},'ZETARIS_PROJECTION_MISMATCH'],
    [{data:[[restRow()[0],'2026-10-03T00:00:00Z',...restRow().slice(2)]]},'ZETARIS_PROJECTION_MISMATCH'],
    [{data:[[...restRow().slice(0,2),'another_release',...restRow().slice(3)]]},'ZETARIS_PROJECTION_MISMATCH'],
    [{},'INVALID_ZETARIS_SCHEMA'],
    [{data:[],hasMore:true},'INVALID_ZETARIS_SCHEMA'],
    [{data:[[...restRow().slice(0,6),credential,...restRow().slice(7)]]},'PROVIDER_SECRET_REFLECTION'],
  ];
  for(const [value,expected]of cases){const transport=new RestFixture([response(value)]),api=await createZetarisRestAdapter(restConfig,{transport}).createApi(restBinding);const result=await api.capture(buildZetarisCaptureRequest(restSource,input));assert.equal(result.status,'failed');assert.equal(result.reason_code,expected);assert.equal(result.admissible,false);assert.deepEqual(result.rows,[]);assert.deepEqual(result.pages,[]);assert.doesNotMatch(JSON.stringify(result),new RegExp(credential));}
  const duplicate=response({data:[]});duplicate.body=Buffer.from('{"data":[],"data":[]}');const result=await (await createZetarisRestAdapter(restConfig,{transport:new RestFixture([duplicate])}).createApi(restBinding)).capture(buildZetarisCaptureRequest(restSource,input));assert.equal(result.reason_code,'DUPLICATE_PROVIDER_KEY');
});

test('REST probe failures are unavailable, unauthorized or unsupported without reflecting provider errors',async()=>{
  for(const [wire,expected,code]of [[response({error:credential},401),'unauthorized','PROVIDER_UNAUTHORIZED'],[response({error:credential},503),'unavailable','PROVIDER_UNAVAILABLE'],[response({unexpected:true}),'unsupported','INVALID_ZETARIS_SCHEMA'],[new Error(`socket ${credential}`),'unavailable','PROVIDER_UNAVAILABLE']] as const){
    const factory=createZetarisRestAdapter(restConfig,{transport:new RestFixture([wire])}),probe=await factory.probe(restBinding);assert.equal(probe.status,expected);assert.equal(probe.reason_code,code);assert.equal(probe.observed_account_scope,null);assert.doesNotMatch(JSON.stringify(probe),new RegExp(credential));
  }
  const factory=createZetarisRestAdapter(restConfig,{transport:new RestFixture([response({data:[]}),response({data:[]})])});assert.equal((await factory.probe(restBinding)).status,'unsupported');
});

test('REST byte caps, excess rows, truncated JSON, deadline and cancellation fail closed',async()=>{
  const request=buildZetarisCaptureRequest(restSource,input);
  const oversized=response({data:[restRow()]});const invalid={...response({}),body:Buffer.from('{"data":[')};
  for(const [wire,cap,code]of [[oversized,16,'PROVIDER_BYTE_LIMIT'],[invalid,1000,'INVALID_PROVIDER_JSON']] as const){const api=await createZetarisRestAdapter(restConfig,{transport:new RestFixture([wire])}).createApi(restBinding),result=await api.capture({...request,caps:{...request.caps,max_page_bytes:cap}});assert.equal(result.status,'failed');assert.equal(result.reason_code,code);assert.equal(result.admissible,false);}
  const excess=await (await createZetarisRestAdapter(restConfig,{transport:new RestFixture([response({data:[restRow('one'),restRow('two'),restRow('three')]})])}).createApi(restBinding)).capture({...request,caps:{...request.caps,max_rows:1}});assert.equal(excess.reason_code,'ZETARIS_RESPONSE_ROW_CAP');
  const controller=new AbortController(),transport=new RestFixture([async()=>{controller.abort();return response({data:[restRow()]});}]),api=await createZetarisRestAdapter(restConfig,{transport}).createApi(restBinding),cancelled=await api.capture(request,{signal:controller.signal});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.admissible,false);assert.deepEqual(cancelled.rows,[]);
  const beforeTransport=new RestFixture([]),beforeApi=await createZetarisRestAdapter(restConfig,{transport:beforeTransport}).createApi(restBinding),before=await beforeApi.capture(request,{signal:controller.signal});assert.equal(before.status,'cancelled');assert.equal(beforeTransport.calls.length,0);
  const deadlineApi=await createZetarisRestAdapter(restConfig,{deadline_ms:10,transport:new RestFixture([async()=>new Promise(resolve=>setTimeout(()=>resolve(response({data:[]})),40))])}).createApi(restBinding),timed=await deadlineApi.capture(request);assert.equal(timed.status,'failed');assert.equal(timed.reason_code,'PROVIDER_ABORTED');
});

test('REST immutable binding rejects scope, origin, contract, credentials and raw SQL before the wire',async()=>{
  assert.throws(()=>createZetarisRestAdapter({...restConfig,organisation_id:0}),/explicit positive/);assert.throws(()=>createZetarisRestAdapter({...restConfig,approved_origin:'http://zetaris.example.test'}),/HTTPS/);assert.throws(()=>createZetarisRestAdapter({...restConfig,approved_origin:'https://127.0.0.1'}),/literal/);
  const transport=new RestFixture([]),factory=createZetarisRestAdapter(restConfig,{transport});
  for(const binding of [{...restBinding,approved_account_scope:'zetaris:org:1'},{...restBinding,approved_origin:'https://other.example.test'},{...restBinding,contract_hash:'d'.repeat(64)},{...restBinding,credential:'key\r\ninjected'}])await assert.rejects(async()=>factory.createApi(binding),ConnectorError);
  const api=await factory.createApi(restBinding),request=buildZetarisCaptureRequest(restSource,input);await assert.rejects(()=>api.capture({...request,sql:'DROP TABLE private'} as ZetarisCaptureRequest),(error:unknown)=>error instanceof ConnectorError&&error.code==='INVALID_ZETARIS_REQUEST');assert.equal(transport.calls.length,0);
});

test('decoded credential reflection catches JSON-escaped strings and keys before capture or probe exposure',async()=>{
  for(const escapedCredential of ['key-with-"quoted"-segment','key-with-\\backslash']){
    const value={nested:[{summary:`provider echoed ${escapedCredential}`}]};assert.equal(JSON.stringify(value).includes(escapedCredential),false);assert.equal(containsProviderSecret(value,escapedCredential),true);assert.equal(containsProviderSecret({[escapedCredential]:'unexpected metadata'},escapedCredential),true);
    const cycle:Record<string,unknown>={safe:'unrelated'};cycle.self=cycle;assert.equal(containsProviderSecret(cycle,escapedCredential),false);
    const binding={...restBinding,credential:escapedCredential},reflectedRow=restRow();reflectedRow[6]=`provider echoed ${escapedCredential}`;
    const api=await createZetarisRestAdapter(restConfig,{transport:new RestFixture([response({data:[reflectedRow]})])}).createApi(binding),result=await api.capture(buildZetarisCaptureRequest(restSource,input));assert.equal(result.status,'failed');assert.equal(result.reason_code,'PROVIDER_SECRET_REFLECTION');assert.equal(result.admissible,false);assert.deepEqual(result.rows,[]);assert.deepEqual(result.pages,[]);
    const probe=await createZetarisRestAdapter(restConfig,{transport:new RestFixture([response({data:[{name:escapedCredential}]})])}).probe(binding);assert.equal(probe.status,'unavailable');assert.equal(probe.reason_code,'PROVIDER_SECRET_REFLECTION');assert.equal(containsProviderSecret(probe,escapedCredential),false);
  }
});
