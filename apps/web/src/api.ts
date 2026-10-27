export type Role = 'owner' | 'analyst' | 'viewer';
export type Workspace = { id: string; name: string; created_at: string; role: Role; revision: number };
export type Investigation = { id: string; workspace_id: string; title: string; question: string; affected_flow: string; active_revision_id: string; lifecycle: string; archived: boolean; revision: number; created_at: string; updated_at: string; disposition?: 'resolved' | 'unresolved' | 'no_issue' | null; disposition_note?: string | null };
export type Session = { user: { id: string; name: string; email: string }; csrf_token: string };
export type Member = { id: string; workspace_id: string; user_id: string; name: string; email: string; role: Role; revision: number };
export type Invitation = { id: string; workspace_id: string; intended_email: string; role: 'analyst' | 'viewer'; expires_at: string; revision: number; token: string };
export type InvitationClaim = { status: 'claimed' | 'enrollment_required'; workspace_id?: string; intended_email?: string; intended_name?: string };
export type Envelope<T> = { data: T; meta: { request_id: string }; page?: { next_cursor: string | null } };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public fields: { field: string; message: string }[] = []) { super(message); }
}

export async function request<T>(path: string, options: { method?: string; body?: unknown; csrf?: string; revision?: number | string; signal?: AbortSignal; idempotencyKey?: string; deletionReviewToken?: string } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
  }
  if (options.revision !== undefined) headers['X-Faultline-Revision'] = String(options.revision);
  if (options.deletionReviewToken !== undefined) headers['X-Deletion-Review-Token'] = options.deletionReviewToken;
  let response: Response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : multipart ? options.body as FormData : JSON.stringify(options.body), signal: options.signal }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_UNAVAILABLE', 'Faultline could not reach the server. Check the connection and try again.');
  }
  const value = response.status === 204 ? undefined : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, value?.error?.code ?? value?.code ?? 'REQUEST_FAILED', value?.error?.message ?? value?.message ?? `The request failed (${response.status}).`, value?.meta?.request_id, value?.error?.field_errors ?? []);
  return value as T;
}

export async function resource<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  const envelope = await request<Envelope<T>>(path, options);
  return envelope?.data;
}

export function workspacePath(id: string): string { return `/api/v1/workspaces/${encodeURIComponent(id)}`; }
export function casePath(workspaceId: string, caseId: string): string { return `${workspacePath(workspaceId)}/cases/${encodeURIComponent(caseId)}`; }
