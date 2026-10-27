import {randomUUID} from 'node:crypto';
import {byteHash, canonical, hash} from '../../canonical.js';
import {checkActive, ConnectorError, requireWire, type ExecutionControl} from '../wire.js';

export const ZETARIS_PROTOCOL = 'faultline-zetaris-v1' as const;
export const ZETARIS_TEMPLATE_VERSION = 1 as const;

export type ZetarisViewRole = 'sessions'|'releases'|'support'|'changes';
export type ZetarisColumn = 'record_id'|'occurred_at'|'release_id'|'session_id'|'cohort'|'case_key'|'flow_key'|'conversion_status'|'symptom_ref'|'summary';
export type ZetarisTemplateId = 'release_exposure'|'support_symptoms'|'change_timeline'|'cohort_context'|'contrary_evidence'|'followup_recheck';
export type ZetarisCaptureStatus = 'complete'|'partial'|'failed'|'cancelled';

export interface ZetarisApprovedView {
  /** Stable application ID selected by the user. */
  id:string;
  role:ZetarisViewRole;
  /** Exact provider relation identifier approved by an administrator. */
  identifier:string;
  /** Provider column names mapped to Faultline's fixed query vocabulary. */
  columns:Partial<Record<ZetarisColumn,string>>;
}

export interface ZetarisConfig {
  workspace_id:string;
  source_id:string;
  credential:string;
  read_account_scope:string;
  approved_views:readonly ZetarisApprovedView[];
}

export interface ZetarisCaptureRequest {
  protocol:typeof ZETARIS_PROTOCOL;
  template:{id:ZetarisTemplateId;version:typeof ZETARIS_TEMPLATE_VERSION};
  workspace_id:string;
  case_id:string;
  revision_id:string;
  metric_hash:string;
  comparison_hash:string;
  view_ids:Partial<Record<ZetarisViewRole,string>>;
  filters:{from:string;to:string;case_key:string;flow_key?:string;release_id?:string;affected_cohort?:string;control_cohort?:string};
  caps:{page_size:number;max_pages:number;max_rows:number;max_page_bytes:number;max_total_bytes:number};
}

export interface ZetarisSessionHandle {handle:string;account_scope:string;expires_at:string|null;provider_version:string|null;request_id:string|null;}
export interface ZetarisProviderPage {
  page_id:string;
  requested_cursor:string|null;
  next_cursor:string|null;
  terminal:boolean;
  rows:unknown[];
  raw_bytes:Buffer;
  observed_at:string;
  request_id:string|null;
  metadata:Record<string,string|number|boolean|null>;
}
export interface ZetarisOpenResult {query_handle:string;request_id:string|null;page:ZetarisProviderPage;}
export interface ZetarisCloseResult {request_id:string|null;closed_at:string;}

/**
 * Session/cursor boundary for explicitly reviewed providers that actually expose
 * this lifecycle. Current Zetaris REST uses the direct ZetarisApi capture path;
 * this port must never imply undocumented login, page or close endpoints.
 */
export interface ZetarisTransport {
  login(input:{credential:string;request_id:string},control?:ExecutionControl):Promise<ZetarisSessionHandle>;
  open(input:{session_handle:string;request_id:string;select:string;page_limit:number},control?:ExecutionControl):Promise<ZetarisOpenResult>;
  page(input:{session_handle:string;query_handle:string;request_id:string;cursor:string},control?:ExecutionControl):Promise<ZetarisProviderPage>;
  close(input:{session_handle:string;query_handle:string;request_id:string},control?:ExecutionControl):Promise<ZetarisCloseResult>;
}

export interface ZetarisNormalizedSignal {
  signal_id:string;
  relationship:ZetarisTemplateId;
  occurred_at:string;
  release_id:string|null;
  session_id:string|null;
  cohort:string|null;
  symptom_ref:string|null;
  summary:string|null;
  context_value:string|null;
  lineage:[{view_id:string;role:ZetarisViewRole;record_id:string},{view_id:string;role:ZetarisViewRole;record_id:string}];
  content_hash:string;
}

export interface ZetarisPageLedgerEntry {
  index:number;
  page_id:string;
  requested_cursor:string|null;
  next_cursor:string|null;
  terminal:boolean;
  row_count:number;
  accepted_row_count:number;
  byte_count:number;
  body_hash:string;
  metadata_hash:string;
  observed_at:string;
  request_id:string|null;
  /** Exact private capture bytes; persistence code must store them as protected objects. */
  raw_bytes:Buffer;
}

export interface ZetarisCaptureResult {
  protocol:typeof ZETARIS_PROTOCOL;
  adapter_version:typeof ZETARIS_PROTOCOL;
  status:ZetarisCaptureStatus;
  reason_code:string|null;
  admissible:boolean;
  workspace_id:string;
  source_id:string;
  case_id:string;
  revision_id:string;
  metric_hash:string;
  comparison_hash:string;
  template_id:ZetarisTemplateId;
  template_version:1;
  template_hash:string;
  input_hash:string;
  query_hash:string;
  selected_views:Record<string,string>;
  requested_bounds:{from:string;to:string};
  read_account_scope:string|null;
  provider_version:string|null;
  started_at:string;
  ended_at:string;
  rows:ZetarisNormalizedSignal[];
  observed_row_count:number;
  pages:ZetarisPageLedgerEntry[];
  close:{status:'not_attempted'|'succeeded'|'failed';closed_at:string|null;request_id:string|null;error_code:string|null};
  limitations:string[];
  capture_hash:string;
}

type Template = {
  id:ZetarisTemplateId;
  primary:ZetarisViewRole;
  related:ZetarisViewRole;
  join:readonly ('case_key'|'release_id'|'session_id')[];
  requiredFilters:readonly ('flow_key'|'release_id'|'affected_cohort'|'control_cohort')[];
  allowedFilters:readonly ('flow_key'|'release_id'|'affected_cohort'|'control_cohort')[];
  primaryOutput:{session_id?:ZetarisColumn;cohort?:ZetarisColumn;symptom_ref?:ZetarisColumn;summary?:ZetarisColumn;context_value?:ZetarisColumn};
};

const TEMPLATES:Readonly<Record<ZetarisTemplateId,Template>> = {
  release_exposure:{id:'release_exposure',primary:'sessions',related:'releases',join:['case_key','release_id'],requiredFilters:['flow_key','release_id'],allowedFilters:['flow_key','release_id'],primaryOutput:{session_id:'session_id',cohort:'cohort',context_value:'conversion_status'}},
  support_symptoms:{id:'support_symptoms',primary:'support',related:'releases',join:['case_key','release_id'],requiredFilters:['release_id'],allowedFilters:['release_id'],primaryOutput:{session_id:'session_id',symptom_ref:'symptom_ref',summary:'summary'}},
  change_timeline:{id:'change_timeline',primary:'changes',related:'releases',join:['case_key','release_id'],requiredFilters:['release_id'],allowedFilters:['release_id'],primaryOutput:{summary:'summary'}},
  cohort_context:{id:'cohort_context',primary:'sessions',related:'releases',join:['case_key','release_id'],requiredFilters:['flow_key','affected_cohort','control_cohort'],allowedFilters:['flow_key','affected_cohort','control_cohort'],primaryOutput:{session_id:'session_id',cohort:'cohort',context_value:'conversion_status'}},
  contrary_evidence:{id:'contrary_evidence',primary:'sessions',related:'releases',join:['case_key','release_id'],requiredFilters:['flow_key','release_id','affected_cohort','control_cohort'],allowedFilters:['flow_key','release_id','affected_cohort','control_cohort'],primaryOutput:{session_id:'session_id',cohort:'cohort',context_value:'conversion_status'}},
  followup_recheck:{id:'followup_recheck',primary:'sessions',related:'releases',join:['case_key','release_id'],requiredFilters:['flow_key','release_id','affected_cohort','control_cohort'],allowedFilters:['flow_key','release_id','affected_cohort','control_cohort'],primaryOutput:{session_id:'session_id',cohort:'cohort',context_value:'conversion_status'}},
};

const REQUEST_KEYS=['protocol','template','workspace_id','case_id','revision_id','metric_hash','comparison_hash','view_ids','filters','caps'] as const;
const FILTER_KEYS=['from','to','case_key','flow_key','release_id','affected_cohort','control_cohort'] as const;
const CAP_KEYS=['page_size','max_pages','max_rows','max_page_bytes','max_total_bytes'] as const;
const PAGE_KEYS=['page_id','requested_cursor','next_cursor','terminal','rows','raw_bytes','observed_at','request_id','metadata'] as const;
/** Exact positional projection used by the reviewed REST row-array contract. */
export const ZETARIS_PROJECTION_COLUMNS=Object.freeze(['signal_id','occurred_at','release_id','session_id','cohort','symptom_ref','summary','context_value','primary_record_id','related_record_id'] as const);
const ROW_KEYS=ZETARIS_PROJECTION_COLUMNS;

function exactKeys(value:unknown,allowed:readonly string[],code='INVALID_ZETARIS_REQUEST'):asserts value is Record<string,unknown>{
  requireWire(value!==null&&typeof value==='object'&&!Array.isArray(value),code,'Zetaris value must be an object.');
  const keys=Object.keys(value);requireWire(keys.every(key=>allowed.includes(key)&&!['__proto__','prototype','constructor'].includes(key))&&new Set(keys).size===keys.length,code,'Zetaris value contains unsupported fields.');
}
function bounded(value:unknown,name:string,max=200):string{requireWire(typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value),'INVALID_ZETARIS_REQUEST',`${name} is absent or invalid.`);return value;}
function hashValue(value:unknown,name:string):string{const result=bounded(value,name,64);requireWire(/^[a-f0-9]{64}$/.test(result),'INVALID_ZETARIS_REQUEST',`${name} must be a lowercase SHA-256 digest.`);return result;}
function timestamp(value:unknown,name:string):string{const result=bounded(value,name,40),millis=Date.parse(result);requireWire(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result)&&Number.isFinite(millis),'INVALID_ZETARIS_REQUEST',`${name} must be a finite UTC timestamp.`);return new Date(millis).toISOString();}
function integer(value:unknown,name:string,min:number,max:number):number{requireWire(typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max,'INVALID_ZETARIS_REQUEST',`${name} is outside the supported bound.`);return value;}
function quoteIdentifier(value:string):string{requireWire(value.length<=255&&value.split('.').length<=4&&value.split('.').every(part=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)),'INVALID_ZETARIS_CONFIGURATION','An approved provider identifier is invalid.');return value.split('.').map(part=>`"${part}"`).join('.');}
function literal(value:string):string{requireWire(value.length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),'INVALID_ZETARIS_REQUEST','A query value is outside the literal encoder profile.');return `'${value.replaceAll("'","''")}'`;}
function nullableString(value:unknown,name:string,max=4000):string|null{if(value===null)return null;requireWire(typeof value==='string'&&value.length<=max&&!/[\u0000\u007f]/.test(value),'INVALID_ZETARIS_SCHEMA',`${name} is outside the normalized provider schema.`);return value;}
function providerTimestamp(value:unknown):string{requireWire(typeof value==='string'&&value.length<=40,'INVALID_ZETARIS_SCHEMA','Provider occurred_at is absent.');const parsed=Date.parse(value);requireWire(Number.isFinite(parsed),'INVALID_ZETARIS_SCHEMA','Provider occurred_at is invalid.');return new Date(parsed).toISOString();}
function errorCode(error:unknown):string{return error instanceof ConnectorError?error.code:error instanceof Error&&error.name==='AbortError'?'ZETARIS_CANCELLED':'ZETARIS_CAPTURE_FAILED';}
function cancelled(error:unknown):boolean{return error instanceof Error&&error.name==='AbortError'||error instanceof ConnectorError&&['ZETARIS_CANCELLED','CAPTURE_CANCELLED'].includes(error.code);}

function assertConfig(config:ZetarisConfig):Map<string,ZetarisApprovedView>{
  bounded(config.workspace_id,'workspace_id');bounded(config.source_id,'source_id');bounded(config.credential,'credential',8192);bounded(config.read_account_scope,'read_account_scope',500);
  requireWire(Array.isArray(config.approved_views)&&config.approved_views.length>0&&config.approved_views.length<=32,'INVALID_ZETARIS_CONFIGURATION','Approved views must be a bounded allowlist.');
  const map=new Map<string,ZetarisApprovedView>();for(const value of config.approved_views){
    exactKeys(value,['id','role','identifier','columns'],'INVALID_ZETARIS_CONFIGURATION');const view=value as unknown as ZetarisApprovedView;
    bounded(view.id,'view_id');requireWire(['sessions','releases','support','changes'].includes(view.role),'INVALID_ZETARIS_CONFIGURATION','Approved view role is unsupported.');quoteIdentifier(view.identifier);
    exactKeys(view.columns,Object.keys({record_id:1,occurred_at:1,release_id:1,session_id:1,cohort:1,case_key:1,flow_key:1,conversion_status:1,symptom_ref:1,summary:1}),'INVALID_ZETARIS_CONFIGURATION');const columns=view.columns as Partial<Record<ZetarisColumn,string>>;for(const column of Object.values(columns)){requireWire(column!==undefined,'INVALID_ZETARIS_CONFIGURATION','Approved column mappings cannot be undefined.');quoteIdentifier(column);}
    requireWire(!map.has(view.id),'INVALID_ZETARIS_CONFIGURATION','Approved view IDs must be unique.');map.set(view.id,view);
  }
  return map;
}

export function validateZetarisRequest(input:ZetarisCaptureRequest,config:ZetarisConfig):ZetarisCaptureRequest{
  exactKeys(input,REQUEST_KEYS);requireWire(input.protocol===ZETARIS_PROTOCOL,'INVALID_ZETARIS_REQUEST','Zetaris protocol version is unsupported.');exactKeys(input.template,['id','version']);requireWire(Object.hasOwn(TEMPLATES,input.template.id)&&input.template.version===1,'INVALID_ZETARIS_REQUEST','Zetaris query template/version is unsupported.');
  requireWire(input.workspace_id===config.workspace_id,'ZETARIS_WORKSPACE_MISMATCH','The capture belongs to another workspace.');bounded(input.case_id,'case_id');bounded(input.revision_id,'revision_id');hashValue(input.metric_hash,'metric_hash');hashValue(input.comparison_hash,'comparison_hash');
  exactKeys(input.view_ids,['sessions','releases','support','changes']);exactKeys(input.filters,FILTER_KEYS);exactKeys(input.caps,CAP_KEYS);
  const from=timestamp(input.filters.from,'from'),to=timestamp(input.filters.to,'to');requireWire(Date.parse(from)<Date.parse(to)&&Date.parse(to)-Date.parse(from)<=366*24*60*60*1000,'INVALID_ZETARIS_REQUEST','The query window must be positive and no longer than one year.');bounded(input.filters.case_key,'case_key',500);
  const template=TEMPLATES[input.template.id];for(const name of template.requiredFilters)bounded(input.filters[name],name,500);for(const name of ['flow_key','release_id','affected_cohort','control_cohort'] as const)if(Object.hasOwn(input.filters,name)){bounded(input.filters[name],name,500);requireWire(template.allowedFilters.includes(name),'INVALID_ZETARIS_REQUEST',`${name} is not accepted by this query template.`);}
  if(input.filters.affected_cohort!==undefined&&input.filters.control_cohort!==undefined)requireWire(input.filters.affected_cohort!==input.filters.control_cohort,'INVALID_ZETARIS_REQUEST','Affected and control cohorts must differ.');
  integer(input.caps.page_size,'page_size',1,100);integer(input.caps.max_pages,'max_pages',1,50);integer(input.caps.max_rows,'max_rows',1,5000);integer(input.caps.max_page_bytes,'max_page_bytes',1,2_000_000);integer(input.caps.max_total_bytes,'max_total_bytes',input.caps.max_page_bytes,50_000_000);
  const views=assertConfig(config);for(const role of [template.primary,template.related]){const id=input.view_ids[role];requireWire(typeof id==='string','INVALID_ZETARIS_REQUEST',`Template requires a ${role} view.`);const view=views.get(id);requireWire(view?.role===role,'ZETARIS_VIEW_UNAUTHORIZED',`The selected ${role} view is not approved for that role.`);}requireWire(Object.keys(input.view_ids).length===2,'INVALID_ZETARIS_REQUEST','Template accepts only its two required views.');
  return input;
}

function column(view:ZetarisApprovedView,key:ZetarisColumn,alias:string):string{const value=view.columns[key];requireWire(value!==undefined,'INVALID_ZETARIS_CONFIGURATION',`Approved ${view.role} view lacks required ${key} mapping.`);return `${alias}.${quoteIdentifier(value)}`;}
function optionalColumn(view:ZetarisApprovedView,key:ZetarisColumn|undefined,alias:string):string{return key?column(view,key,alias):'NULL';}

/** Produces the only SQL shape exposed by the extension; callers cannot supply SQL or identifiers. */
export function compileZetarisQuery(input:ZetarisCaptureRequest,config:ZetarisConfig):{select:string;template_hash:string;query_hash:string;selected_views:Record<string,string>}{
  validateZetarisRequest(input,config);const definition=TEMPLATES[input.template.id],views=assertConfig(config),primary=views.get(input.view_ids[definition.primary]!)!,related=views.get(input.view_ids[definition.related]!)!;
  const p='p',r='r',joinConditions=definition.join.map(key=>`${column(primary,key,p)} = ${column(related,key,r)}`),conditions=[`${column(primary,'occurred_at',p)} >= TIMESTAMP ${literal(timestamp(input.filters.from,'from'))}`,`${column(primary,'occurred_at',p)} < TIMESTAMP ${literal(timestamp(input.filters.to,'to'))}`,`${column(primary,'case_key',p)} = ${literal(input.filters.case_key)}`];
  if(input.filters.flow_key!==undefined)conditions.push(`${column(primary,'flow_key',p)} = ${literal(input.filters.flow_key)}`);
  if(input.filters.release_id!==undefined)conditions.push(`${column(primary,'release_id',p)} = ${literal(input.filters.release_id)}`);
  if(input.filters.affected_cohort!==undefined&&input.filters.control_cohort!==undefined)conditions.push(`${column(primary,'cohort',p)} IN (${literal(input.filters.affected_cohort)}, ${literal(input.filters.control_cohort)})`);
  const signalId=`${literal(definition.id)} || ':' || CAST(${column(primary,'record_id',p)} AS VARCHAR) || ':' || CAST(${column(related,'record_id',r)} AS VARCHAR)`;
  const select=`SELECT ${signalId} AS signal_id, ${column(primary,'occurred_at',p)} AS occurred_at, ${column(primary,'release_id',p)} AS release_id, ${optionalColumn(primary,definition.primaryOutput.session_id,p)} AS session_id, ${optionalColumn(primary,definition.primaryOutput.cohort,p)} AS cohort, ${optionalColumn(primary,definition.primaryOutput.symptom_ref,p)} AS symptom_ref, ${optionalColumn(primary,definition.primaryOutput.summary,p)} AS summary, ${optionalColumn(primary,definition.primaryOutput.context_value,p)} AS context_value, ${column(primary,'record_id',p)} AS primary_record_id, ${column(related,'record_id',r)} AS related_record_id FROM ${quoteIdentifier(primary.identifier)} ${p} INNER JOIN ${quoteIdentifier(related.identifier)} ${r} ON ${joinConditions.join(' AND ')} WHERE ${conditions.join(' AND ')} ORDER BY ${column(primary,'occurred_at',p)} ASC, ${column(primary,'record_id',p)} ASC, ${column(related,'record_id',r)} ASC FETCH FIRST ${input.caps.max_rows+1} ROWS ONLY`;
  const template_hash=hash({protocol:ZETARIS_PROTOCOL,version:1,definition}),selected_views={[definition.primary]:primary.id,[definition.related]:related.id};return {select,template_hash,query_hash:byteHash(Buffer.from(select)),selected_views};
}

function validatePage(page:ZetarisProviderPage,caps:ZetarisCaptureRequest['caps']):void{
  exactKeys(page,PAGE_KEYS,'INVALID_ZETARIS_SCHEMA');bounded(page.page_id,'page_id',500);if(page.requested_cursor!==null)bounded(page.requested_cursor,'requested_cursor',2000);if(page.next_cursor!==null)bounded(page.next_cursor,'next_cursor',2000);requireWire(typeof page.terminal==='boolean'&&Array.isArray(page.rows)&&page.rows.length<=caps.page_size,'INVALID_ZETARIS_SCHEMA','Provider page shape or row count is invalid.');requireWire(Buffer.isBuffer(page.raw_bytes)&&page.raw_bytes.length>0&&page.raw_bytes.length<=caps.max_page_bytes,'ZETARIS_PAGE_BYTE_CAP','Provider page exceeds its byte cap.');providerTimestamp(page.observed_at);if(page.request_id!==null)bounded(page.request_id,'request_id',200);exactKeys(page.metadata,Object.keys(page.metadata),'INVALID_ZETARIS_SCHEMA');for(const [key,value] of Object.entries(page.metadata)){bounded(key,'metadata key',100);requireWire(value===null||typeof value==='string'&&value.length<=1000||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Number.isSafeInteger(value),'INVALID_ZETARIS_SCHEMA','Provider metadata is not a bounded scalar.');}
  requireWire(page.terminal?page.next_cursor===null:page.next_cursor!==null,'INVALID_ZETARIS_SCHEMA','Provider terminal state and next cursor disagree.');
}

function validateSession(value:ZetarisSessionHandle):ZetarisSessionHandle{exactKeys(value,['handle','account_scope','expires_at','provider_version','request_id'],'INVALID_ZETARIS_SCHEMA');bounded(value.handle,'session_handle',2000);bounded(value.account_scope,'account_scope',500);if(value.expires_at!==null){providerTimestamp(value.expires_at);requireWire(Date.parse(value.expires_at)>Date.now(),'ZETARIS_SESSION_EXPIRED','Zetaris returned an expired query session.');}if(value.provider_version!==null)bounded(value.provider_version,'provider_version',200);if(value.request_id!==null)bounded(value.request_id,'request_id',200);return value;}
function validateOpen(value:ZetarisOpenResult):ZetarisOpenResult{exactKeys(value,['query_handle','request_id','page'],'INVALID_ZETARIS_SCHEMA');bounded(value.query_handle,'query_handle',2000);if(value.request_id!==null)bounded(value.request_id,'request_id',200);return value;}
function validateClose(value:ZetarisCloseResult):ZetarisCloseResult{exactKeys(value,['request_id','closed_at'],'INVALID_ZETARIS_SCHEMA');if(value.request_id!==null)bounded(value.request_id,'request_id',200);providerTimestamp(value.closed_at);return value;}

export function normalizeZetarisRow(raw:unknown,request:ZetarisCaptureRequest,primary:ZetarisApprovedView,related:ZetarisApprovedView):ZetarisNormalizedSignal{
  exactKeys(raw,ROW_KEYS,'INVALID_ZETARIS_SCHEMA');requireWire(Object.keys(raw).length===ROW_KEYS.length,'INVALID_ZETARIS_SCHEMA','Provider row omits required projection fields.');const signal_id=bounded(raw.signal_id,'signal_id',1000),occurred_at=providerTimestamp(raw.occurred_at),primary_record_id=bounded(raw.primary_record_id,'primary_record_id',1000),related_record_id=bounded(raw.related_record_id,'related_record_id',1000);
  const base={signal_id,relationship:request.template.id,occurred_at,release_id:nullableString(raw.release_id,'release_id',500),session_id:nullableString(raw.session_id,'session_id',500),cohort:nullableString(raw.cohort,'cohort',500),symptom_ref:nullableString(raw.symptom_ref,'symptom_ref',1000),summary:nullableString(raw.summary,'summary',4000),context_value:nullableString(raw.context_value,'context_value',1000),lineage:[{view_id:primary.id,role:primary.role,record_id:primary_record_id},{view_id:related.id,role:related.role,record_id:related_record_id}] as ZetarisNormalizedSignal['lineage']};return {...base,content_hash:hash(base)};
}

function safeNow():string{return new Date().toISOString();}

export class ZetarisEvidenceClient {
  private readonly views:Map<string,ZetarisApprovedView>;
  constructor(private readonly transport:ZetarisTransport,private readonly config:ZetarisConfig){this.views=assertConfig(config);}

  async capture(request:ZetarisCaptureRequest,control:ExecutionControl={}):Promise<ZetarisCaptureResult>{
    const started_at=safeNow(),compiled=compileZetarisQuery(request,this.config),template=TEMPLATES[request.template.id],primary=this.views.get(request.view_ids[template.primary]!)!,related=this.views.get(request.view_ids[template.related]!)!,input_hash=hash(request);let session:ZetarisSessionHandle|undefined,queryHandle:string|undefined,accountScope:string|null=null,providerVersion:string|null=null,status:ZetarisCaptureStatus='failed',reason:string|null='ZETARIS_CAPTURE_FAILED',observed=0,totalBytes=0;const rows:ZetarisNormalizedSignal[]=[],pages:ZetarisPageLedgerEntry[]=[],pageIds=new Map<string,string>(),bodyHashes=new Set<string>(),requestedCursors=new Set<string>(),rowIdentities=new Map<string,string>();let close:ZetarisCaptureResult['close']={status:'not_attempted',closed_at:null,request_id:null,error_code:null};
    try{
      await checkActive(control);session=validateSession(await this.transport.login({credential:this.config.credential,request_id:randomUUID()},control));requireWire(session.account_scope===this.config.read_account_scope,'ZETARIS_ACCOUNT_SCOPE_MISMATCH','The authenticated read account scope differs from the approved configuration.');accountScope=session.account_scope;providerVersion=session.provider_version;
      await checkActive(control);const opened=validateOpen(await this.transport.open({session_handle:session.handle,request_id:randomUUID(),select:compiled.select,page_limit:request.caps.page_size},control));queryHandle=opened.query_handle;let expectedCursor:string|null=null,current:ZetarisProviderPage=opened.page;
      for(;;){
        await checkActive(control);validatePage(current,request.caps);requireWire(current.requested_cursor===expectedCursor,'ZETARIS_CURSOR_MISMATCH','Provider page does not match the requested cursor.');const bodyHash=byteHash(current.raw_bytes),prior=pageIds.get(current.page_id);if(prior!==undefined)throw new ConnectorError(prior===bodyHash?'ZETARIS_DUPLICATE_PAGE':'ZETARIS_CHANGED_PAGE','Provider repeated or changed a page identity.');requireWire(!bodyHashes.has(bodyHash),'ZETARIS_DUPLICATE_PAGE','Provider repeated page bytes under a different identity.');pageIds.set(current.page_id,bodyHash);bodyHashes.add(bodyHash);totalBytes+=current.raw_bytes.length;requireWire(totalBytes<=request.caps.max_total_bytes,'ZETARIS_TOTAL_BYTE_CAP','Provider capture exceeds its total byte cap.');
        const acceptedBefore=rows.length;for(const raw of current.rows){observed++;if(rows.length>=request.caps.max_rows)continue;const normalized=normalizeZetarisRow(raw,request,primary,related),identity=`${normalized.lineage[0].record_id}\u0000${normalized.lineage[1].record_id}`,previous=rowIdentities.get(identity);if(previous!==undefined){requireWire(previous===normalized.content_hash,'ZETARIS_CHANGED_ROW','Provider changed a repeated row during capture.');continue;}rowIdentities.set(identity,normalized.content_hash);rows.push(normalized);}
        pages.push({index:pages.length,page_id:current.page_id,requested_cursor:current.requested_cursor,next_cursor:current.next_cursor,terminal:current.terminal,row_count:current.rows.length,accepted_row_count:rows.length-acceptedBefore,byte_count:current.raw_bytes.length,body_hash:bodyHash,metadata_hash:hash(current.metadata),observed_at:providerTimestamp(current.observed_at),request_id:current.request_id,raw_bytes:Buffer.from(current.raw_bytes)});
        if(observed>request.caps.max_rows){status='partial';reason='ZETARIS_ROW_CAP';break;}if(current.terminal){status='complete';reason=null;break;}if(pages.length>=request.caps.max_pages){status='partial';reason='ZETARIS_PAGE_CAP';break;}
        const cursor=current.next_cursor!;requireWire(!requestedCursors.has(cursor),'ZETARIS_DUPLICATE_PAGE','Provider repeated a pagination cursor.');requestedCursors.add(cursor);expectedCursor=cursor;await checkActive(control);current=await this.transport.page({session_handle:session.handle,query_handle:queryHandle,request_id:randomUUID(),cursor},control);
      }
    }catch(error){status=cancelled(error)?'cancelled':'failed';reason=errorCode(error);}
    finally{
      if(session&&queryHandle){try{const result=validateClose(await this.transport.close({session_handle:session.handle,query_handle:queryHandle,request_id:randomUUID()}));close={status:'succeeded',closed_at:providerTimestamp(result.closed_at),request_id:result.request_id,error_code:null};}catch(error){close={status:'failed',closed_at:safeNow(),request_id:null,error_code:errorCode(error)};if(status==='complete'){status='failed';reason='ZETARIS_CLOSE_FAILED';}}}
    }
    const ended_at=safeNow(),limitations=['Zetaris rows are supplementary association evidence and never replace canonical conversion counts.','The provider query is not assumed to be a transactionally stable snapshot.'];if(status!=='complete')limitations.push('The provider capture is incomplete or unusable and cannot enter an issued report.');if(close.status!=='succeeded')limitations.push('The provider query close was not confirmed.');const digestValue={protocol:ZETARIS_PROTOCOL,status,reason_code:reason,workspace_id:request.workspace_id,source_id:this.config.source_id,case_id:request.case_id,revision_id:request.revision_id,template_id:request.template.id,template_hash:compiled.template_hash,input_hash,query_hash:compiled.query_hash,rows:rows.map(row=>row.content_hash),pages:pages.map(({raw_bytes,...page})=>page),close,started_at,ended_at};
    return {protocol:ZETARIS_PROTOCOL,adapter_version:ZETARIS_PROTOCOL,status,reason_code:reason,admissible:status==='complete'&&close.status==='succeeded',workspace_id:request.workspace_id,source_id:this.config.source_id,case_id:request.case_id,revision_id:request.revision_id,metric_hash:request.metric_hash,comparison_hash:request.comparison_hash,template_id:request.template.id,template_version:1,template_hash:compiled.template_hash,input_hash,query_hash:compiled.query_hash,selected_views:compiled.selected_views,requested_bounds:{from:timestamp(request.filters.from,'from'),to:timestamp(request.filters.to,'to')},read_account_scope:accountScope,provider_version:providerVersion,started_at,ended_at,rows,observed_row_count:observed,pages,close,limitations,capture_hash:hash(digestValue)};
  }
}

export type ZetarisApi = Pick<ZetarisEvidenceClient,'capture'>;
export function executeZetarisCapture(api:ZetarisApi,request:ZetarisCaptureRequest,control:ExecutionControl={}):Promise<ZetarisCaptureResult>{return api.capture(request,control);}

export const zetarisTemplates=Object.freeze(Object.values(TEMPLATES).map(value=>Object.freeze({...value})));
