import {ApiError, resource, type Session, type Workspace} from './api';

// Only reads use this deadline. An ambiguous mutation must keep its command identity.
export async function boundedResource<T>(path: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {controller.abort(); reject(new DOMException('The read was cancelled.', 'AbortError'));};
    signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => {controller.abort(); reject(new ApiError(0, 'READ_TIMEOUT', 'The recorded information did not arrive in time. Its state remains unavailable; refresh to try again.'));}, timeoutMs);
  });
  try {
    const value = await Promise.race([resource<T>(path, {signal: controller.signal}), interrupted]);
    signal?.throwIfAborted();
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export async function readAccount(signal: AbortSignal): Promise<{session: Session; workspaces: Workspace[]}> {
  // Both endpoints authenticate independently. Publish neither until both succeed.
  signal.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, {once: true});
  try {
    const [session, workspaces] = await Promise.all([
      boundedResource<Session>('/api/v1/session', controller.signal),
      boundedResource<Workspace[]>('/api/v1/workspaces', controller.signal)
    ]);
    signal.throwIfAborted();
    if (typeof session?.user?.id !== 'string' || !session.user.id || typeof session.user.email !== 'string' || typeof session.csrf_token !== 'string' || !session.csrf_token) throw new Error('The current session response was unavailable. Reconnect before using workspace controls.');
    if (!isWorkspaceList(workspaces)) throw new Error('The permitted workspace list was unavailable. Reconnect before using workspace controls.');
    return {session, workspaces};
  } finally {controller.abort(); signal.removeEventListener('abort', abort);}
}

// Call only after a successful authentication mutation. Retry the whole read so
// session and workspace permissions always come from the same validated attempt.
export async function readAccountAfterAuthentication(signal: AbortSignal, onRetry?: () => void): Promise<{session: Session; workspaces: Workspace[]}> {
  try {return await readAccount(signal);}
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ApiError) || error.status === 401 || error.status === 403 ||
      !((error.status === 0 && ['READ_TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code)) || [502, 503, 504].includes(error.status))) throw error;
    onRetry?.();
    signal.throwIfAborted();
    return readAccount(signal);
  }
}

export function isWorkspaceList(value: unknown): value is Workspace[] {
  return Array.isArray(value) && value.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && ['owner', 'analyst', 'viewer'].includes(item.role) && Number.isInteger(item.revision));
}
