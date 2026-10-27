import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorError,type ExecutionControl} from '../wire.js';
import {compileZetarisQuery,executeZetarisCapture,ZETARIS_PROTOCOL,ZetarisEvidenceClient,zetarisTemplates,type ZetarisCaptureRequest,type ZetarisConfig,type ZetarisOpenResult,type ZetarisProviderPage,type ZetarisSessionHandle,type ZetarisTransport} from './index.js';

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
