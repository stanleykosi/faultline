import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, createHmac} from 'node:crypto';
import {type FaultlineBuildAttestation, type FaultlineObservationProfile} from '../../../contracts/src/generated.js';
import {DomainError} from '../errors.js';
import {attestationSigningBytes, compileObservationProfile, deploymentObservationSigningBytes, readReceipt, receiptPath, verifyBuildAttestation, verifyInitialBuildAttestation, type BuildAttestationUnsigned, type DeploymentObservation, type ExpectedBuildBinding, type OperatorTrustMaterial} from './validation.js';
import {validateOperatorRegistration, stagingOrigin} from './operator-profile.js';
import {canonical} from '../canonical.js';
import {cancelRunnerTask, requestRunnerProbe, requestRunnerTask, requestRunnerTaskStatus} from './runner-client.js';
import {projectRunnerCapabilities} from './service.js';

// validation
{
 const scope = {workspace_id: 'workspace-unit', case_id: 'case-unit', revision_id: 'revision-unit'};
 const sha = (text: string) => createHash('sha256').update(text).digest('hex');
 const code = (wanted: string) => (error: unknown) => error instanceof DomainError && error.code === wanted;
 // These literal key orders are independently declared canonical signing/hash expectations.
 function profile(overrides: Partial<FaultlineObservationProfile> = {}): FaultlineObservationProfile {
  const value: FaultlineObservationProfile = {schema_version: 1, id: 'profile-unit', ...scope, template: 'checkout_receipt_v1', success_locator: {kind: 'test_id', value: 'checkout-status'}, receipt: {path_template: '/receipts/{attempt_id}', method: 'GET', credential_ref: null, completed_pointer: '/payload/completed', order_count_pointer: '/payload/order_count', error_code_pointer: '/payload/error_code', max_response_bytes: 4096}, incident_error_code: 'CHECKOUT_FAILURE', symptom_evidence_ids: ['evidence-unit'], sandbox_only: true, created_at: '2026-10-13T00:00:00.000Z', reviewed_by: 'operator-unit', profile_hash: '0'.repeat(64), ...overrides};
  const receipt = value.receipt, locator = value.success_locator;
  value.profile_hash = sha(JSON.stringify({case_id: value.case_id, created_at: value.created_at, id: value.id, incident_error_code: value.incident_error_code, receipt: {completed_pointer: receipt.completed_pointer, credential_ref: receipt.credential_ref, error_code_pointer: receipt.error_code_pointer, max_response_bytes: receipt.max_response_bytes, method: receipt.method, order_count_pointer: receipt.order_count_pointer, path_template: receipt.path_template}, reviewed_by: value.reviewed_by, revision_id: value.revision_id, sandbox_only: value.sandbox_only, schema_version: value.schema_version, success_locator: {kind: locator.kind, ...(locator.role === undefined ? {} : {role: locator.role}), value: locator.value}, symptom_evidence_ids: value.symptom_evidence_ids, template: value.template, workspace_id: value.workspace_id}));
  return value;
 }
 function buildBytes(value: BuildAttestationUnsigned): Buffer {
  const b = value.body;
  return Buffer.from(JSON.stringify({attester_key_id: value.attester_key_id, body: {build_digest: b.build_digest, case_id: b.case_id, commit_sha: b.commit_sha, deployment_id: b.deployment_id, expires_at: b.expires_at, observed_at: b.observed_at, origin: b.origin, provenance_evidence_hash: b.provenance_evidence_hash, workspace_id: b.workspace_id}, schema_version: value.schema_version}));
 }
 function observerBytes(value: Omit<DeploymentObservation, 'signature'>): Buffer {
  const b = value.body;
  return Buffer.from(JSON.stringify({attester_key_id: value.attester_key_id, body: {build_digest: b.build_digest, case_id: b.case_id, deployment_id: b.deployment_id, expires_at: b.expires_at, nonce: b.nonce, observation_profile_hash: b.observation_profile_hash, observed_at: b.observed_at, origin: b.origin, plan_hash: b.plan_hash, workspace_id: b.workspace_id}, kind: value.kind, schema_version: value.schema_version}));
 }
 const builder = generateKeyPairSync('ed25519'), observer = generateKeyPairSync('ed25519');
 const nowMs = Date.parse('2026-10-13T00:00:30.000Z');
 const expected: ExpectedBuildBinding = {workspace_id: scope.workspace_id, case_id: scope.case_id, deployment_id: 'deployment-unit', origin: 'https://staging.example.test', build_digest: sha('immutable-artifact'), commit_sha: 'a'.repeat(40), provenance_evidence_hash: sha('operator-provenance'), nonce: 'fresh_attempt_nonce_0001', plan_hash: sha('reviewed-plan'), observation_profile_hash: profile().profile_hash, max_observation_age_ms: 60_000};
 function signedBuild(changes: Partial<FaultlineBuildAttestation['body']> = {}, keyId = 'builder-unit'): FaultlineBuildAttestation {
  const value: BuildAttestationUnsigned = {schema_version: 1, attester_key_id: keyId, body: {workspace_id: expected.workspace_id, case_id: expected.case_id, deployment_id: expected.deployment_id, origin: expected.origin, build_digest: expected.build_digest, commit_sha: expected.commit_sha, provenance_evidence_hash: expected.provenance_evidence_hash, observed_at: '2026-10-13T00:00:00.000Z', expires_at: '2026-10-13T01:00:00.000Z', ...changes}};
  return {...value, signature: sign(null, buildBytes(value), builder.privateKey).toString('base64')};
 }
 function signedObservation(changes: Partial<DeploymentObservation['body']> = {}): DeploymentObservation {
  const value: Omit<DeploymentObservation, 'signature'> = {schema_version: 1, kind: 'deployment_observation', attester_key_id: 'observer-unit', body: {workspace_id: expected.workspace_id, case_id: expected.case_id, deployment_id: expected.deployment_id, origin: expected.origin, build_digest: expected.build_digest, nonce: expected.nonce, plan_hash: expected.plan_hash, observation_profile_hash: expected.observation_profile_hash, observed_at: '2026-10-13T00:00:20.000Z', expires_at: '2026-10-13T00:01:00.000Z', ...changes}};
  return {...value, signature: sign(null, observerBytes(value), observer.privateKey).toString('base64')};
 }
 function trust(): OperatorTrustMaterial {
  return {allow_loopback_http: false, keys: [{id: 'builder-unit', public_key: builder.publicKey, status: 'active', purpose: 'build_attestation', workspace_id: scope.workspace_id, case_id: scope.case_id, origins: [expected.origin], deployment_ids: [expected.deployment_id], valid_from: '2026-10-12T00:00:00.000Z', expires_at: '2026-10-14T00:00:00.000Z', independent_observer: 'unavailable'}, {id: 'observer-unit', public_key: observer.publicKey, status: 'active', purpose: 'deployment_observation', workspace_id: scope.workspace_id, case_id: scope.case_id, origins: [expected.origin], deployment_ids: [expected.deployment_id], valid_from: '2026-10-12T00:00:00.000Z', expires_at: '2026-10-14T00:00:00.000Z', independent_observer: 'operator_registered'}]};
 }
 function rejected(build: unknown, observation: unknown | null, reason: string, valid = false, keys = trust(), binding = expected, clock = nowMs) {
  const result = verifyBuildAttestation(build, binding, keys, observation, clock);
  assert.equal(result.status, 'blocked'); assert.equal(result.attestation_valid, valid); assert.equal(result.deployment_status, 'blocked');
  assert.ok('reason_code' in result); assert.equal(result.reason_code, reason);
 }
 
 test("observation profiles compile finite scoped selectors and reject malformed receipts", () => {
  // reviewed profile compiles finite paths/pointers and reads real JSON types without hiding duplicate orders
  {
   const compiled = compileObservationProfile(profile(), scope);
     assert.equal(receiptPath(compiled, 'fresh_attempt_nonce_0001'), '/receipts/fresh_attempt_nonce_0001');
     assert.deepEqual(compiled.completed_pointer, ['payload', 'completed']); assert.ok(Object.isFrozen(compiled)); assert.ok(Object.isFrozen(compiled.completed_pointer));
     assert.deepEqual(readReceipt(compiled, Buffer.from('{"payload":{"completed":true,"order_count":2,"error_code":null}}')), {status: 'observed', completed: true, order_count: 2, error_code: null});
     assert.deepEqual(readReceipt(compiled, Buffer.from('{"payload":{"completed":false,"order_count":0,"error_code":"CHECKOUT_FAILURE"}}')), {status: 'observed', completed: false, order_count: 0, error_code: 'CHECKOUT_FAILURE'});
     const escaped = profile({receipt: {...profile().receipt, completed_pointer: '/a~1b/~0completed', order_count_pointer: '/items/0/count', error_code_pointer: null}});
     assert.deepEqual(readReceipt(compileObservationProfile(escaped, scope), Buffer.from('{"a/b":{"~completed":true},"items":[{"count":1}]}')), {status: 'observed', completed: true, order_count: 1, error_code: null});
     for (const attempt of ['', '../attempt', 'already%2Fencoded', 'x'.repeat(129)]) assert.throws(() => receiptPath(compiled, attempt), code('ATTEMPT_ID_INVALID'));
  }
  // profile hash/scope/path/prototype/depth and locator ambiguity cannot compile
  {
   assert.throws(() => compileObservationProfile(profile(), {...scope, revision_id: 'new-revision'}), code('OBSERVATION_SCOPE_MISMATCH'));
     assert.throws(() => compileObservationProfile({...profile(), profile_hash: sha('invented')}, scope), code('OBSERVATION_PROFILE_HASH_MISMATCH'));
     for (const path of ['/receipts/static', '/receipts/{attempt_id}/{attempt_id}', '/receipts/{other}', '/receipts/../{attempt_id}', '/receipts/./{attempt_id}']) assert.throws(() => compileObservationProfile(profile({receipt: {...profile().receipt, path_template: path}}), scope), code('OBSERVATION_PATH_UNSUPPORTED'));
     for (const path of ['//outside.test/{attempt_id}', 'https://outside.test/{attempt_id}', '/receipts/{attempt_id}#fragment', '/receipts/%2e%2e/{attempt_id}']) assert.throws(() => compileObservationProfile(profile({receipt: {...profile().receipt, path_template: path}}), scope), code('OBSERVATION_PROFILE_INVALID'));
     for (const address of ['/__proto__/completed', '/constructor/completed', '/prototype', '/a~2b', '$.completed', '/' + Array(9).fill('a').join('/')]) assert.throws(() => compileObservationProfile(profile({receipt: {...profile().receipt, completed_pointer: address}}), scope), code('OBSERVATION_POINTER_UNSUPPORTED'));
     assert.throws(() => compileObservationProfile(profile({receipt: {...profile().receipt, completed_pointer: '/payload/order_count'}}), scope), code('OBSERVATION_POINTER_UNSUPPORTED'));
     assert.throws(() => compileObservationProfile(profile({success_locator: {kind: 'role', value: 'complete'}}), scope), code('OBSERVATION_LOCATOR_UNSUPPORTED'));
     assert.throws(() => compileObservationProfile(profile({symptom_evidence_ids: ['evidence-unit', 'evidence-unit']}), scope), code('OBSERVATION_EVIDENCE_INVALID'));
  }
  // missing, malformed, invalid UTF8, duplicate and oversized receipts stay blocked with no manufactured zero
  {
   const compiled = compileObservationProfile(profile(), scope);
     assert.deepEqual(readReceipt(compiled, Buffer.from('{"payload":{"completed":true,"error_code":null}}')), {status: 'blocked', reason_code: 'RECEIPT_FIELD_UNAVAILABLE'});
     for (const orders of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.deepEqual(readReceipt(compiled, Buffer.from(JSON.stringify({payload: {completed: true, order_count: orders, error_code: null}}))), {status: 'blocked', reason_code: 'RECEIPT_FIELD_TYPE_UNSUPPORTED'});
     for (const text of ['{"payload":{"completed":true,"completed":false,"order_count":1,"error_code":null}}', '{"payload":{"completed":true,"order_count":1,"order\\u005fcount":0,"error_code":null}}', '{"payload":']) assert.deepEqual(readReceipt(compiled, Buffer.from(text)), {status: 'blocked', reason_code: 'RECEIPT_INVALID_JSON'});
     assert.deepEqual(readReceipt(compiled, Buffer.from([0xc3, 0x28])), {status: 'blocked', reason_code: 'RECEIPT_INVALID_JSON'});
     assert.deepEqual(readReceipt(compiled, Buffer.alloc(4097, 32)), {status: 'blocked', reason_code: 'RECEIPT_BYTE_LIMIT'});
     assert.equal(JSON.stringify(readReceipt(compiled, Buffer.from('PRIVATE_SOURCE_TOKEN invalid'))).includes('PRIVATE_SOURCE_TOKEN'), false);
  }
 });

 test("deployment attestations bind trusted signatures, freshness and current artifact authority", () => {
  // canonical Ed25519 signing binds version/key ID/body and fresh independent receipt separately from imported metadata
  {
   const build = signedBuild(), observed = signedObservation();
     assert.deepEqual(attestationSigningBytes(build), buildBytes(build)); assert.deepEqual(deploymentObservationSigningBytes(observed), observerBytes(observed));
     const result = verifyBuildAttestation(build, expected, trust(), observed, nowMs);
     assert.equal(result.status, 'verified'); assert.equal(result.attestation_valid, true); assert.equal(result.deployment_status, 'verified');
     assert.ok('observation_hash' in result); assert.match(result.observation_hash, /^[a-f0-9]{64}$/);
     const metadata = verifyBuildAttestation(build, expected, trust(), null, nowMs);
     assert.equal(metadata.status, 'unknown'); assert.equal(metadata.attestation_valid, true); assert.equal(metadata.deployment_status, 'unknown'); assert.ok('reason_code' in metadata); assert.equal(metadata.reason_code, 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED');
     const {nonce: _nonce, plan_hash: _plan, observation_profile_hash: _profile, max_observation_age_ms: _age, ...initial} = expected;
     assert.deepEqual(verifyInitialBuildAttestation(build, initial, trust(), nowMs), metadata);
     const missing = verifyBuildAttestation(build, expected, {...trust(), keys: []}, observed, nowMs);
     assert.equal(missing.status, 'unknown'); assert.equal(missing.attestation_valid, false);
     const notIndependent = trust(); notIndependent.keys[1]!.independent_observer = 'unavailable';
     const unknown = verifyBuildAttestation(build, expected, notIndependent, observed, nowMs);
     assert.equal(unknown.status, 'unknown'); assert.equal(unknown.attestation_valid, true); assert.ok('reason_code' in unknown); assert.equal(unknown.reason_code, 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED');
  }
  // untrusted, revoked, wrong purpose/scope/algorithm/signature/origin/digest/time cannot register valid build metadata
  {
   const observed = signedObservation();
     for (const change of [{workspace_id: 'wrong-workspace'}, {case_id: 'wrong-case'}, {deployment_id: 'wrong-deployment'}, {origin: 'https://other.example.test'}]) rejected(signedBuild(change), observed, 'ATTESTATION_SCOPE_MISMATCH');
     for (const change of [{build_digest: sha('wrong-build')}, {commit_sha: 'b'.repeat(40)}, {provenance_evidence_hash: sha('wrong-provenance')}]) rejected(signedBuild(change), observed, 'ATTESTATION_ARTIFACT_MISMATCH');
     for (const origin of ['https://staging.example.test/', 'https://staging.example.test/path', 'https://user:secret@staging.example.test', 'http://staging.example.test', 'http://127.0.0.1:4333']) rejected(signedBuild({origin}), observed, 'ATTESTATION_ORIGIN_INVALID');
     rejected(signedBuild({observed_at: '2026-10-13T00:00:30.001Z'}), observed, 'ATTESTATION_FROM_FUTURE');
     rejected(signedBuild({expires_at: '2026-10-13T00:00:30.000Z'}), observed, 'ATTESTATION_EXPIRED');
     rejected(signedBuild({expires_at: '2026-10-13T00:00:00.000Z'}), observed, 'ATTESTATION_TIME_INVALID');
     rejected({...signedBuild(), signature: Buffer.alloc(64).toString('base64')}, observed, 'ATTESTATION_SIGNATURE_INVALID');
     rejected({...signedBuild(), signature: ' '.repeat(88)}, observed, 'ATTESTATION_SIGNATURE_INVALID');
     rejected({...signedBuild(), public_key: builder.publicKey.export({format: 'pem', type: 'spki'})}, observed, 'ATTESTATION_SCHEMA_INVALID');
     for (const [field, value, reason] of [['status', 'revoked', 'ATTESTER_KEY_REVOKED'], ['purpose', 'deployment_observation', 'ATTESTER_PURPOSE_MISMATCH'], ['case_id', 'other-case', 'ATTESTER_SCOPE_MISMATCH']] as const) {const keys = trust(); Object.assign(keys.keys[0]!, {[field]: value}); rejected(signedBuild(), observed, reason, false, keys);}
     const nonEd = trust(); nonEd.keys[0]!.public_key = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}).publicKey; rejected(signedBuild(), observed, 'ATTESTER_KEY_UNSUPPORTED', false, nonEd);
     const duplicate = trust(); duplicate.keys = [...duplicate.keys, duplicate.keys[0]!]; rejected(signedBuild(), observed, 'ATTESTER_REGISTRY_AMBIGUOUS', false, duplicate);
     const keyRename = trust(); keyRename.keys[0]!.id = 'renamed-builder'; rejected({...signedBuild(), attester_key_id: 'renamed-builder'}, observed, 'ATTESTATION_SIGNATURE_INVALID', false, keyRename);
     const unknown = trust(); unknown.keys[0]!.status = 'unknown'; assert.equal(verifyBuildAttestation(signedBuild(), expected, unknown, observed, nowMs).attestation_valid, false);
     for (const [field, value, reason] of [['valid_from', '2026-10-13T00:00:30.001Z', 'ATTESTER_KEY_NOT_YET_VALID'], ['valid_from', '2026-10-13T00:00:00.001Z', 'ATTESTER_KEY_NOT_YET_VALID'], ['expires_at', '2026-10-13T00:00:30.000Z', 'ATTESTER_KEY_EXPIRED'], ['expires_at', '2026-10-12T00:00:00.000Z', 'ATTESTER_KEY_TIME_INVALID']] as const) {const keys = trust(); Object.assign(keys.keys[0]!, {[field]: value}); rejected(signedBuild(), observed, reason, false, keys);}
  }
  // fresh deployment receipt pins nonce/plan/profile/current artifact and operator authority; unsupported facts never verify
  {
   const build = signedBuild();
     for (const change of [{nonce: 'different_nonce_0001'}, {plan_hash: sha('other-plan')}, {observation_profile_hash: sha('other-profile')}]) rejected(build, signedObservation(change), 'DEPLOYMENT_OBSERVATION_BINDING_MISMATCH', true);
     rejected(build, signedObservation({build_digest: sha('changed-during-run')}), 'DEPLOYMENT_ARTIFACT_CHANGED', true);
     rejected(build, signedObservation({origin: 'https://other.example.test'}), 'DEPLOYMENT_OBSERVATION_SCOPE_MISMATCH', true);
     rejected(build, signedObservation({observed_at: '2026-10-13T00:00:30.001Z'}), 'ATTESTATION_FROM_FUTURE', true);
     rejected(build, signedObservation({expires_at: '2026-10-13T00:00:30.000Z'}), 'ATTESTATION_EXPIRED', true);
     rejected(build, signedObservation({observed_at: '2026-10-12T23:59:29.999Z'}), 'DEPLOYMENT_OBSERVATION_STALE', true);
     rejected(build, {...signedObservation(), signature: Buffer.alloc(64).toString('base64')}, 'DEPLOYMENT_OBSERVATION_SIGNATURE_INVALID', true);
     rejected(build, {...signedObservation(), override: true}, 'DEPLOYMENT_OBSERVATION_SCHEMA_INVALID', true);
     const revoked = trust(); revoked.keys[1]!.status = 'revoked'; rejected(build, signedObservation(), 'ATTESTER_KEY_REVOKED', true, revoked);
     for (const clock of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) rejected(build, signedObservation(), 'ATTESTATION_EXPECTED_BINDING_INVALID', false, trust(), expected, clock);
     for (const max_observation_age_ms of [NaN, -1, 0, 600001, 1.5]) rejected(build, signedObservation(), 'ATTESTATION_EXPECTED_BINDING_INVALID', false, trust(), {...expected, max_observation_age_ms});
     const local = {...expected, origin: 'http://127.0.0.1:4333'}, keys = trust(); keys.allow_loopback_http = true; for (const key of keys.keys) key.origins = [local.origin];
     assert.equal(verifyBuildAttestation(signedBuild({origin: local.origin}), local, keys, signedObservation({origin: local.origin}), nowMs).status, 'verified');
  }
 });

}

// operator profile
{
 const wid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sha='a'.repeat(64),clock=Date.parse('2026-10-13T00:00:00.000Z');
 function registration<T extends object>(kind:string,profile:T){return {schema_version:1,workspace_id:wid,kind,id:kind+'-one',profile};}
 const network={origins:['https://staging.example.org'],path_prefixes:['/checkout','/sandbox'],credential_refs:[],deny_private_addresses:true,max_response_bytes:4096};
 const runner={endpoint:'https://runner.example.org',implementation_digest:sha,transport_ca_sha256:sha,peer_certificate_sha256:sha,network_profile_id:'network-one',isolation:'gvisor',isolation_evidence_hash:null};
 test("operator profiles retain exact staging origins and finite public-key authority", () => {
  // operator metadata has exact scoped fields, no capability claims, owns its immutable input copy
  {
   const source=registration('network',network),value=validateOperatorRegistration(source,clock);assert.deepEqual(value,source);(value.profile.origins as string[]).push('https://other.example.org');assert.equal(source.profile.origins.length,1);
     assert.deepEqual(validateOperatorRegistration(registration('runner',runner),clock).profile,runner);
     const environment={runner_id:'runner-one',engine:'chromium',engine_version:'1.2.3',viewports:{mobile:{width:390,height:844},desktop:{width:1280,height:800}},timezone:'UTC',locale:'en-US',feature_flags:[]};assert.deepEqual(validateOperatorRegistration(registration('environment',environment),clock).profile,environment);
     for(const value of [{...source,capabilities:{status:'available'}},{...source,workspace_id:'not-a-workspace'},registration('grant',network),registration('network',{...network,deny_private_addresses:false}),registration('network',{...network,max_response_bytes:65537}),registration('network',{...network,origins:[...network.origins,...network.origins]}),registration('runner',{...runner,isolation:'docker'}),registration('runner',{...runner,implementation_digest:'latest'})])assert.throws(()=>validateOperatorRegistration(value,clock));
  }
  // exact staging authority rejects credentials, paths, protocols, IP and local origin tricks before any network access
  {
   assert.equal(stagingOrigin('https://staging.example.org'),'https://staging.example.org');
     for(const origin of ['http://staging.example.org','https://staging.example.org/','https://staging.example.org/path','https://staging.example.org?x=1','https://user:password@staging.example.org','https://127.0.0.1','https://localhost','https://x.localhost','https://staging.example.org:8443'])assert.throws(()=>stagingOrigin(origin));
     for(const path of ['//evil.example','/../private','/sandbox?query=1','/sandbox/{script}','/sandbox%2fprivate'])assert.throws(()=>validateOperatorRegistration(registration('network',{...network,path_prefixes:[path]}),clock));
  }
  // operator attester accepts only current scoped Ed25519 public keys and external deployment-system metadata
  {
   const keys=generateKeyPairSync('ed25519'),publicPem=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privatePem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
     const profile={key_id:'deploy-key-one',public_key_pem:publicPem,deployment_scopes:[{deployment_id:'deploy-one',origin:'https://staging.example.org',repository_id:'repo-one',environment_id:'environment-one'}],valid_from:'2026-10-12T00:00:00.000Z',expires_at:'2026-10-14T00:00:00.000Z',purposes:['build','deployment'],observer:{adapter_id:'operator-observer',adapter_version:'1',configuration_hash:sha,independence:'deployment_system'}};
     assert.deepEqual(validateOperatorRegistration(registration('attester',profile),clock).profile,profile);
     const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'}).toString();
     for(const value of [{...profile,public_key_pem:privatePem},{...profile,public_key_pem:ec},{...profile,valid_from:'2026-10-14T00:00:00.000Z'},{...profile,expires_at:'2026-10-13T00:00:00.000Z'},{...profile,expires_at:'2026-02-30T00:00:00.000Z'},{...profile,observer:{...profile.observer,independence:'candidate_header'}},{...profile,deployment_scopes:[...profile.deployment_scopes,...profile.deployment_scopes]}])assert.throws(()=>validateOperatorRegistration(registration('attester',value),clock));
  }
 });

}

// runner client
{
 const digest=(c:string)=>c.repeat(64),key=Buffer.alloc(32,7),keyB64=key.toString('base64'),clock=Date.parse('2026-10-17T10:00:00.000Z');
 const profile={endpoint:'https://runner.example.test',implementation_digest:digest('a'),transport_ca_sha256:digest('b'),peer_certificate_sha256:digest('c')};
 const binding={profile_hash:digest('d'),network_hash:digest('e')};
 const executionBinding={adapter_id:'generic-vm-adapter',adapter_version:'1.0.0',provider_id:'example-cloud',provider_version:'2026-10',provider_configuration_hash:digest('f'),isolation_configuration_hash:digest('1'),execution_program_sha256:digest('0')};
 const environment={RUNNER_MODE:'external',EXTERNAL_RUNNER_URL:profile.endpoint,EXTERNAL_RUNNER_AUTH_KEY_B64:keyB64};
 const nonce='00000000-0000-4000-8000-000000000001';
 const sign=(value:unknown)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
 const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
 
 function evidence(boot:string,network:string){
  return {version:1,kind:'hardened_isolation_probe',private_network_denied:true,firewall_default_deny:true,approved_https:true,unrelated_public_denied:true,loopback_denied:true,metadata_denied:true,private_address_denied:true,privilege_dropped:true,before:{boot_id:boot,network_ns:network,docker_socket_present:false,control_plane_credential_present:false}};
 }
 function probePayload(){
  const first=evidence('boot-one','net-one'),second=evidence('boot-two','net-two');
  return {version:1,status:'available',checked_at:'2026-10-17T10:00:01.000Z',adapter_id:'generic-vm-adapter',adapter_version:'1.0.0',provider_id:'example-cloud',provider_version:'2026-10',provider_configuration_hash:digest('f'),implementation_digest:profile.implementation_digest,isolation_configuration_hash:digest('1'),capability_program_sha256:digest('f'),execution_program_sha256:digest('0'),cleanup_verification:true,crash_reconciliation:true,network_calls:2,runs:[{execution_id:'execution-one',result_sha256:hash(first),evidence:first},{execution_id:'execution-two',result_sha256:hash(second),evidence:second}]};
 }
 function response(request:any,payload:unknown,change:(body:any)=>void=()=>{}){
  const body:any={version:1,nonce:request.nonce,at:'2026-10-17T10:00:02.000Z',ok:true,payload,error_code:null};change(body);
  return {status:200,body:JSON.stringify({...body,signature:sign(body)}),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256};
 }
 function dependencies(path:string,payload:()=>unknown,change:(body:any)=>void=()=>{}){
  return {now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{const request=JSON.parse(input.body);assert.equal(input.url.pathname,path);assert.equal(request.signature,sign({method:'POST',path,version:request.version,nonce:request.nonce,expires_at:request.expires_at,payload:request.payload}));return response(request,payload(),change);}};
 }
 
 test("runner capability requires provider-neutral distinct complete isolation executions", async () => {
  // accepts provider-neutral capability evidence from two distinct executions
  {
   const value=await requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload));
     assert.equal(value.status,'available');assert.equal(value.adapter_id,'generic-vm-adapter');assert.equal(value.runs.length,2);
  }
  // rejects provider-specific legacy capability payloads and evidence
  {
   const legacy:any=probePayload();delete legacy.adapter_id;delete legacy.provider_id;delete legacy.execution_program_sha256;legacy.checkpoint_name='railway-checkpoint';legacy.runs[0].sandbox_id=legacy.runs[0].execution_id;delete legacy.runs[0].execution_id;
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>legacy)),/unexpected fields/i);
     const wrong=probePayload();wrong.runs[0]!.evidence.kind='railway_isolation_probe';
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>wrong)),/evidence is incomplete/i);
  }
  // rejects incomplete or non-distinct isolation evidence
  {
   const payload=probePayload();payload.runs[1]!.evidence.before.boot_id='boot-one';payload.runs[1]!.result_sha256=hash(payload.runs[1]!.evidence);
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>payload)),/not independent/i);
     const credential=probePayload();credential.runs[0]!.evidence.before.control_plane_credential_present=true;
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',()=>credential)),/evidence is incomplete/i);
  }
 });

 test("runner tasks bind canonical immutable payload and response digests", async () => {
  // sends a canonical task with a digest and task-route-bound signature
  {
   const task={z:2,a:{second:true,first:'value'}},result={steps:3,status:'passed'};
     const receipt=await requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{
      const request=JSON.parse(input.body),taskRoute={method:'POST',path:'/v1/tasks/execute',version:1,nonce:request.nonce,expires_at:request.expires_at,payload:request.payload},probeRoute={...taskRoute,path:'/v1/probe'};
      assert.equal(input.url.pathname,'/v1/tasks/execute');assert.equal(JSON.stringify(request.payload.task),canonical(task));assert.equal(request.payload.task_sha256,hash(task));
      assert.equal(request.signature,sign(taskRoute));assert.notEqual(request.signature,sign(probeRoute));
      return response(request,{version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,isolation_configuration_hash:executionBinding.isolation_configuration_hash,implementation_digest:profile.implementation_digest,execution_id:'execution-task-one',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result});
     }});
     assert.deepEqual(receipt.result,result);
  }
  // snapshots the task before transport and rejects task or result digest mismatches
  {
   const task={value:'original'},result={status:'passed'};
     const receipt=(request:any,overrides:Record<string,unknown>={})=>({version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,isolation_configuration_hash:executionBinding.isolation_configuration_hash,implementation_digest:profile.implementation_digest,execution_id:'execution',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result,...overrides});
     const pending=requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>{await Promise.resolve();const request=JSON.parse(input.body);assert.equal(request.payload.task.value,'original');return response(request,receipt(request));}});
     task.value='mutated';await pending;
     await assert.rejects(()=>requestRunnerTask(profile,{value:'original'},executionBinding,new AbortController().signal,dependencies('/v1/tasks/execute',()=>receipt({payload:{task_sha256:hash({value:'original'})}},{task_sha256:digest('7')}))),/did not bind/i);
     await assert.rejects(()=>requestRunnerTask(profile,{value:'original'},executionBinding,new AbortController().signal,dependencies('/v1/tasks/execute',()=>receipt({payload:{task_sha256:hash({value:'original'})}},{result_sha256:digest('6')}))),/result digest/i);
  }
 });

 test('validates a long task response against receive time rather than request start',async()=>{
  const task={value:'long-running'},result={status:'passed'},times=[clock,clock+70_000];
  const receipt=await requestRunnerTask(profile,task,executionBinding,new AbortController().signal,{now:()=>times.shift()??clock+70_000,nonce:()=>nonce,environment,transport:async(input:any)=>{
   const request=JSON.parse(input.body),body:any={version:1,nonce:request.nonce,at:new Date(clock+70_000).toISOString(),ok:true,payload:{version:1,status:'completed',adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,implementation_digest:profile.implementation_digest,isolation_configuration_hash:executionBinding.isolation_configuration_hash,execution_id:'execution-long',task_sha256:request.payload.task_sha256,program_sha256:executionBinding.execution_program_sha256,result_sha256:hash(result),result},error_code:null};
   return {status:200,body:JSON.stringify({...body,signature:sign(body)}),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256};
  }});
  assert.equal(receipt.execution_id,'execution-long');
 });
 
 test('status and cancellation bind the same execution, task and provider capability',async()=>{
  const command={execution_key:'task_nonce_external_0001',task_sha256:digest('8')};
  const state=(status:'running'|'cancelled')=>({version:1,status,adapter_id:executionBinding.adapter_id,adapter_version:executionBinding.adapter_version,provider_id:executionBinding.provider_id,provider_version:executionBinding.provider_version,provider_configuration_hash:executionBinding.provider_configuration_hash,implementation_digest:profile.implementation_digest,isolation_configuration_hash:executionBinding.isolation_configuration_hash,execution_key:command.execution_key,task_sha256:command.task_sha256,updated_at:'2026-10-17T10:00:01.000Z'});
  assert.equal((await requestRunnerTaskStatus(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/status',()=>state('running')))).status,'running');
  assert.equal((await cancelRunnerTask(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/cancel',()=>state('cancelled')))).status,'cancelled');
  await assert.rejects(()=>requestRunnerTaskStatus(profile,command,executionBinding,new AbortController().signal,dependencies('/v1/tasks/status',()=>({...state('running'),task_sha256:digest('9')}))),/did not bind/i);
 });
 
 test('rejects replayed or stale authenticated response envelopes',async()=>{
  await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload,body=>{body.nonce='00000000-0000-4000-8000-000000000099';})),/authentication|freshness/i);
  await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,dependencies('/v1/probe',probePayload,body=>{body.at='2026-10-17T09:58:59.000Z';})),/authentication|freshness/i);
 });
 
 test("runner envelopes reject byte overflow, wrong TLS identity, duplicate keys and endpoint changes", async () => {
  // rejects oversized responses before parsing and mismatched TLS identities
  {
   const request=()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async()=>({status:200,body:'x'.repeat(1024*1024+1),leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256})});
     await assert.rejects(request,/finite bound/i);
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async(input:any)=>({...response(JSON.parse(input.body),probePayload()),leafSha256:digest('4')})}),/TLS identity/i);
  }
  // rejects duplicate response keys and a configured endpoint mismatch
  {
   await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{now:()=>clock,nonce:()=>nonce,environment,transport:async()=>({status:200,body:'{"version":1,"version":1}',leafSha256:profile.peer_certificate_sha256,rootSha256:profile.transport_ca_sha256})}),/duplicate/i);
     await assert.rejects(()=>requestRunnerProbe(profile,binding,new AbortController().signal,{environment:{...environment,EXTERNAL_RUNNER_URL:'https://other.example.test'},transport:async()=>{throw new Error('called');}}),/not the configured external runner/i);
  }
 });

}

// service capability
{
 const clock=Date.parse('2026-10-17T12:00:00.000Z');
 const available=(checked_at:string)=>({schema_version:1,source_kind:'runner',status:'available',checked_at,adapter_version:'faultline-hardened-runner-v1',read_only:true,features:['ephemeral_vm_isolation','default_deny_guest_egress','external_browser_execution','cancellation_reconciliation'],unsupported_features:['independent_deployment_observation'],reason_code:null,provider_version:'example-cloud@2026-10'});
 
 test('stored runner capability expires with the controller five-minute probe window',()=>{
  assert.equal(projectRunnerCapabilities(available(new Date(clock-299_999).toISOString()),clock).status,'available');
  const stale=projectRunnerCapabilities(available(new Date(clock-300_001).toISOString()),clock);
  assert.equal(stale.status,'unavailable');assert.equal(stale.reason_code,'RUNNER_CAPABILITY_STALE');assert.deepEqual(stale.features,[]);assert.ok(stale.unsupported_features.includes('external_browser_execution'));
 });
}
