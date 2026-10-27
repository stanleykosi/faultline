import { useRef, useState, type FormEvent } from 'react';
import { resource, type Workspace } from '../../api';
import { commandKey, type CommandIdentity } from '../../command-key';
import { Modal, Field, ErrorNotice, formError } from '../../ui';

export function CreateWorkspace({ csrf, onClose, onCreated }: { csrf: string; onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [pending, setPending] = useState(false); const [error, setError] = useState<Error | null>(null);
  const command = useRef<CommandIdentity>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setPending(true); setError(null);
    const body = { name: String(form.get('name')).trim() };
    try { const workspace = await resource<Workspace>('/api/v1/workspaces', { method: 'POST', csrf, body, idempotencyKey: commandKey(command, { path: '/api/v1/workspaces', method: 'POST', body }) }); command.current = null; onCreated(workspace); }
    catch (cause) { setError(formError(cause)); } finally { setPending(false); }
  }
  return <Modal title="Create workspace" onClose={onClose}><form onSubmit={submit}><ErrorNotice error={error} /><Field label="Workspace name"><input name="name" required maxLength={200} autoFocus placeholder="For example, Checkout team" /></Field><div className="form-actions"><button type="button" className="secondary" onClick={onClose} disabled={pending}>Cancel</button><button type="submit" className="primary" disabled={pending}>{pending ? 'Creating…' : 'Create workspace'}</button></div></form></Modal>;
}
