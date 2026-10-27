import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../canonical.js';
import {DomainError} from '../errors.js';
import {ConnectorError, type SafeHttp} from '../connectors/wire.js';
import {probeSourceCredential} from '../integrations/service.js';
import {GITHUB_ADAPTER_VERSION, GITHUB_API_VERSION} from '../connectors/github/index.js';
import {type ExportDeclaration} from '../connectors/posthog/index.js';
import {assertReplacementActivation, assertReplacementCurrent, replacementProbeBinding, replacementMetadata, observeReplacementProbe, type ReplacementProbeObservation} from './replacements.js';
import {randomBytes} from 'node:crypto';
import {seal, open} from './keyring.js';

// replacements
const binding={kind:'source',id:'source-id',revision:4,config:{kind:'github_changes',api_origin:'https://api.github.com',owner:'synthetic-owner',repo:'synthetic-repo'},config_hash:'a'.repeat(64),repository_id:42,declaration:null,adapter_version:GITHUB_ADAPTER_VERSION};
const observation:ReplacementProbeObservation={repository_id:42,capabilities:{schema_version:1,source_kind:'github_changes',status:'available',checked_at:'2026-10-14T12:00:00.000Z',adapter_version:GITHUB_ADAPTER_VERSION,read_only:true,features:['selected_repository_metadata','immutable_commit_resolution','release_metadata','pull_request_metadata'],unsupported_features:['repository_writes'],reason_code:null,provider_version:GITHUB_API_VERSION}};
const clock=Date.parse('2026-10-14T12:01:00.000Z');
function ready(){
 const secret={id:'secret-id',active_version:1,revision:3,revoked:false},row={id:'replacement-id',secret_id:secret.id,version:2,base_secret_revision:3,resource_kind:'source',resource_id:'source-id',resource_revision:4,resource_binding:binding,resource_binding_hash:hash(binding),status:'probed',revision:3,capabilities:observation,probe_binding_hash:'',probe_expires_at:'2026-10-14T12:10:00.000Z'};
 row.probe_binding_hash=replacementProbeBinding(row,observation);return {secret,row};
}
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;
test("credential activation requires a current exact reviewed successful probe", () => {
 // only an available finite protocol observation with exact reviewed binding may activate
 {
  const {secret,row}=ready();assert.doesNotThrow(()=>assertReplacementActivation(row,secret,binding,row.probe_binding_hash,clock));
    assert.equal(secret.active_version,1); // Guard alone cannot switch the previous active credential.
    assert.throws(()=>assertReplacementActivation(row,secret,binding,'different-reviewed-binding',clock),code('REPLACEMENT_REVIEW_REQUIRED'));
 }
 // stage/config revision, export declaration and active secret changes invalidate a candidate
 {
  const {secret,row}=ready();
    for(const current of [{...binding,revision:5},{...binding,config:{...binding.config,repo:'different-repo'}},{...binding,declaration:{id:'other-declaration',hash:'b'.repeat(64),run_id:'another-run'}}])assert.throws(()=>assertReplacementCurrent(row,secret,current),code('STALE_SECRET_REPLACEMENT'));
    assert.throws(()=>assertReplacementCurrent(row,{...secret,revision:4},binding),code('STALE_SECRET_REPLACEMENT'));
    assert.equal(secret.active_version,1);
 }
 // revoked, failed, staged, probing and expired candidates cannot activate
 {
  const {secret,row}=ready();
    assert.throws(()=>assertReplacementActivation(row,{...secret,revoked:true},binding,row.probe_binding_hash,clock),code('SECRET_UNAVAILABLE'));
    for(const status of ['staged','probing','failed','activated'])assert.throws(()=>assertReplacementActivation({...row,status},secret,binding,row.probe_binding_hash,clock),code('REPLACEMENT_PROBE_REQUIRED'));
    assert.throws(()=>assertReplacementActivation(row,secret,binding,row.probe_binding_hash,Date.parse(row.probe_expires_at)),code('REPLACEMENT_PROBE_REQUIRED'));
    assert.equal(secret.active_version,1);
 }
 // altered candidate version or probe observation invalidates previous review
 {
  const {secret,row}=ready();
    assert.throws(()=>assertReplacementActivation({...row,version:3},secret,binding,row.probe_binding_hash,clock),code('REPLACEMENT_REVIEW_REQUIRED'));
    assert.throws(()=>assertReplacementActivation({...row,capabilities:{...observation,repository_id:99}},secret,binding,row.probe_binding_hash,clock),code('REPLACEMENT_REVIEW_REQUIRED'));
 }
});

test('masked replacement projection excludes ciphertext, token, headers, nonce and raw provider text',()=>{
 const {secret,row}=ready(),dto=replacementMetadata({...row,ciphertext:'private-candidate',value:'candidate-value',probe_nonce:'private-fence',Authorization:'Bearer candidate-value'},secret),serialized=JSON.stringify(dto);
 for(const privateValue of ['private-candidate','candidate-value','private-fence','Authorization','ciphertext','probe_nonce'])assert.ok(!serialized.includes(privateValue));
 assert.equal(dto.active_version,1);assert.equal(dto.capabilities?.status,'available');assert.equal(dto.secret_revision,3);
});
test("revocation and malformed adapter claims cannot publish credential availability", async () => {
 // demotion or stale fencing after an observed successful protocol denies publication
 {
  let checks=0;
    await assert.rejects(()=>observeReplacementProbe(async()=>observation,{assertActive:async()=>{if(++checks===2)throw new DomainError('FORBIDDEN','Current owner authority was removed.',403);}}),code('FORBIDDEN'));
    assert.equal(checks,2);
    const controller=new AbortController();controller.abort();let called=false;
    await assert.rejects(()=>observeReplacementProbe(async()=>{called=true;return observation;},{signal:controller.signal}));assert.equal(called,false);
 }
 // caller success booleans and malformed adapter facts never establish availability
 {
  await assert.rejects(()=>observeReplacementProbe(async()=>({passed:true,repository_id:null} as unknown as ReplacementProbeObservation),{}));
    const {secret,row}=ready(),failed={...observation,capabilities:{...observation.capabilities,status:'unauthorized' as const,reason_code:'PROVIDER_UNAUTHORIZED'}};
    assert.throws(()=>assertReplacementActivation({...row,capabilities:failed},secret,binding,row.probe_binding_hash,clock),code('REPLACEMENT_PROBE_REQUIRED'));
 }
});

test("GitHub credential probes require exact repository and finite read permissions", async () => {
 // injected GitHub read-only protocol validates repository, commit and finite read permissions
 {
  const urls:string[]=[],http:SafeHttp={get:async(url,options)=>{
     urls.push(url);assert.equal(options?.headers?.Authorization,'Bearer generated-synthetic-candidate');
     assert.deepEqual(options?.allowedOrigins,['https://api.github.com']);
     const value=url.endsWith('/commits/main')?{sha:'a'.repeat(40)}:url.includes('/releases?')||url.includes('/pulls?')?[]:{id:42,full_name:'synthetic-owner/synthetic-repo',default_branch:'main'};
     return {status:200,headers:{},body:Buffer.from(JSON.stringify(value))};
    }};
    const result=await probeSourceCredential({id:'source-id',workspace_id:'workspace-id',kind:'github_changes',config:binding.config,repository_id:42},'generated-synthetic-candidate',{},undefined,http);
    assert.equal(result.capabilities.status,'available');assert.equal(result.repository_id,42);assert.equal(urls.length,5);
    assert.ok(urls.every(url=>url.startsWith('https://api.github.com/repos/synthetic-owner/synthetic-repo')));
 }
 // GitHub HTTP unauthorized and repository mismatch are failed capabilities, not PASS
 {
  const row={id:'source-id',workspace_id:'workspace-id',kind:'github_changes',config:binding.config,repository_id:42};
    for(const http of [{get:async()=>({status:401,headers:{},body:Buffer.from('{}')})},{get:async()=>({status:200,headers:{},body:Buffer.from(JSON.stringify({id:43,full_name:'synthetic-owner/synthetic-repo'}))})}]){
     const result=await probeSourceCredential(row,'generated-synthetic-candidate',{},undefined,http);assert.notEqual(result.capabilities.status,'available');
    }
 }
});

test('PostHog candidate probe reads only the frozen existing completed manifest',async()=>{
 const run='11111111-1111-4111-8111-111111111111',declaration:ExportDeclaration={run_id:run,project_id:1,model:'events',data_interval_start:'2026-10-01T00:00:00.000Z',data_interval_end:'2026-10-02T00:00:00.000Z',file:{format:'JSONLines',compression:null},declared_by:'synthetic-owner',declared_at:'2026-10-03T00:00:00.000Z',artifact_hash:'a'.repeat(64),provenance:'owner_declared'},urls:string[]=[];
 const row={id:'source-id',workspace_id:'workspace-id',kind:'posthog_existing_file_export',config:{kind:'posthog_existing_file_export',app_host:'https://us.posthog.com',project_id:'1'},repository_id:null};
 const http:SafeHttp={get:async(url)=>{urls.push(url);return {status:200,headers:{},body:Buffer.from(JSON.stringify({status:'Completed',files:[],records_completed:0}))};}};
 const result=await probeSourceCredential(row,'generated-synthetic-candidate',{},declaration,http);assert.equal(result.capabilities.status,'available');
 assert.deepEqual(urls,[`https://us.posthog.com/api/projects/1/file_download_batch_exports/${run}/`]);
 await assert.rejects(()=>probeSourceCredential(row,'generated-synthetic-candidate',{},undefined,http),code('EXPORT_DECLARATION_REQUIRED'));
 assert.equal(urls.length,1);
});
test('operator-disallowed origins are rejected before an injected request can run',async()=>{
 let called=false;const http:SafeHttp={get:async()=>{called=true;throw new ConnectorError('PROVIDER_UNAVAILABLE','Synthetic');}};
 await assert.rejects(()=>probeSourceCredential({id:'source-id',kind:'posthog_existing_file_export',config:{kind:'posthog_existing_file_export',app_host:'https://different.example',project_id:'1'},repository_id:null},'generated-synthetic-candidate',{},undefined,http));assert.equal(called,false);
});

// keyring
const keyring={active:'v1',keys:{v1:randomBytes(32).toString('base64')}};
test("authenticated encryption binds workspace and purpose and rejects altered or unavailable keys", () => {
 // authenticated encryption preserves private bytes and binds workspace/purpose
 {
  const sealed=seal('private credential','workspace-a:source',keyring);assert.equal(open(sealed,'workspace-a:source',keyring),'private credential');assert.ok(!sealed.includes('private credential'));assert.throws(()=>open(sealed,'workspace-b:source',keyring));
 }
 // tampered ciphertext and missing key cannot decrypt
 {
  const sealed=JSON.parse(seal('secret','scope',keyring));sealed.ciphertext=Buffer.from('tampered').toString('base64');assert.throws(()=>open(JSON.stringify(sealed),'scope',keyring));assert.throws(()=>open(seal('secret','scope',keyring),'scope',{active:'v2',keys:{}}));
 }
});
