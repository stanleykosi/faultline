import {hash, now} from '../../canonical.js';
import {normalizeEventTime} from '../../imports/time.js';
import {validateContract} from '../../../../contracts/src/validate.js';
import type {FaultlineConnectorCapabilities} from '../../../../contracts/src/generated.js';
import {approvedHttps, checkActive, ConnectorError, getWire, header, object, requireSuccess, requireWire, strictJson, text, wireFingerprint, type ExecutionControl, type SafeHttp, type WireResponse} from '../wire.js';

export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_ADAPTER_VERSION = 'github-selected-change-v1';
const origin = 'https://api.github.com'; const shaPattern = /^[a-f0-9]{40}$/i;
export interface GitHubConfig {owner: string; repository: string; repository_id: number; token: string; source_id: string; workspace_id: string;}
export interface GitHubCaptureRequest {ref: string; from: string; to: string; release_time_field: 'created_at' | 'published_at'; include_pull_requests?: boolean; max_pages?: number; max_records?: number; max_page_bytes?: number;}
export interface CapturedPage {resource: 'commits' | 'releases' | 'pull_requests'; page_url: string; body_hash: string; request_id: string | null; etag: string | null; captured_at: string; raw_bytes: Buffer; boundary_recheck: boolean;}
export interface GitHubCaptureControl extends ExecutionControl {onPage?: (page: CapturedPage) => Promise<void>;}
export interface CommitChange {kind: 'commit'; repository_id: number; sha: string; source_url: string; author_at: string | null; committed_at: string | null; message: string; text_truncated: boolean; normalized_hash: string; raw_hash: string; deployment_at: null;}
export interface ReleaseChange {kind: 'release'; repository_id: number; id: number; source_url: string; tag_name: string; target_commitish: string; created_at: string; published_at: string | null; draft: boolean; prerelease: boolean; body: string; text_truncated: boolean; normalized_hash: string; raw_hash: string; deployment_at: null;}
export interface PullChange {kind: 'pull_request'; repository_id: number; id: number; number: number; source_url: string; state: 'open' | 'closed'; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null; base_sha: string; head_sha: string; merge_commit_sha: string | null; title: string; body: string; text_truncated: boolean; normalized_hash: string; raw_hash: string; deployment_at: null;}
export type Change = CommitChange | ReleaseChange | PullChange;
export interface ResourceCapture<T extends Change = Change> {state: 'complete' | 'partial' | 'changed' | 'unavailable' | 'excluded'; records: T[]; pages: number; reason_code: string | null;}
export interface GitHubCapture {
  adapter_version: string; api_version: string; workspace_id: string; source_id: string; repository_id: number; repository_full_name: string;
  resolved_sha: string; requested_ref: string; requested_from: string; requested_to: string; captured_start: string; captured_end: string; input_hash: string;
  commits: ResourceCapture<CommitChange>; releases: ResourceCapture<ReleaseChange>; pull_requests: ResourceCapture<PullChange>; pages: CapturedPage[];
  state: 'complete' | 'partial' | 'changed'; deployment_evidence: 'not_established'; limitations: string[];
}
function timestamp(value: unknown, nullable = false): string | null {if (nullable && value === null) return null; const normalized = normalizeEventTime(value); requireWire(normalized.slice(23, 26) === '000', 'UNSUPPORTED_METADATA_PRECISION', 'GitHub metadata cannot be silently rounded.'); return normalized.slice(0, 23) + 'Z';}
function identity(value: unknown, field: string): number {requireWire(Number.isSafeInteger(value) && (value as number) > 0, 'INVALID_GITHUB_IDENTITY', `GitHub ${field} must be a positive stable integer.`); return value as number;}
function sha(value: unknown, nullable = false): string | null {if (nullable && value === null) return null; requireWire(typeof value === 'string' && shaPattern.test(value), 'INVALID_GITHUB_SHA', 'GitHub commit identities must be full immutable SHAs.'); return value.toLowerCase();}
function boundedText(value: unknown, nullable = false): {value: string; truncated: boolean} {if (nullable && value === null) return {value: '', truncated: false}; requireWire(typeof value === 'string', 'INVALID_PROVIDER_SCHEMA', 'GitHub evidence text must be a string or documented null.'); return {value: value.slice(0, 8000), truncated: value.length > 8000};}
function sourceUrl(value: unknown, fullName: string, suffix: string): string {const url = approvedHttps(text(value, 'source_url', 2000), ['https://github.com']); requireWire(url.pathname.toLowerCase() === `/${fullName}/${suffix}`.toLowerCase() && !url.search, 'INVALID_GITHUB_SOURCE_URL', 'GitHub evidence link is outside the selected repository/resource.'); return url.href;}
function repositorySegment(value: string) {requireWire(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && !['.', '..'].includes(value), 'INVALID_REPOSITORY', 'GitHub requires one exact owner and repository name.'); return value;}

/** Validate the next link against frozen endpoint/query bindings before forwarding credentials. */
export function githubNextLink(value: string | undefined, endpoint: URL): string | null {
  if (!value) return null; requireWire(value.length <= 8192, 'INVALID_GITHUB_PAGINATION', 'GitHub pagination header exceeds its finite limit.'); let next: string | null = null;
  for (const part of value.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>\s*((?:;\s*[^,]+)*)\s*$/.exec(part); requireWire(match, 'INVALID_GITHUB_PAGINATION', 'GitHub returned a malformed Link header.');
    const relation = /(?:^|;)\s*rel\s*=\s*"([^"]+)"(?:;|$)/.exec(match[2]!); requireWire(relation, 'INVALID_GITHUB_PAGINATION', 'GitHub Link relations must be explicit.');
    if (!relation[1]!.split(/\s+/).includes('next')) continue;
    requireWire(next === null, 'INVALID_GITHUB_PAGINATION', 'GitHub returned more than one next page.'); const url = approvedHttps(match[1]!, [origin]);
    requireWire(url.pathname === endpoint.pathname, 'UNSAFE_GITHUB_PAGINATION', 'GitHub pagination changed the selected repository or endpoint.');
    const allowed = new Set([...endpoint.searchParams.keys(), 'page']);
    for (const key of url.searchParams.keys()) requireWire(allowed.has(key) && url.searchParams.getAll(key).length === 1, 'UNSAFE_GITHUB_PAGINATION', 'GitHub pagination changed an allowed query key.');
    for (const [key, bound] of endpoint.searchParams) requireWire(url.searchParams.get(key) === bound, 'UNSAFE_GITHUB_PAGINATION', 'GitHub pagination changed a frozen capture parameter.');
    requireWire(/^[1-9]\d{0,4}$/.test(url.searchParams.get('page') ?? ''), 'INVALID_GITHUB_PAGINATION', 'GitHub pagination requires a finite positive page identity.'); next = url.href;
  }
  return next;
}

export class GitHubChangesClient {
  private path: string;
  constructor(private http: SafeHttp, private config: GitHubConfig) {this.path = `/repos/${repositorySegment(config.owner)}/${repositorySegment(config.repository)}`; identity(config.repository_id, 'repository_id'); text(config.token, 'credential', 4096); requireWire(/^[^\s\x00-\x1f\x7f]+$/.test(config.token), 'INVALID_PROVIDER_CREDENTIAL', 'The provider credential has an invalid header representation.'); this.config = {...config};}
  private async read(url: string, control: ExecutionControl = {}, maxBytes = 1_048_576): Promise<WireResponse> {approvedHttps(url, [origin]); const response = await getWire(this.http, url, {headers: {Authorization: `Bearer ${this.config.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Faultline/1 read-only-change-capture', 'X-GitHub-Api-Version': GITHUB_API_VERSION}, allowedOrigins: [origin], maxBytes}, control); requireSuccess(response, true); return response;}
  private async repository(control: ExecutionControl = {}) {
    const response = await this.read(`${origin}${this.path}`, control); const value = object(strictJson(response.body));
    requireWire(identity(value.id, 'repository_id') === this.config.repository_id, 'GITHUB_REPOSITORY_MISMATCH', 'The provider repository identity differs from the selected repository.'); const fullName = text(value.full_name, 'full_name', 201);
    const parts = fullName.split('/'); requireWire(parts.length === 2, 'INVALID_REPOSITORY', 'Provider repository name is malformed.'); repositorySegment(parts[0]!); repositorySegment(parts[1]!);
    return {fullName, path: `/repos/${fullName}`, defaultBranch: text(value.default_branch, 'default_branch', 255)};
  }
  private async resolve(path: string, ref: string, control: ExecutionControl = {}): Promise<string> {text(ref, 'ref', 255); const value = object(strictJson((await this.read(`${origin}${path}/commits/${encodeURIComponent(ref)}`, control)).body)); return sha(value.sha)!;}
  async probe(): Promise<FaultlineConnectorCapabilities> {
    const features: string[] = []; const unsupported: string[] = ['repository_writes', 'repository_code_execution', 'deployment_attestation']; let status: FaultlineConnectorCapabilities['status'] = 'available'; let reason: string | null = null;
    try {const selected = await this.repository(); features.push('selected_repository_metadata'); await this.resolve(selected.path, selected.defaultBranch); features.push('immutable_commit_resolution');
      for (const [endpoint, feature] of [['releases', 'release_metadata'], ['pulls?state=all', 'pull_request_metadata']] as const) {
        try {const separator = endpoint.includes('?') ? '&' : '?'; const value = strictJson((await this.read(`${origin}${selected.path}/${endpoint}${separator}per_page=1`)).body); requireWire(Array.isArray(value), 'INVALID_PROVIDER_SCHEMA', 'GitHub list capability probe returned a non-list response.'); features.push(feature);}
        catch (error) {if (error instanceof ConnectorError && error.code === 'PROVIDER_UNAUTHORIZED') {unsupported.push(feature); status = 'unauthorized'; reason = error.code;} else throw error;}
      }
    } catch (error) {reason = error instanceof ConnectorError ? error.code : 'INVALID_PROVIDER_SCHEMA'; status = reason === 'PROVIDER_UNAUTHORIZED' ? 'unauthorized' : ['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED'].includes(reason) ? 'unavailable' : 'unsupported';}
    return validateContract('connector-capabilities', {schema_version: 1, source_kind: 'github_changes', status, checked_at: now(), adapter_version: GITHUB_ADAPTER_VERSION, read_only: true, features, unsupported_features: unsupported, reason_code: reason, provider_version: GITHUB_API_VERSION});
  }
  async capture(request: GitHubCaptureRequest, control: GitHubCaptureControl = {}): Promise<GitHubCapture> {
    const from = timestamp(request.from)!, to = timestamp(request.to)!; requireWire(from < to && Date.parse(from) >= Date.parse('1970-01-01T00:00:00Z') && Date.parse(to) <= Date.parse('2099-12-31T23:59:59Z'), 'INVALID_CHANGE_INTERVAL', 'GitHub capture requires ordered supported timestamp bounds.');
    requireWire(['created_at', 'published_at'].includes(request.release_time_field), 'INVALID_RELEASE_TIME_FIELD', 'Choose the release timestamp used for local interval filtering.');
    const maxPages = request.max_pages ?? 50, maxRecords = request.max_records ?? 100_000, maxPageBytes = request.max_page_bytes ?? 1_048_576;
    requireWire(Number.isSafeInteger(maxPages) && maxPages > 0 && maxPages <= 50 && Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 100_000 && Number.isSafeInteger(maxPageBytes) && maxPageBytes > 0 && maxPageBytes <= 1_048_576, 'INVALID_CAPTURE_LIMIT', 'GitHub capture limits can only tighten the configured ceilings.');
    const capturedStart = now(), selected = await this.repository(control), resolved = await this.resolve(selected.path, request.ref, control), pages: CapturedPage[] = []; let totalRecords = 0;
    const normalize = (resource: CapturedPage['resource'], raw: unknown): Change => {
      const row = object(raw), rawHash = hash(row), repositoryId = this.config.repository_id;
      if (resource === 'commits') {const commitSha = sha(row.sha)!, commit = object(row.commit), author = commit.author === null ? null : object(commit.author), committer = commit.committer === null ? null : object(commit.committer), message = boundedText(commit.message); const value = {kind: 'commit' as const, repository_id: repositoryId, sha: commitSha, source_url: sourceUrl(row.html_url, selected.fullName, `commit/${commitSha}`), author_at: author ? timestamp(author.date, true) : null, committed_at: committer ? timestamp(committer.date, true) : null, message: message.value, text_truncated: message.truncated, deployment_at: null}; return {...value, raw_hash: rawHash, normalized_hash: hash(value)};}
      if (resource === 'releases') {const id = identity(row.id, 'release_id'), body = boundedText(row.body, true), tag = text(row.tag_name, 'tag_name', 255); requireWire(typeof row.draft === 'boolean' && typeof row.prerelease === 'boolean', 'INVALID_PROVIDER_SCHEMA', 'GitHub release flags must be explicit booleans.'); const url = approvedHttps(text(row.html_url, 'html_url'), ['https://github.com']); requireWire(url.pathname.startsWith(`/${selected.fullName}/releases/`) && !url.search, 'INVALID_GITHUB_SOURCE_URL', 'Release source URL is outside the selected repository.'); const value = {kind: 'release' as const, repository_id: repositoryId, id, source_url: url.href, tag_name: tag, target_commitish: text(row.target_commitish, 'target_commitish', 255), created_at: timestamp(row.created_at)!, published_at: timestamp(row.published_at, true), draft: row.draft, prerelease: row.prerelease, body: body.value, text_truncated: body.truncated, deployment_at: null}; return {...value, raw_hash: rawHash, normalized_hash: hash(value)};}
      const id = identity(row.id, 'pull_request_id'), number = identity(row.number, 'pull_request_number'), body = boundedText(row.body, true), titleValue = boundedText(row.title); requireWire(row.state === 'open' || row.state === 'closed', 'INVALID_PROVIDER_SCHEMA', 'GitHub pull request state is outside the supported profile.'); const value = {kind: 'pull_request' as const, repository_id: repositoryId, id, number, source_url: sourceUrl(row.html_url, selected.fullName, `pull/${number}`), state: row.state as 'open' | 'closed', created_at: timestamp(row.created_at)!, updated_at: timestamp(row.updated_at)!, closed_at: timestamp(row.closed_at, true), merged_at: timestamp(row.merged_at, true), base_sha: sha(object(row.base).sha)!, head_sha: sha(object(row.head).sha)!, merge_commit_sha: sha(row.merge_commit_sha, true), title: titleValue.value, body: body.value, text_truncated: body.truncated || titleValue.truncated, deployment_at: null}; return {...value, raw_hash: rawHash, normalized_hash: hash(value)};
    };
    const scan = async (resource: CapturedPage['resource'], endpoint: URL): Promise<ResourceCapture> => {
      const seenLinks = new Set<string>(), fingerprints = new Set<string>(), identities = new Map<string, string>(); const records: Change[] = [], boundary: {url: string; hash: string}[] = []; let url: string | null = endpoint.href, count = 0, changed = false;
      while (url && count < maxPages) {
        requireWire(!seenLinks.has(url), 'GITHUB_PAGINATION_LOOP', 'GitHub repeated a next page.'); seenLinks.add(url); const response = await this.read(url, control, maxPageBytes); const fingerprint = wireFingerprint(response);
        requireWire(!fingerprints.has(fingerprint.body_hash), 'GITHUB_PAGINATION_LOOP', 'GitHub repeated a page body while paging.'); fingerprints.add(fingerprint.body_hash); const list = strictJson(response.body, maxPageBytes); requireWire(Array.isArray(list) && list.length <= 100, 'INVALID_PROVIDER_SCHEMA', 'GitHub list response exceeds its documented page size or has the wrong shape.');
        const capturedPage = {resource, page_url: url, ...fingerprint, captured_at: now(), raw_bytes: response.body, boundary_recheck: false};
        pages.push(capturedPage); await control.onPage?.(capturedPage); await checkActive(control); boundary.push({url, hash: fingerprint.body_hash}); count++;
        for (const raw of list) {totalRecords++; requireWire(totalRecords <= maxRecords, 'GITHUB_RECORD_LIMIT', 'GitHub capture exceeds the total raw resource cap.'); const record = normalize(resource, raw), key = record.kind === 'commit' ? record.sha : String(record.id), previous = identities.get(key); if (previous) {if (previous !== record.normalized_hash) changed = true; continue;} identities.set(key, record.normalized_hash);
          const times = record.kind === 'commit' ? [record.author_at, record.committed_at] : record.kind === 'release' ? [record[request.release_time_field]] : [record.created_at, record.updated_at, record.closed_at, record.merged_at];
          if (times.some(time => time !== null && time >= from && time < to)) records.push(record);
        }
        url = githubNextLink(header(response, 'link'), endpoint);
      }
      if (resource === 'pull_requests') {
        const checks = boundary.length > 1 ? [boundary[0]!, boundary.at(-1)!] : boundary;
        for (const first of checks) {const response = await this.read(first.url, control, maxPageBytes), fingerprint = wireFingerprint(response); strictJson(response.body, maxPageBytes); const capturedPage = {resource, page_url: first.url, ...fingerprint, captured_at: now(), raw_bytes: response.body, boundary_recheck: true}; pages.push(capturedPage); await control.onPage?.(capturedPage); await checkActive(control); if (fingerprint.body_hash !== first.hash) changed = true;}
      }
      return {state: changed ? 'changed' : url ? 'partial' : 'complete', records, pages: count, reason_code: changed ? 'GITHUB_RESOURCE_CHANGED' : url ? 'GITHUB_PAGE_CAP' : null};
    };
    const commitsUrl = new URL(`${origin}${selected.path}/commits`); commitsUrl.search = new URLSearchParams({sha: resolved, since: from, until: to, per_page: '100'}).toString();
    const releasesUrl = new URL(`${origin}${selected.path}/releases?per_page=100`), pullsUrl = new URL(`${origin}${selected.path}/pulls?state=all&sort=updated&direction=desc&per_page=100`);
    const commits = await scan('commits', commitsUrl) as ResourceCapture<CommitChange>, releases = await scan('releases', releasesUrl) as ResourceCapture<ReleaseChange>;
    let pulls: ResourceCapture<PullChange>;
    requireWire(request.include_pull_requests===undefined||typeof request.include_pull_requests==='boolean','INVALID_CAPTURE','Pull-request inclusion must be an explicit boolean.');
    if(request.include_pull_requests===false)pulls={state:'excluded',records:[],pages:0,reason_code:'NOT_REQUESTED'};
    else try {pulls = await scan('pull_requests', pullsUrl) as ResourceCapture<PullChange>;} catch (error) {if (error instanceof ConnectorError && ['PROVIDER_UNAUTHORIZED', 'PROVIDER_NOT_FOUND'].includes(error.code)) pulls = {state: 'unavailable', records: [], pages: 0, reason_code: error.code}; else throw error;}
    await checkActive(control);
    const states = [commits.state, releases.state, ...(request.include_pull_requests===false?[]:[pulls.state])]; const state = states.includes('changed') ? 'changed' : states.some(value => value !== 'complete') ? 'partial' : 'complete';
    return {adapter_version: GITHUB_ADAPTER_VERSION, api_version: GITHUB_API_VERSION, workspace_id: this.config.workspace_id, source_id: this.config.source_id, repository_id: this.config.repository_id, repository_full_name: selected.fullName, resolved_sha: resolved, requested_ref: request.ref, requested_from: from, requested_to: to, captured_start: capturedStart, captured_end: now(), input_hash: hash({request, repository_id: this.config.repository_id, resolved_sha: resolved}), commits, releases, pull_requests: pulls, pages, state, deployment_evidence: 'not_established', limitations: ['GitHub REST resources are not a cross-resource transactional snapshot.', 'Author, commit, publication, and merge timestamps are not deployment timestamps.', 'The selected history and bounded interval do not guarantee every relevant runtime change.', ...state === 'complete' ? [] : ['One or more resources have incomplete, unavailable, or changed coverage.']]};
  }
}
