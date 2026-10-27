import {useEffect, useRef, useState} from 'react';
import {resource, workspacePath} from '../../api';
import {ErrorNotice, Loading, Status, formError} from '../../ui';
import type {ProviderOperation} from './types';

export function OperationPanel({workspaceId, operationId, onSettled}: {workspaceId: string; operationId: string; onSettled: () => Promise<void>}) {
  const [operation, setOperation] = useState<ProviderOperation | null>(null), [error, setError] = useState<Error | null>(null), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0), settled = useRef(new Set<string>());
  useEffect(() => {setOperation(null); if (!operationId) return; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {setPending(true); setError(null); try {const value = await resource<ProviderOperation>(`${workspacePath(workspaceId)}/provider-operations/${encodeURIComponent(operationId)}`, {signal: controller.signal}); if (!value?.id || value.id !== operationId) throw new Error('The provider operation identity was unavailable.'); if (!controller.signal.aborted) {setOperation(value); if (['queued', 'running', 'cancel_requested'].includes(value.status)) timer = setTimeout(read, 2500); else if (!settled.current.has(value.id)) {settled.current.add(value.id); void onSettled();}}} catch (cause) {if (!controller.signal.aborted) setError(formError(cause));} finally {if (!controller.signal.aborted) setPending(false);}}
    void read(); return () => {controller.abort(); if (timer) clearTimeout(timer);};
  }, [workspaceId, operationId, refresh]);
  if (!operationId) return null;
  return <section className="panel"><div className="section-heading"><h2>Connection check</h2><Status tone={operation?.status === 'succeeded' ? 'muted' : 'warning'}>{operation?.status ?? 'Unknown'}</Status></div><ErrorNotice error={error} />{pending && !operation ? <Loading label="Checking connection…" /> : operation ? <><p>{operation.kind.replaceAll('_', ' ')} · Attempt {operation.attempt} · {operation.updated_at}</p>{operation.error_code && <p className="notice warning">{operation.error_code}</p>}<details><summary>Check details</summary>{operation.result && <pre>{JSON.stringify(operation.result, null, 2)}</pre>}<p>Operation {operation.id} · Resource {operation.resource_id}</p></details></> : <p className="muted">Connection check unavailable.</p>}<button className="secondary" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh</button></section>;
}
