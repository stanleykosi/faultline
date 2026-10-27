import {KeyObject, verify} from 'node:crypto';
import type {FaultlineBuildAttestation, FaultlineObservationProfile} from '../../../contracts/src/generated.js';
import {validateContract} from '../../../contracts/src/validate.js';
import {canonical, hash} from '../canonical.js';
import {demand, DomainError} from '../errors.js';
import {rejectDuplicateJsonKeys} from '../imports/duplicate-json-keys.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MAX_RECEIPT_POINTER_DEPTH = 8;
export const MAX_DEPLOYMENT_OBSERVATION_AGE_MS = 600_000;

export interface ObservationScope {workspace_id: string; case_id: string; revision_id: string;}
export interface CompiledObservationProfile {
 readonly profile_hash: string;
 readonly path_before: string;
 readonly path_after: string;
 readonly completed_pointer: readonly string[];
 readonly order_count_pointer: readonly string[];
 readonly error_code_pointer: readonly string[] | null;
 readonly max_response_bytes: number;
}
export type ReceiptReading =
 | {status: 'observed'; completed: boolean; order_count: number; error_code: string | null}
 | {status: 'blocked'; reason_code: 'RECEIPT_BYTE_LIMIT' | 'RECEIPT_INVALID_JSON' | 'RECEIPT_FIELD_UNAVAILABLE' | 'RECEIPT_FIELD_TYPE_UNSUPPORTED'};

function plain(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
 return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function timestamp(value: unknown): number | null {
 if (typeof value !== 'string' || !timestampPattern.test(value)) return null;
 const parsed = Date.parse(value);
 return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
function pointer(value: string): readonly string[] {
 demand(typeof value === 'string' && value.length > 0 && value.length <= 100 && value.startsWith('/'), 'OBSERVATION_POINTER_UNSUPPORTED', 'Use a bounded JSON Pointer.');
 const parts = value.slice(1).split('/');
 demand(parts.length <= MAX_RECEIPT_POINTER_DEPTH, 'OBSERVATION_POINTER_UNSUPPORTED', 'JSON Pointer exceeds the supported depth.');
 return Object.freeze(parts.map(part => {
  demand(!/~(?![01])/.test(part), 'OBSERVATION_POINTER_UNSUPPORTED', 'JSON Pointer escape is unsupported.');
  const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
  demand(decoded.length <= 100 && !forbiddenKeys.has(decoded) && !/[\x00-\x1f\x7f]/.test(decoded), 'OBSERVATION_POINTER_UNSUPPORTED', 'JSON Pointer contains an unsafe key.');
  return decoded;
 }));
}
function pathParts(template: string): [string, string] {
 demand(typeof template === 'string' && template.length <= 300 && /^\/(?!\/)[A-Za-z0-9/_{}.-]+$/.test(template), 'OBSERVATION_PATH_UNSUPPORTED', 'Use a literal same-origin receipt path.');
 const token = '{attempt_id}', parts = template.split(token);
 demand(parts.length === 2 && !parts.some(part => /[{}]/.test(part)) && !template.split('/').some(part => part === '.' || part === '..'), 'OBSERVATION_PATH_UNSUPPORTED', 'Receipt path requires one attempt placeholder and no traversal.');
 return [parts[0]!, parts[1]!];
}

/** Compilation grants no authority; the caller supplies the current authenticated scope. */
export function compileObservationProfile(value: FaultlineObservationProfile, expected: ObservationScope): CompiledObservationProfile {
 let profile: FaultlineObservationProfile;
 try {profile = validateContract<FaultlineObservationProfile>('observation-profile', value);}
 catch {throw new DomainError('OBSERVATION_PROFILE_INVALID', 'Observation profile does not match the finite contract.', 400);}
 demand(exactKeys(expected, ['workspace_id', 'case_id', 'revision_id']) && Object.values(expected).every(item => typeof item === 'string' && idPattern.test(item)), 'OBSERVATION_SCOPE_INVALID', 'Current observation scope is required.');
 demand(profile.workspace_id === expected.workspace_id && profile.case_id === expected.case_id && profile.revision_id === expected.revision_id, 'OBSERVATION_SCOPE_MISMATCH', 'Observation profile belongs to another scope or revision.', 409);
 demand(profile.success_locator.kind === 'role' ? profile.success_locator.role !== undefined : profile.success_locator.role === undefined, 'OBSERVATION_LOCATOR_UNSUPPORTED', 'Role locators require an explicit finite role.');
 demand(new Set(profile.symptom_evidence_ids).size === profile.symptom_evidence_ids.length, 'OBSERVATION_EVIDENCE_INVALID', 'Symptom evidence identifiers must be distinct.');
 const {profile_hash, ...unsigned} = profile;
 demand(hash(unsigned) === profile_hash, 'OBSERVATION_PROFILE_HASH_MISMATCH', 'Observation profile hash does not bind these exact fields.', 409);
 const [path_before, path_after] = pathParts(profile.receipt.path_template);
 const completed_pointer = pointer(profile.receipt.completed_pointer), order_count_pointer = pointer(profile.receipt.order_count_pointer), error_code_pointer = profile.receipt.error_code_pointer === null ? null : pointer(profile.receipt.error_code_pointer);
 demand(new Set([canonical(completed_pointer), canonical(order_count_pointer), ...(error_code_pointer ? [canonical(error_code_pointer)] : [])]).size === (error_code_pointer ? 3 : 2), 'OBSERVATION_POINTER_UNSUPPORTED', 'Required receipt fields must have distinct addresses.');
 return Object.freeze({profile_hash, path_before, path_after, completed_pointer, order_count_pointer, error_code_pointer, max_response_bytes: profile.receipt.max_response_bytes});
}

/** Only a server-issued opaque attempt identifier is accepted; it is encoded once. */
export function receiptPath(compiled: CompiledObservationProfile, attemptId: string): string {
 demand(typeof attemptId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(attemptId), 'ATTEMPT_ID_INVALID', 'A fresh opaque attempt identifier is required.');
 const [before, after] = pathParts(compiled.path_before + '{attempt_id}' + compiled.path_after);
 return before + encodeURIComponent(attemptId) + after;
}
function atPointer(value: unknown, parts: readonly string[]): unknown {
 let current = value;
 for (const key of parts) {
  if (forbiddenKeys.has(key) || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
  if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) return undefined;
  current = (current as Record<string, unknown>)[key];
 }
 return current;
}
export function readReceipt(compiled: CompiledObservationProfile, bytes: Uint8Array): ReceiptReading {
 if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(compiled.max_response_bytes) || compiled.max_response_bytes < 1 || compiled.max_response_bytes > 65_536 || bytes.byteLength > compiled.max_response_bytes) return {status: 'blocked', reason_code: 'RECEIPT_BYTE_LIMIT'};
 let parsed: unknown;
 try {const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); rejectDuplicateJsonKeys(text, 16); parsed = JSON.parse(text);}
 catch {return {status: 'blocked', reason_code: 'RECEIPT_INVALID_JSON'};}
 const completed = atPointer(parsed, compiled.completed_pointer), orders = atPointer(parsed, compiled.order_count_pointer), error = compiled.error_code_pointer === null ? null : atPointer(parsed, compiled.error_code_pointer);
 if (completed === undefined || orders === undefined || error === undefined) return {status: 'blocked', reason_code: 'RECEIPT_FIELD_UNAVAILABLE'};
 if (typeof completed !== 'boolean' || typeof orders !== 'number' || !Number.isSafeInteger(orders) || orders < 0 || !(error === null || typeof error === 'string' && error.length > 0 && error.length <= 100 && !/[\x00-\x1f\x7f]/.test(error))) return {status: 'blocked', reason_code: 'RECEIPT_FIELD_TYPE_UNSUPPORTED'};
 return {status: 'observed', completed, order_count: orders, error_code: error};
}

export type BuildAttestationUnsigned = Omit<FaultlineBuildAttestation, 'signature'>;
export interface DeploymentObservationBody {
 workspace_id: string; case_id: string; deployment_id: string; origin: string; build_digest: string;
 nonce: string; plan_hash: string; observation_profile_hash: string; observed_at: string; expires_at: string;
}
export interface DeploymentObservation {
 schema_version: 1; kind: 'deployment_observation'; attester_key_id: string; body: DeploymentObservationBody; signature: string;
}
export interface InitialBuildBinding {
 workspace_id: string; case_id: string; deployment_id: string; origin: string; build_digest: string; commit_sha: string; provenance_evidence_hash: string;
}
export interface ExpectedBuildBinding extends InitialBuildBinding {
 nonce: string; plan_hash: string; observation_profile_hash: string; max_observation_age_ms: number;
}
/** Supplied only by the operator registry, never deserialized from an import body. */
export interface OperatorAttesterKey {
 id: string; public_key: KeyObject; status: 'active' | 'revoked' | 'unknown';
 purpose: 'build_attestation' | 'deployment_observation' | 'both';
 workspace_id: string; case_id: string; origins: readonly string[]; deployment_ids: readonly string[];
 valid_from: string; expires_at: string;
 independent_observer: 'operator_registered' | 'unavailable';
}
export interface OperatorTrustMaterial {keys: readonly OperatorAttesterKey[]; allow_loopback_http: boolean;}
export type BuildValidation =
 | {status: 'verified'; attestation_valid: true; deployment_status: 'verified'; attestation_hash: string; observation_hash: string}
 | {status: 'blocked' | 'unknown'; attestation_valid: boolean; deployment_status: 'blocked' | 'unknown'; reason_code: string; attestation_hash?: string};

export function attestationSigningBytes(value: BuildAttestationUnsigned | FaultlineBuildAttestation): Buffer {
 const {signature: _signature, ...unsigned} = value as FaultlineBuildAttestation;
 try {validateContract('build-attestation', {...unsigned, signature: Buffer.alloc(64).toString('base64')});}
 catch {throw new DomainError('ATTESTATION_SCHEMA_INVALID', 'Build attestation does not match the finite signing contract.', 400);}
 return Buffer.from(canonical(unsigned));
}
const observationKeys = ['schema_version', 'kind', 'attester_key_id', 'body', 'signature'] as const;
const observationBodyKeys = ['workspace_id', 'case_id', 'deployment_id', 'origin', 'build_digest', 'nonce', 'plan_hash', 'observation_profile_hash', 'observed_at', 'expires_at'] as const;
function observationShape(value: unknown): value is DeploymentObservation {
 if (!exactKeys(value, observationKeys) || value.schema_version !== 1 || value.kind !== 'deployment_observation' || typeof value.attester_key_id !== 'string' || !idPattern.test(value.attester_key_id) || typeof value.signature !== 'string' || value.signature.length > 256 || !exactKeys(value.body, observationBodyKeys)) return false;
 const body = value.body;
 return ['workspace_id', 'case_id', 'deployment_id'].every(key => typeof body[key] === 'string' && idPattern.test(body[key])) && typeof body.origin === 'string' && body.origin.length <= 2048 && ['build_digest', 'plan_hash', 'observation_profile_hash'].every(key => typeof body[key] === 'string' && digestPattern.test(body[key])) && typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(body.nonce) && timestamp(body.observed_at) !== null && timestamp(body.expires_at) !== null;
}
export function deploymentObservationSigningBytes(value: Omit<DeploymentObservation, 'signature'> | DeploymentObservation): Buffer {
 const {signature: _signature, ...unsigned} = value as DeploymentObservation;
 demand(observationShape({...unsigned, signature: Buffer.alloc(64).toString('base64')}), 'DEPLOYMENT_OBSERVATION_SCHEMA_INVALID', 'Deployment observation does not match the finite signing contract.', 400);
 return Buffer.from(canonical(unsigned));
}
function exactOrigin(value: unknown, loopback: boolean): value is string {
 if (typeof value !== 'string' || value.length > 2048) return false;
 try {const url = new URL(value); return value === url.origin && !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || loopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));}
 catch {return false;}
}
function canonicalSignature(value: string): Buffer | null {
 if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
 const signature = Buffer.from(value, 'base64'); return signature.length === 64 && signature.toString('base64') === value ? signature : null;
}
function signer(trust: OperatorTrustMaterial, keyId: string, expected: InitialBuildBinding, purpose: 'build_attestation' | 'deployment_observation', nowMs: number, signedAt: string): {key?: OperatorAttesterKey; code?: string; unknown?: boolean} {
 const matches = trust.keys.filter(key => key.id === keyId);
 if (matches.length === 0) return {code: 'ATTESTER_TRUST_REQUIRED', unknown: true};
 if (matches.length !== 1) return {code: 'ATTESTER_REGISTRY_AMBIGUOUS'};
 const key = matches[0]!;
 if (key.status === 'unknown') return {code: 'ATTESTER_TRUST_UNKNOWN', unknown: true};
 if (key.status !== 'active') return {code: 'ATTESTER_KEY_REVOKED'};
 if (!(key.public_key instanceof KeyObject) || key.public_key.type !== 'public' || key.public_key.asymmetricKeyType !== 'ed25519') return {code: 'ATTESTER_KEY_UNSUPPORTED'};
 const from = timestamp(key.valid_from), until = timestamp(key.expires_at), signed = timestamp(signedAt);
 if (from === null || until === null || until <= from || signed === null) return {code: 'ATTESTER_KEY_TIME_INVALID'};
 if (from > nowMs || from > signed) return {code: 'ATTESTER_KEY_NOT_YET_VALID'};
 if (until <= nowMs || until <= signed) return {code: 'ATTESTER_KEY_EXPIRED'};
 if (key.purpose !== 'both' && key.purpose !== purpose) return {code: 'ATTESTER_PURPOSE_MISMATCH'};
 if (key.workspace_id !== expected.workspace_id || key.case_id !== expected.case_id || !Array.isArray(key.origins) || !Array.isArray(key.deployment_ids) || key.origins.length > 10 || key.deployment_ids.length > 100 || !key.origins.includes(expected.origin) || !key.deployment_ids.includes(expected.deployment_id)) return {code: 'ATTESTER_SCOPE_MISMATCH'};
 if (purpose === 'deployment_observation' && key.independent_observer !== 'operator_registered') return {code: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', unknown: true};
 return {key};
}
function timeFailure(observed: string, expires: string, nowMs: number, maxAge?: number): string | null {
 const at = timestamp(observed), until = timestamp(expires);
 if (at === null || until === null || until <= at) return 'ATTESTATION_TIME_INVALID';
 if (at > nowMs) return 'ATTESTATION_FROM_FUTURE';
 if (until <= nowMs) return 'ATTESTATION_EXPIRED';
 if (maxAge !== undefined && nowMs - at > maxAge) return 'DEPLOYMENT_OBSERVATION_STALE';
 return null;
}

/** Valid signatures establish imported provenance only; fresh independent observation is separate. */
export function verifyInitialBuildAttestation(value: unknown, expected: InitialBuildBinding, trust: OperatorTrustMaterial, nowMs: number): BuildValidation {
 const result = (code: string, unknown = false): BuildValidation => ({status: unknown ? 'unknown' : 'blocked', attestation_valid: false, deployment_status: unknown ? 'unknown' : 'blocked', reason_code: code});
 if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000 || !exactKeys(expected, ['workspace_id', 'case_id', 'deployment_id', 'origin', 'build_digest', 'commit_sha', 'provenance_evidence_hash']) || ![expected.workspace_id, expected.case_id, expected.deployment_id].every(item => typeof item === 'string' && idPattern.test(item)) || ![expected.build_digest, expected.provenance_evidence_hash].every(item => typeof item === 'string' && digestPattern.test(item)) || typeof expected.commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(expected.commit_sha)) return result('ATTESTATION_EXPECTED_BINDING_INVALID');
 if (!plain(trust) || !Array.isArray(trust.keys) || trust.keys.length > 100 || !trust.keys.every(key => plain(key) && typeof key.id === 'string' && idPattern.test(key.id)) || typeof trust.allow_loopback_http !== 'boolean') return result('ATTESTER_REGISTRY_INVALID');
 if (!exactOrigin(expected.origin, trust.allow_loopback_http)) return result('ATTESTATION_ORIGIN_INVALID');
 let attestation: FaultlineBuildAttestation;
 try {
  if (!exactKeys(value, ['schema_version', 'attester_key_id', 'body', 'signature']) || !exactKeys(value.body, ['workspace_id', 'case_id', 'deployment_id', 'origin', 'build_digest', 'commit_sha', 'provenance_evidence_hash', 'observed_at', 'expires_at'])) return result('ATTESTATION_SCHEMA_INVALID');
  if (!exactOrigin(value.body.origin, trust.allow_loopback_http)) return result('ATTESTATION_ORIGIN_INVALID');
  attestation = validateContract<FaultlineBuildAttestation>('build-attestation', value);
 }
 catch {return result('ATTESTATION_SCHEMA_INVALID');}
 const body = attestation.body;
 if (body.workspace_id !== expected.workspace_id || body.case_id !== expected.case_id || body.deployment_id !== expected.deployment_id || body.origin !== expected.origin) return result('ATTESTATION_SCOPE_MISMATCH');
 if (body.build_digest !== expected.build_digest || body.commit_sha !== expected.commit_sha || body.provenance_evidence_hash !== expected.provenance_evidence_hash) return result('ATTESTATION_ARTIFACT_MISMATCH');
 const invalidTime = timeFailure(body.observed_at, body.expires_at, nowMs);
 if (invalidTime) return result(invalidTime);
 const key = signer(trust, attestation.attester_key_id, expected, 'build_attestation', nowMs, body.observed_at);
 if (!key.key) return result(key.code!, key.unknown);
 const signature = canonicalSignature(attestation.signature);
 try {if (!signature || !verify(null, attestationSigningBytes(attestation), key.key.public_key, signature)) return result('ATTESTATION_SIGNATURE_INVALID');}
 catch {return result('ATTESTATION_SIGNATURE_INVALID');}
 return {status: 'unknown', attestation_valid: true, deployment_status: 'unknown', reason_code: 'INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', attestation_hash: hash(attestation)};
}

/** The full run expectation adds real nonce/plan/profile binding, never synthetic registration placeholders. */
export function verifyBuildAttestation(value: unknown, expected: ExpectedBuildBinding, trust: OperatorTrustMaterial, observation: unknown | null, nowMs: number): BuildValidation {
 if (!exactKeys(expected, ['workspace_id', 'case_id', 'deployment_id', 'origin', 'build_digest', 'commit_sha', 'provenance_evidence_hash', 'nonce', 'plan_hash', 'observation_profile_hash', 'max_observation_age_ms']) || ![expected.plan_hash, expected.observation_profile_hash].every(item => typeof item === 'string' && digestPattern.test(item)) || typeof expected.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(expected.nonce) || !Number.isSafeInteger(expected.max_observation_age_ms) || expected.max_observation_age_ms < 1 || expected.max_observation_age_ms > MAX_DEPLOYMENT_OBSERVATION_AGE_MS) return {status: 'blocked', attestation_valid: false, deployment_status: 'blocked', reason_code: 'ATTESTATION_EXPECTED_BINDING_INVALID'};
 const {nonce: _nonce, plan_hash: _plan, observation_profile_hash: _profile, max_observation_age_ms: _age, ...initial} = expected;
 const validInitial = verifyInitialBuildAttestation(value, initial, trust, nowMs);
 if (!validInitial.attestation_valid) return validInitial;
 const attestationHash = validInitial.attestation_hash!;
 const result = (code: string, unknown = false): BuildValidation => ({status: unknown ? 'unknown' : 'blocked', attestation_valid: true, deployment_status: unknown ? 'unknown' : 'blocked', reason_code: code, attestation_hash: attestationHash});
 if (observation === null || observation === undefined) return result('INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED', true);
 if (!observationShape(observation)) return result('DEPLOYMENT_OBSERVATION_SCHEMA_INVALID');
 const observed = observation.body;
 if (observed.workspace_id !== expected.workspace_id || observed.case_id !== expected.case_id || observed.deployment_id !== expected.deployment_id || observed.origin !== expected.origin || !exactOrigin(observed.origin, trust.allow_loopback_http)) return result('DEPLOYMENT_OBSERVATION_SCOPE_MISMATCH');
 if (observed.nonce !== expected.nonce || observed.plan_hash !== expected.plan_hash || observed.observation_profile_hash !== expected.observation_profile_hash) return result('DEPLOYMENT_OBSERVATION_BINDING_MISMATCH');
 if (observed.build_digest !== expected.build_digest) return result('DEPLOYMENT_ARTIFACT_CHANGED');
 const observationTime = timeFailure(observed.observed_at, observed.expires_at, nowMs, expected.max_observation_age_ms);
 if (observationTime) return result(observationTime);
 const observer = signer(trust, observation.attester_key_id, expected, 'deployment_observation', nowMs, observed.observed_at);
 if (!observer.key) return result(observer.code!, observer.unknown);
 const observedSignature = canonicalSignature(observation.signature);
 try {if (!observedSignature || !verify(null, deploymentObservationSigningBytes(observation), observer.key.public_key, observedSignature)) return result('DEPLOYMENT_OBSERVATION_SIGNATURE_INVALID');}
 catch {return result('DEPLOYMENT_OBSERVATION_SIGNATURE_INVALID');}
 return {status: 'verified', attestation_valid: true, deployment_status: 'verified', attestation_hash: attestationHash, observation_hash: hash(observation)};
}
