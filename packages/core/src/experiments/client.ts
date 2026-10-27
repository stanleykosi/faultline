import {demand, DomainError} from '../errors.js';
import {request, runnerKey, requireNativeFixtureMode, verifyResponse, executionScope, type RunnerExecutionScope, type RunnerContainment, type RpcPath, type RpcResponse, type RunnerCatalog, type PrepareInput, type PreparedFixture, type ExecuteInput, type ExecutedFixture} from './protocol.js';

/** HTTP/data client only: no fixture import, browser module, target code or shell. */
export class FixtureRunnerClient {
  async call<T>(path: RpcPath, payload: unknown, signal?: AbortSignal, maximum = 1024 * 1024): Promise<T> {
    requireNativeFixtureMode(); const value = process.env.RUNNER_FIXTURE_URL ?? 'http://127.0.0.1:3040', origin = new URL(value);
    demand(origin.origin === value && origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && !origin.username && !origin.password, 'INVALID_RUNNER_ENDPOINT', 'Fixture runner must be an exact authenticated loopback origin.', 503);
    const key = await runnerKey(), envelope = request(path, payload, key), timeout = AbortSignal.timeout(path === '/v1/execute' ? 605_000 : 30_000);
    let reply: Response; try {reply = await fetch(value + path, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(envelope), signal: signal ? AbortSignal.any([signal, timeout]) : timeout});} catch {throw new DomainError(signal?.aborted ? 'EXPERIMENT_CANCELLED' : 'FIXTURE_RUNNER_UNAVAILABLE', 'Private fixture runner is unavailable or the request was aborted.', 503);}
    demand(reply.headers.get('content-type')?.startsWith('application/json') && reply.body, 'INVALID_RUNNER_RESPONSE', 'Fixture runner returned an invalid response.', 503);
    let bytes = 0; const chunks: Uint8Array[] = []; for await (const chunk of reply.body) {bytes += chunk.byteLength; demand(bytes <= maximum, 'RUNNER_RESPONSE_LIMIT', 'Fixture response exceeds its frozen bound.', 503); chunks.push(chunk);}
    let parsed: RpcResponse; try {parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new DomainError('INVALID_RUNNER_RESPONSE', 'Fixture response is malformed.', 503);}
    verifyResponse(parsed, envelope.nonce, key); if (!parsed.ok) throw new DomainError(parsed.error_code ?? 'FIXTURE_RUNNER_FAILED', 'Fixture runner blocked or failed this finite request.', reply.status >= 400 ? reply.status : 422); return parsed.payload as T;
  }
  catalog() {return this.call<RunnerCatalog>('/v1/catalog', {});}
  prepare(input: PrepareInput) {return this.call<PreparedFixture>('/v1/prepare', input);}
  execute(input: ExecuteInput, signal?: AbortSignal) {return this.call<ExecutedFixture>('/v1/execute', input, signal);}
  artifact(nonce: string, sha256: string) {return this.call<{sha256: string; size_bytes: number; media_type: 'image/png'; bytes_base64: string}>('/v1/artifact', {nonce, sha256}, undefined, 15 * 1024 * 1024);}
  cancel(nonce: string, job_id: string, lease_id: string) {return this.call<{cancelled: boolean}>('/v1/cancel', {nonce, job_id, lease_id});}
  async status(scope:RunnerExecutionScope):Promise<RunnerContainment>{const result=await this.call<RunnerContainment>('/v1/status',executionScope(scope));this.containment(scope,result);return result;}
  async cleanup(scope:RunnerExecutionScope):Promise<RunnerContainment>{const result=await this.call<RunnerContainment>('/v1/cleanup',executionScope(scope));this.containment(scope,result);return result;}
  private containment(scope:RunnerExecutionScope,result:RunnerContainment){demand(result&&Object.entries(scope).every(([key,value])=>result[key as keyof RunnerExecutionScope]===value)&&typeof result.stopped==='boolean'&&['running','stopped','containment_unknown','cleanup_pending','cleaned'].includes(result.state)&&(result.terminal_proof_hash===null||/^[a-f0-9]{64}$/.test(result.terminal_proof_hash))&&(!result.stopped||['stopped','cleanup_pending','cleaned'].includes(result.state)&&result.terminal_proof_hash!==null)&&['removed','pending'].every(name=>result[name as 'removed'|'pending']===undefined||Number.isSafeInteger(result[name as 'removed'|'pending'])&&Number(result[name as 'removed'|'pending'])>=0),'INVALID_RUNNER_RESPONSE','Containment response does not attest this exact execution.',503);}
}
