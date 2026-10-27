import {hash} from '../canonical.js';
import {
  executeZetarisCapture,
  validateZetarisRequest,
  ZETARIS_PROTOCOL,
  type ZetarisApi,
  type ZetarisApprovedView,
  type ZetarisCaptureRequest,
  type ZetarisCaptureResult,
  type ZetarisPageLedgerEntry,
  type ZetarisTemplateId,
  type ZetarisViewRole,
} from '../connectors/zetaris/index.js';
import {checkActive,ConnectorError,providerOrigin,containsProviderSecret,type ExecutionControl} from '../connectors/wire.js';

const DIGEST=/^[a-f0-9]{64}$/;
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const VIEW_ROLES:readonly ZetarisViewRole[]=['sessions','releases','support','changes'];
const TEMPLATE_IDS:readonly ZetarisTemplateId[]=['release_exposure','support_symptoms','change_timeline','cohort_context','contrary_evidence','followup_recheck'];

function exact(value:unknown,keys:readonly string[],code='INVALID_ZETARIS_RUNTIME_CONFIG'):asserts value is Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new ConnectorError(code,'Zetaris runtime input must be an object.');
  const actual=Object.keys(value);
  if(actual.some(key=>!keys.includes(key)||['__proto__','prototype','constructor'].includes(key))||new Set(actual).size!==actual.length)throw new ConnectorError(code,'Zetaris runtime input contains unsupported fields.');
}
function text(value:unknown,name:string,max=500,code='INVALID_ZETARIS_RUNTIME_CONFIG'):string{
  if(typeof value!=='string'||value.length<1||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new ConnectorError(code,`${name} is absent or invalid.`);
  return value;
}
function digest(value:unknown,name:string,code='INVALID_ZETARIS_RUNTIME_CONFIG'):string{
  const result=text(value,name,64,code);if(!DIGEST.test(result))throw new ConnectorError(code,`${name} must be a lowercase SHA-256 digest.`);return result;
}
function timestamp(value:unknown,name:string,code='INVALID_ZETARIS_CAPTURE_INPUT'):string{
  const result=text(value,name,40,code),parsed=Date.parse(result);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result)||!Number.isFinite(parsed))throw new ConnectorError(code,`${name} must be a UTC timestamp.`);return new Date(parsed).toISOString();
}
function safeId(value:unknown,name:string,code='INVALID_ZETARIS_RUNTIME_CONFIG'):string{
  const result=text(value,name,128,code);if(!SAFE_ID.test(result))throw new ConnectorError(code,`${name} is invalid.`);return result;
}
function finiteInteger(value:unknown,name:string,min:number,max:number):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new ConnectorError('INVALID_ZETARIS_CAPTURE_INPUT',`${name} is outside the supported bound.`);return value;
}

export interface ZetarisRuntimeSourceConfig {
  schema_version:1;
  protocol:typeof ZETARIS_PROTOCOL;
  adapter_id:string;
  workspace_id:string;
  source_id:string;
  approved_origin:string;
  contract_hash:string;
  approved_account_scope:string;
  approved_views:readonly ZetarisApprovedView[];
  approved_view_ids:readonly string[];
}

export interface ZetarisCurrentCaseInput {
  workspace_id:string;
  case_id:string;
  revision_id:string;
  metric_hash:string;
  comparison_hash:string;
  template_id:ZetarisTemplateId;
  view_ids:Partial<Record<ZetarisViewRole,string>>;
  from:string;
  to:string;
  case_key:string;
  flow_key?:string;
  release_id?:string;
  affected_cohort?:string;
  control_cohort?:string;
  caps?:Partial<ZetarisCaptureRequest['caps']>;
}

export interface ZetarisRuntimeProbe {
  status:'available'|'unauthorized'|'unavailable'|'unsupported';
  checked_at:string;
  provider_version:string|null;
  observed_account_scope:string|null;
  reason_code:string|null;
  read_only:true;
}

export interface ZetarisRuntimeAdapterFactory {
  adapter_id:string;
  approved_origin:string;
  contract_hash:string;
  probe(input:{credential:string;approved_origin:string;approved_account_scope:string;contract_hash:string},control?:ExecutionControl):Promise<ZetarisRuntimeProbe>;
  createApi(input:{credential:string;approved_origin:string;approved_account_scope:string;contract_hash:string;source:ZetarisRuntimeSourceConfig},control?:ExecutionControl):Promise<ZetarisApi>|ZetarisApi;
}

export type ZetarisPublicPage=Omit<ZetarisPageLedgerEntry,'raw_bytes'>;
export type ZetarisPublicCaptureResult=Omit<ZetarisCaptureResult,'pages'>&{pages:ZetarisPublicPage[]};
export interface ZetarisProtectedRawPage {
  index:number;
  page_id:string;
  body_hash:string;
  byte_count:number;
  raw_bytes:Buffer;
}
export interface ZetarisFederatedEvidenceDraft {
  schema_version:1;
  workspace_id:string;
  case_id:string;
  revision_id:string;
  snapshot_id:null;
  source_kind:'federated_query';
  source_ref:string;
  content_hash:string;
  event_time:{kind:'exact';at:string};
  captured_at:string;
  text:string;
  redaction_status:'restricted';
  evidence_status:'observed';
  supersedes_id:null;
  artifact_refs:[];
}
export interface ZetarisCapturedOutcome {
  runtime_status:'captured';
  reason_code:null;
  request:ZetarisCaptureRequest;
  public_result:ZetarisPublicCaptureResult;
  raw_pages:ZetarisProtectedRawPage[];
  evidence_drafts:ZetarisFederatedEvidenceDraft[];
}
export interface ZetarisBlockedOutcome {
  runtime_status:'blocked';
  reason_code:'ZETARIS_ADAPTER_NOT_REGISTERED';
  request:ZetarisCaptureRequest;
  public_result:null;
  raw_pages:[];
  evidence_drafts:[];
}
export type ZetarisRuntimeCaptureOutcome=ZetarisCapturedOutcome|ZetarisBlockedOutcome;
export type ZetarisRuntimeProbeOutcome=
  | {runtime_status:'probed';reason_code:null;probe:ZetarisRuntimeProbe}
  | {runtime_status:'blocked';reason_code:'ZETARIS_ADAPTER_NOT_REGISTERED';probe:null};

function validateView(view:unknown):ZetarisApprovedView{
  exact(view,['id','role','identifier','columns']);
  const candidate=view as unknown as ZetarisApprovedView;
  safeId(candidate.id,'approved view id');
  if(!VIEW_ROLES.includes(candidate.role))throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','Approved view role is unsupported.');
  text(candidate.identifier,'approved view identifier',255);
  exact(candidate.columns,['record_id','occurred_at','release_id','session_id','cohort','case_key','flow_key','conversion_status','symptom_ref','summary']);
  for(const [name,value] of Object.entries(candidate.columns))text(value,`approved ${name} column`,255);
  return candidate;
}

/** Validates the persisted, secret-free binding to one inspected Zetaris contract. */
export function validateZetarisRuntimeSourceConfig(input:unknown):ZetarisRuntimeSourceConfig{
  exact(input,['schema_version','protocol','adapter_id','workspace_id','source_id','approved_origin','contract_hash','approved_account_scope','approved_views','approved_view_ids']);
  const value=input as unknown as ZetarisRuntimeSourceConfig;
  if(value.schema_version!==1||value.protocol!==ZETARIS_PROTOCOL)throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','Zetaris runtime protocol is unsupported.');
  safeId(value.adapter_id,'adapter_id');safeId(value.workspace_id,'workspace_id');safeId(value.source_id,'source_id');
  const origin=providerOrigin(text(value.approved_origin,'approved_origin',1000));
  if(origin!==value.approved_origin)throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','approved_origin must be the exact HTTPS origin.');
  digest(value.contract_hash,'contract_hash');text(value.approved_account_scope,'approved_account_scope',500);
  if(!Array.isArray(value.approved_views)||value.approved_views.length<1||value.approved_views.length>32)throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','approved_views must be a bounded allowlist.');
  const views=value.approved_views.map(validateView),ids=views.map(view=>view.id);
  if(new Set(ids).size!==ids.length)throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','Approved view IDs must be unique.');
  if(!Array.isArray(value.approved_view_ids)||value.approved_view_ids.length!==ids.length||value.approved_view_ids.some(id=>typeof id!=='string')||new Set(value.approved_view_ids).size!==value.approved_view_ids.length||[...ids].sort().some((id,index)=>id!==[...value.approved_view_ids].sort()[index]))throw new ConnectorError('INVALID_ZETARIS_RUNTIME_CONFIG','approved_view_ids must exactly bind the approved view definitions.');
  return {...value,approved_views:views,approved_view_ids:[...value.approved_view_ids]};
}

/** Builds the finite connector request from current immutable case inputs; no SQL is accepted. */
export function buildZetarisCaptureRequest(source:ZetarisRuntimeSourceConfig,input:ZetarisCurrentCaseInput):ZetarisCaptureRequest{
  const config=validateZetarisRuntimeSourceConfig(source);
  exact(input,['workspace_id','case_id','revision_id','metric_hash','comparison_hash','template_id','view_ids','from','to','case_key','flow_key','release_id','affected_cohort','control_cohort','caps'],'INVALID_ZETARIS_CAPTURE_INPUT');
  if(input.workspace_id!==config.workspace_id)throw new ConnectorError('ZETARIS_WORKSPACE_MISMATCH','The current case belongs to another workspace.');
  safeId(input.case_id,'case_id','INVALID_ZETARIS_CAPTURE_INPUT');safeId(input.revision_id,'revision_id','INVALID_ZETARIS_CAPTURE_INPUT');digest(input.metric_hash,'metric_hash','INVALID_ZETARIS_CAPTURE_INPUT');digest(input.comparison_hash,'comparison_hash','INVALID_ZETARIS_CAPTURE_INPUT');
  if(!TEMPLATE_IDS.includes(input.template_id))throw new ConnectorError('INVALID_ZETARIS_CAPTURE_INPUT','Zetaris template is unsupported.');
  exact(input.view_ids,['sessions','releases','support','changes'],'INVALID_ZETARIS_CAPTURE_INPUT');
  for(const id of Object.values(input.view_ids)){if(typeof id!=='string'||!config.approved_view_ids.includes(id))throw new ConnectorError('ZETARIS_VIEW_UNAUTHORIZED','The current case selected an unapproved view.');}
  const filters:ZetarisCaptureRequest['filters']={from:timestamp(input.from,'from'),to:timestamp(input.to,'to'),case_key:text(input.case_key,'case_key',500,'INVALID_ZETARIS_CAPTURE_INPUT')};
  for(const name of ['flow_key','release_id','affected_cohort','control_cohort'] as const)if(input[name]!==undefined)filters[name]=text(input[name],name,500,'INVALID_ZETARIS_CAPTURE_INPUT');
  const supplied=input.caps??{};exact(supplied,['page_size','max_pages','max_rows','max_page_bytes','max_total_bytes'],'INVALID_ZETARIS_CAPTURE_INPUT');
  const caps={page_size:finiteInteger(supplied.page_size??100,'page_size',1,100),max_pages:finiteInteger(supplied.max_pages??10,'max_pages',1,50),max_rows:finiteInteger(supplied.max_rows??1000,'max_rows',1,5000),max_page_bytes:finiteInteger(supplied.max_page_bytes??1_000_000,'max_page_bytes',1,2_000_000),max_total_bytes:finiteInteger(supplied.max_total_bytes??10_000_000,'max_total_bytes',1,50_000_000)};
  if(caps.max_total_bytes<caps.max_page_bytes)throw new ConnectorError('INVALID_ZETARIS_CAPTURE_INPUT','max_total_bytes must cover at least one page.');
  const request:ZetarisCaptureRequest={protocol:ZETARIS_PROTOCOL,template:{id:input.template_id,version:1},workspace_id:config.workspace_id,case_id:input.case_id,revision_id:input.revision_id,metric_hash:input.metric_hash,comparison_hash:input.comparison_hash,view_ids:{...input.view_ids},filters,caps};
  return validateZetarisRequest(request,{workspace_id:config.workspace_id,source_id:config.source_id,credential:'runtime-bound',read_account_scope:config.approved_account_scope,approved_views:config.approved_views});
}

function exactMicros(value:string):string{return new Date(value).toISOString().replace(/\.(\d{3})Z$/,'.$1000Z');}
function clean(value:string|null):string|null{return value===null?null:value.replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,1000);}
function evidenceText(row:ZetarisCaptureResult['rows'][number]):string{
  const details=[row.release_id&&`release ${clean(row.release_id)}`,row.cohort&&`cohort ${clean(row.cohort)}`,row.symptom_ref&&`symptom ${clean(row.symptom_ref)}`,row.context_value&&`context ${clean(row.context_value)}`,row.summary&&`provider summary [untrusted]: ${clean(row.summary)}`].filter(Boolean);
  return `Zetaris ${row.relationship.replaceAll('_',' ')} signal observed${details.length?`: ${details.join('; ')}`:'.'} This supplementary association evidence does not establish aggregate causation.`.slice(0,8000);
}
function splitResult(result:ZetarisCaptureResult):{public_result:ZetarisPublicCaptureResult;raw_pages:ZetarisProtectedRawPage[]}{
  const raw_pages=result.pages.map(page=>({index:page.index,page_id:page.page_id,body_hash:page.body_hash,byte_count:page.byte_count,raw_bytes:Buffer.from(page.raw_bytes)}));
  const pages=result.pages.map(({raw_bytes:_,...page})=>page);
  return {public_result:{...result,pages},raw_pages};
}
function admissibleSignal(row:ZetarisCaptureResult['rows'][number],result:ZetarisCaptureResult):boolean{
  if(row.relationship!==result.template_id||typeof row.signal_id!=='string'||row.signal_id.length<1||row.signal_id.length>1000||!DIGEST.test(row.content_hash)||!Number.isFinite(Date.parse(row.occurred_at))||!Array.isArray(row.lineage)||row.lineage.length!==2)return false;
  if(!row.lineage.every(item=>VIEW_ROLES.includes(item.role)&&Object.values(result.selected_views).includes(item.view_id)&&typeof item.record_id==='string'&&item.record_id.length>0&&item.record_id.length<=1000))return false;
  for(const value of [row.release_id,row.session_id,row.cohort,row.symptom_ref,row.summary,row.context_value])if(value!==null&&(typeof value!=='string'||value.length>4000||/[\u0000\u007f]/.test(value)))return false;
  const {content_hash,...base}=row;return hash(base)===content_hash;
}
function evidenceDrafts(result:ZetarisCaptureResult):ZetarisFederatedEvidenceDraft[]{
  if(result.status!=='complete'||!result.admissible)return [];
  return result.rows.slice(0,5000).map(row=>{
    const source_ref=`zetaris:${result.source_id}:${result.capture_hash}:${row.signal_id}`.slice(0,1000),textValue=evidenceText(row);
    return {schema_version:1,workspace_id:result.workspace_id,case_id:result.case_id,revision_id:result.revision_id,snapshot_id:null,source_kind:'federated_query',source_ref,content_hash:hash({capture_hash:result.capture_hash,row_hash:row.content_hash,source_ref,text:textValue}),event_time:{kind:'exact',at:exactMicros(row.occurred_at)},captured_at:result.ended_at,text:textValue,redaction_status:'restricted',evidence_status:'observed',supersedes_id:null,artifact_refs:[]};
  });
}

/** Registry key is the immutable adapter/origin/contract tuple, never an inferred endpoint. */
export class ZetarisRuntimeRegistry {
  private readonly factories=new Map<string,ZetarisRuntimeAdapterFactory>();
  private key(value:Pick<ZetarisRuntimeAdapterFactory,'adapter_id'|'approved_origin'|'contract_hash'>):string{return `${value.adapter_id}\u0000${value.approved_origin}\u0000${value.contract_hash}`;}
  register(factory:ZetarisRuntimeAdapterFactory):void{
    safeId(factory.adapter_id,'adapter_id');const origin=providerOrigin(factory.approved_origin);if(origin!==factory.approved_origin)throw new ConnectorError('INVALID_ZETARIS_RUNTIME_ADAPTER','Adapter origin must be the exact HTTPS origin.');digest(factory.contract_hash,'contract_hash','INVALID_ZETARIS_RUNTIME_ADAPTER');
    const key=this.key(factory);if(this.factories.has(key))throw new ConnectorError('ZETARIS_ADAPTER_ALREADY_REGISTERED','A runtime adapter already owns this immutable contract.');this.factories.set(key,factory);
  }
  private resolve(source:ZetarisRuntimeSourceConfig):ZetarisRuntimeAdapterFactory|undefined{return this.factories.get(this.key(source));}
  async probe(sourceInput:ZetarisRuntimeSourceConfig,credential:string,control:ExecutionControl={}):Promise<ZetarisRuntimeProbeOutcome>{
    const source=validateZetarisRuntimeSourceConfig(sourceInput),factory=this.resolve(source);if(!factory)return {runtime_status:'blocked',reason_code:'ZETARIS_ADAPTER_NOT_REGISTERED',probe:null};
    text(credential,'credential',8192,'INVALID_ZETARIS_CREDENTIAL');await checkActive(control);const probe=await factory.probe({credential,approved_origin:source.approved_origin,approved_account_scope:source.approved_account_scope,contract_hash:source.contract_hash},control);await checkActive(control);
    exact(probe,['status','checked_at','provider_version','observed_account_scope','reason_code','read_only'],'INVALID_ZETARIS_PROBE');
    if(!['available','unauthorized','unavailable','unsupported'].includes(probe.status)||probe.read_only!==true||!Number.isFinite(Date.parse(probe.checked_at))||probe.provider_version!==null&&typeof probe.provider_version!=='string'||probe.observed_account_scope!==null&&typeof probe.observed_account_scope!=='string'||probe.reason_code!==null&&typeof probe.reason_code!=='string')throw new ConnectorError('INVALID_ZETARIS_PROBE','Runtime adapter returned an invalid capability probe.');
    if(probe.status==='available'&&probe.observed_account_scope!==source.approved_account_scope&&!(probe.observed_account_scope===null&&probe.reason_code==='ZETARIS_ACCOUNT_SCOPE_NOT_ATTESTED'))throw new ConnectorError('ZETARIS_ACCOUNT_SCOPE_MISMATCH','The runtime probe observed a different account scope or omitted its explicit attestation limitation.');
    if(containsProviderSecret(probe,credential))throw new ConnectorError('PROVIDER_SECRET_REFLECTION','Zetaris reflected its credential into public probe data.');
    return {runtime_status:'probed',reason_code:null,probe};
  }
  async capture(sourceInput:ZetarisRuntimeSourceConfig,input:ZetarisCurrentCaseInput,credential:string,control:ExecutionControl={}):Promise<ZetarisRuntimeCaptureOutcome>{
    const source=validateZetarisRuntimeSourceConfig(sourceInput),request=buildZetarisCaptureRequest(source,input),factory=this.resolve(source);if(!factory)return {runtime_status:'blocked',reason_code:'ZETARIS_ADAPTER_NOT_REGISTERED',request,public_result:null,raw_pages:[],evidence_drafts:[]};
    text(credential,'credential',8192,'INVALID_ZETARIS_CREDENTIAL');await checkActive(control);const api=await factory.createApi({credential,approved_origin:source.approved_origin,approved_account_scope:source.approved_account_scope,contract_hash:source.contract_hash,source},control),result=await executeZetarisCapture(api,request,control);await checkActive(control);
    if(result.workspace_id!==source.workspace_id||result.source_id!==source.source_id||result.case_id!==request.case_id||result.revision_id!==request.revision_id||result.metric_hash!==request.metric_hash||result.comparison_hash!==request.comparison_hash)throw new ConnectorError('ZETARIS_RESULT_BINDING_MISMATCH','Runtime capture result does not match the immutable request.');
    if(result.status==='complete'&&result.admissible&&(result.rows.length!==result.observed_row_count||result.rows.length>request.caps.max_rows||!result.rows.every(row=>admissibleSignal(row,result))))throw new ConnectorError('ZETARIS_CAPTURE_INVALID','A complete capture contained an invalid or uncounted signal; no evidence was admitted.');
    const {public_result,raw_pages}=splitResult(result);
    if(containsProviderSecret(public_result,credential))throw new ConnectorError('PROVIDER_SECRET_REFLECTION','Zetaris reflected its credential into public capture data.');
    return {runtime_status:'captured',reason_code:null,request,public_result,raw_pages,evidence_drafts:evidenceDrafts(result)};
  }
}

/** Process-local registry populated only by reviewed deployment adapters. */
export const zetarisRuntimeRegistry=new ZetarisRuntimeRegistry();
