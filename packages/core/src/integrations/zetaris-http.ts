import {randomUUID} from 'node:crypto';
import {byteHash, hash} from '../canonical.js';
import {
  compileZetarisQuery, normalizeZetarisRow, ZETARIS_PROJECTION_COLUMNS, ZETARIS_PROTOCOL, zetarisTemplates,
  type ZetarisApi, type ZetarisCaptureRequest, type ZetarisCaptureResult, type ZetarisConfig,
} from '../connectors/zetaris/index.js';
import {checkActive, ConnectorError, containsProviderSecret, object, providerOrigin, requireSuccess, requireWire, safeRequestId, strictJson, type ExecutionControl, type WireResponse} from '../connectors/wire.js';
import {PinnedHttpTransport, type RequestOptions} from './transport.js';
import {validateZetarisRuntimeSourceConfig, type ZetarisRuntimeAdapterFactory, type ZetarisRuntimeSourceConfig} from './zetaris-runtime.js';

/** Reviewed contract: Zetaris getting-started/scripts/zetaris_sql.py RestChannel.
 * Only the current Bearer/org REST contract is implemented. No legacy query
 * handles, pagination, login, remote cancellation or close endpoint is inferred.
 */
export interface ZetarisRestAdapterConfig {
  adapter_id:string;
  approved_origin:string;
  contract_hash:string;
  organisation_id:number;
}
/** Injection boundary must provide the same wire guarantees as PinnedHttpTransport. */
export interface ZetarisRestHttp {request(method:'GET'|'POST',url:string,options?:RequestOptions):Promise<WireResponse>;}
export interface ZetarisRestAdapterOptions {transport?:ZetarisRestHttp;deadline_ms?:number;}
type Binding={credential:string;approved_origin:string;approved_account_scope:string;contract_hash:string};
const MAX_PROBE_BYTES=262_144;
const LIMITATIONS=[
  'Zetaris rows are supplementary association evidence and never replace canonical conversion counts.',
  'The provider query is not assumed to be a transactionally stable snapshot.',
  'The organization is bound by the operator configuration and X-Org-ID request header; the provider response does not attest the account scope.',
  'The reviewed REST contract has no remote cancellation or close operation. Local cancellation stops waiting and aborts the connection; provider execution may continue.',
  'One bounded REST result is captured. Remote cursors and pagination are not available under this contract.',
];

function assertConfig(input:ZetarisRestAdapterConfig):ZetarisRestAdapterConfig {
  requireWire(input!==null&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['adapter_id','approved_origin','contract_hash','organisation_id'].includes(key)),'INVALID_ZETARIS_REST_CONFIG','The REST adapter configuration has unsupported fields.');
  requireWire(typeof input.adapter_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.adapter_id),'INVALID_ZETARIS_REST_CONFIG','The REST adapter ID is invalid.');
  requireWire(typeof input.approved_origin==='string'&&providerOrigin(input.approved_origin)===input.approved_origin,'INVALID_ZETARIS_REST_CONFIG','The REST adapter requires an exact approved HTTPS origin.');
  requireWire(typeof input.contract_hash==='string'&&/^[a-f0-9]{64}$/.test(input.contract_hash),'INVALID_ZETARIS_REST_CONFIG','The REST adapter requires the reviewed contract digest.');
  requireWire(Number.isSafeInteger(input.organisation_id)&&input.organisation_id>0,'INVALID_ZETARIS_REST_CONFIG','The REST adapter requires an explicit positive organization ID.');
  return Object.freeze({...input});
}
function assertBinding(input:Binding,config:ZetarisRestAdapterConfig):void {
  requireWire(input.approved_origin===config.approved_origin&&input.contract_hash===config.contract_hash&&input.approved_account_scope===`zetaris:org:${config.organisation_id}`,'ZETARIS_REST_BINDING_MISMATCH','The REST origin, reviewed contract or organization binding does not match the configured adapter.');
  requireWire(typeof input.credential==='string'&&input.credential.length>0&&input.credential.length<=8192&&!/[\u0000-\u0020\u007f-\uffff]/.test(input.credential),'INVALID_ZETARIS_CREDENTIAL','The REST adapter requires a finite Bearer API key without whitespace or control characters.');
}
function reason(error:unknown,control:ExecutionControl):string {
  if(control.signal?.aborted||error instanceof Error&&error.name==='AbortError'||error instanceof ConnectorError&&['CAPTURE_CANCELLED','ZETARIS_CANCELLED'].includes(error.code))return 'ZETARIS_CANCELLED';
  return error instanceof ConnectorError&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)?error.code:'PROVIDER_UNAVAILABLE';
}
function noSecret(value:unknown,credential:string):void {requireWire(!containsProviderSecret(value,credential),'PROVIDER_SECRET_REFLECTION','Provider data reflected its credential and was rejected.');}
function parse(response:WireResponse,maxBytes:number,credential:string):unknown {
  requireSuccess(response);const value=strictJson(response.body,maxBytes);noSecret(value,credential);noSecret(response.headers,credential);return value;
}
/** The emitted SELECT fixes the positional alias order. Optional column labels
 * must attest the same order; row objects or alternate metadata are not guessed.
 */
function resultRows(value:unknown,columns:readonly string[],maxRows:number):unknown[][] {
  const envelope=object(value);
  requireWire(Object.keys(envelope).every(key=>['data','columns'].includes(key))&&Array.isArray(envelope.data),'INVALID_ZETARIS_SCHEMA','The SQL response does not match the reviewed data envelope.');
  if(envelope.columns!==undefined)requireWire(Array.isArray(envelope.columns)&&envelope.columns.length===columns.length&&envelope.columns.every((column,index)=>column===columns[index]),'INVALID_ZETARIS_SCHEMA','The SQL response column order differs from the fixed projection.');
  const rows=envelope.data;
  requireWire(rows.length<=maxRows,'ZETARIS_RESPONSE_ROW_CAP','The SQL response exceeded the requested finite row limit.');
  requireWire(rows.every(row=>Array.isArray(row)&&row.length===columns.length),'INVALID_ZETARIS_SCHEMA','The SQL response rows differ from the fixed projection width.');
  return rows as unknown[][];
}

/** Creates a real, read-only REST adapter without reading process environment or
 * retaining a deployment credential. The runtime supplies credentials per call.
 * Scope format is exactly zetaris:org:<explicit numeric organization ID>.
 */
export function createZetarisRestAdapter(configInput:ZetarisRestAdapterConfig,options:ZetarisRestAdapterOptions={}):ZetarisRuntimeAdapterFactory {
  const config=assertConfig(configInput),deadline=options.deadline_ms??30_000;
  requireWire(Number.isSafeInteger(deadline)&&deadline>=1&&deadline<=90_000,'INVALID_ZETARIS_REST_CONFIG','The REST request deadline must be finite and at most ninety seconds.');
  const http=options.transport??new PinnedHttpTransport({origins:[config.approved_origin],timeoutMs:deadline});

  async function call(method:'GET'|'POST',path:'/datasource/datasources'|'/sql-editor/sqls/run',binding:Binding,maxBytes:number,control:ExecutionControl,body?:Buffer):Promise<WireResponse> {
    assertBinding(binding,config);await checkActive(control);
    const deadlineSignal=AbortSignal.timeout(deadline),signal=AbortSignal.any([deadlineSignal,...(control.signal?[control.signal]:[])]);
    let stop=()=>{};
    const aborted=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(new ConnectorError(control.signal?.aborted?'ZETARIS_CANCELLED':'PROVIDER_ABORTED','The bounded REST read was cancelled or reached its deadline.'));signal.addEventListener('abort',abort,{once:true});stop=()=>signal.removeEventListener('abort',abort);});
    try {
      signal.throwIfAborted();
      const response=await Promise.race([http.request(method,`${config.approved_origin}/api/v1.0${path}`,{allowedOrigins:[config.approved_origin],maxBytes,signal,headers:{Authorization:`Bearer ${binding.credential}`,'X-Org-ID':String(config.organisation_id),'X-Request-ID':randomUUID(),'Content-Type':'application/json'},...(body?{body}:{})}),aborted]);
      await checkActive(control);requireWire(Buffer.isBuffer(response.body)&&response.body.length>0&&response.body.length<=maxBytes,'PROVIDER_BYTE_LIMIT','The REST response is empty or exceeds its frozen byte cap.');return response;
    } catch(error) {throw new ConnectorError(reason(error,control),'The bounded REST read did not yield admissible provider data.');}
    finally {stop();}
  }
  async function run(sql:string,limit:number,binding:Binding,maxBytes:number,control:ExecutionControl):Promise<WireResponse> {
    // SQL is generated by the fixed compiler below, or the literal probe SELECT.
    const body=Buffer.from(JSON.stringify({queryId:randomUUID(),sql,source:'SqlEditor',limit}));
    return call('POST','/sql-editor/sqls/run',binding,maxBytes,control,body);
  }

  function createApi(input:Binding&{source:ZetarisRuntimeSourceConfig}):ZetarisApi {
    assertBinding(input,config);
    const validated=validateZetarisRuntimeSourceConfig(input.source);
    requireWire(validated.adapter_id===config.adapter_id&&validated.approved_origin===config.approved_origin&&validated.contract_hash===config.contract_hash&&validated.approved_account_scope===input.approved_account_scope,'ZETARIS_REST_BINDING_MISMATCH','The source differs from its reviewed REST adapter binding.');
    const source={...validated,approved_views:validated.approved_views.map(view=>({...view,columns:{...view.columns}}))};
    const binding:Binding={credential:input.credential,approved_origin:input.approved_origin,approved_account_scope:input.approved_account_scope,contract_hash:input.contract_hash};
    const compilerConfig:ZetarisConfig={workspace_id:source.workspace_id,source_id:source.source_id,credential:binding.credential,read_account_scope:source.approved_account_scope,approved_views:source.approved_views};
    return {async capture(request:ZetarisCaptureRequest,control:ExecutionControl={}):Promise<ZetarisCaptureResult> {
      // Freeze mutable caller objects before the first asynchronous boundary.
      const frozen=structuredClone(request),compiled=compileZetarisQuery(frozen,compilerConfig),started_at=new Date().toISOString();
      // This contract returns one response, so additional approved pages cannot
      // enlarge its per-response row budget. One extra row is only a sentinel.
      const capacity=Math.min(frozen.caps.max_rows,frozen.caps.page_size),limit=capacity+1;
      // Zetaris uses Spark SQL LIMIT. The anchored replacement can only replace
      // the compiler-owned terminal guard, never user values within literals.
      const sql=compiled.select.replace(/ FETCH FIRST \d+ ROWS ONLY$/,` LIMIT ${limit}`);
      requireWire(sql!==compiled.select,'ZETARIS_QUERY_COMPILER_MISMATCH','The reviewed SQL compiler guard is absent.');
      const query_hash=byteHash(Buffer.from(sql)),input_hash=hash(frozen),definition=zetarisTemplates.find(template=>template.id===frozen.template.id)!;
      const primary=source.approved_views.find(view=>view.id===frozen.view_ids[definition.primary])!,related=source.approved_views.find(view=>view.id===frozen.view_ids[definition.related])!;
      let status:ZetarisCaptureResult['status']='failed',reason_code:string|null='PROVIDER_UNAVAILABLE',observed_row_count=0;
      let rows:ZetarisCaptureResult['rows']=[],pages:ZetarisCaptureResult['pages']=[];
      try {
        const response=await run(sql,limit,binding,Math.min(frozen.caps.max_page_bytes,frozen.caps.max_total_bytes),control);
        const values=resultRows(parse(response,Math.min(frozen.caps.max_page_bytes,frozen.caps.max_total_bytes),binding.credential),ZETARIS_PROJECTION_COLUMNS,limit);
        observed_row_count=values.length;
        const normalized=values.map(value=>normalizeZetarisRow(Object.fromEntries(ZETARIS_PROJECTION_COLUMNS.map((name,index)=>[name,value[index]])),frozen,primary,related));
        const identities=new Set<string>(),signalIds=new Set<string>();
        for(const row of normalized){
          const identity=JSON.stringify(row.lineage.map(item=>item.record_id));
          requireWire(!identities.has(identity)&&!signalIds.has(row.signal_id),'ZETARIS_DUPLICATE_ROW','The REST response repeated a signal or lineage identity.');
          requireWire(row.signal_id===`${frozen.template.id}:${row.lineage[0].record_id}:${row.lineage[1].record_id}`&&Date.parse(row.occurred_at)>=Date.parse(frozen.filters.from)&&Date.parse(row.occurred_at)<Date.parse(frozen.filters.to)&&(!frozen.filters.release_id||row.release_id===frozen.filters.release_id)&&(!frozen.filters.affected_cohort||row.cohort===frozen.filters.affected_cohort||row.cohort===frozen.filters.control_cohort),'ZETARIS_PROJECTION_MISMATCH','The SQL response does not satisfy the observable fixed projection and request filters.');
          identities.add(identity);signalIds.add(row.signal_id);
        }
        const capped=values.length>=limit,observed_at=new Date().toISOString(),request_id=safeRequestId(response)??null;
        rows=normalized.slice(0,capacity);
        pages=[{index:0,page_id:`rest:${byteHash(response.body)}`,requested_cursor:null,next_cursor:null,terminal:!capped,row_count:values.length,accepted_row_count:rows.length,byte_count:response.body.length,body_hash:byteHash(response.body),metadata_hash:hash({contract_hash:config.contract_hash,column_order:ZETARIS_PROJECTION_COLUMNS,sql_limit:limit,rest_single_response:true,account_scope_attested:false}),observed_at,request_id,raw_bytes:Buffer.from(response.body)}];
        status=capped?'partial':'complete';reason_code=capped?(capacity<frozen.caps.max_rows?'ZETARIS_PAGE_CAP':'ZETARIS_ROW_CAP'):null;
        await checkActive(control);
      } catch(error) {reason_code=reason(error,control);status=reason_code==='ZETARIS_CANCELLED'?'cancelled':'failed';rows=[];}
      const ended_at=new Date().toISOString(),close:ZetarisCaptureResult['close']={status:'not_attempted',closed_at:null,request_id:null,error_code:null};
      const limitations=[...LIMITATIONS];if(status!=='complete')limitations.push('The provider capture is incomplete or unusable and cannot enter an issued report.');
      const result:Omit<ZetarisCaptureResult,'capture_hash'>={protocol:ZETARIS_PROTOCOL,adapter_version:ZETARIS_PROTOCOL,status,reason_code,admissible:status==='complete',workspace_id:frozen.workspace_id,source_id:source.source_id,case_id:frozen.case_id,revision_id:frozen.revision_id,metric_hash:frozen.metric_hash,comparison_hash:frozen.comparison_hash,template_id:frozen.template.id,template_version:1,template_hash:compiled.template_hash,input_hash,query_hash,selected_views:compiled.selected_views,requested_bounds:{from:new Date(frozen.filters.from).toISOString(),to:new Date(frozen.filters.to).toISOString()},read_account_scope:source.approved_account_scope,provider_version:null,started_at,ended_at,rows,observed_row_count,pages,close,limitations};
      // Protected bytes are excluded from the public digest but frozen via body_hash.
      return {...result,capture_hash:hash({...result,pages:pages.map(({raw_bytes:_,...page})=>page)})};
    }};
  }

  return {
    adapter_id:config.adapter_id,approved_origin:config.approved_origin,contract_hash:config.contract_hash,createApi,
    async probe(input,control={}) {
      const binding:Binding={credential:input.credential,approved_origin:input.approved_origin,approved_account_scope:input.approved_account_scope,contract_hash:input.contract_hash};
      assertBinding(binding,config);await checkActive(control);
      try {
        const listing=parse(await call('GET','/datasource/datasources',binding,MAX_PROBE_BYTES,control),MAX_PROBE_BYTES,binding.credential);
        const datasources=Array.isArray(listing)?listing:object(listing).data;
        requireWire(Array.isArray(datasources)&&datasources.length<=1000&&datasources.every(item=>{const value=object(item);return typeof value.name==='string'&&value.name.length>0&&value.name.length<=500;}),'INVALID_ZETARIS_SCHEMA','The datasource probe response differs from the reviewed contract.');
        const response=await run('SELECT 1 LIMIT 1',1,binding,MAX_PROBE_BYTES,control),rows=resultRows(parse(response,MAX_PROBE_BYTES,binding.credential),['1'],1);
        requireWire(rows.length===1&&(rows[0]![0]==='1'||rows[0]![0]===1),'INVALID_ZETARIS_SCHEMA','The read-only SQL probe did not return the expected constant.');
        return {status:'available',checked_at:new Date().toISOString(),provider_version:null,observed_account_scope:null,reason_code:'ZETARIS_ACCOUNT_SCOPE_NOT_ATTESTED',read_only:true};
      } catch(error) {
        const code=reason(error,control);if(code==='ZETARIS_CANCELLED')throw new ConnectorError(code,'The REST capability probe was cancelled.');
        return {status:code==='PROVIDER_UNAUTHORIZED'?'unauthorized':code==='INVALID_ZETARIS_SCHEMA'?'unsupported':'unavailable',checked_at:new Date().toISOString(),provider_version:null,observed_account_scope:null,reason_code:code,read_only:true};
      }
    },
  };
}
