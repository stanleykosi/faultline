import {useEffect, useState, type FormEvent} from 'react';
import {ApiError, resource, workspacePath, type Workspace} from '../../api';
import {ErrorNotice, Field, Modal, Status, formError} from '../../ui';
import {useCommand} from '../investigation/Shared';

export function workspaceRename(value: string, current: string) {
  const name = value.trim();
  if (!name || name.length > 200) throw new Error('Enter a workspace name from 1 to 200 characters.');
  if (name === current) throw new Error('Enter a different workspace name before reviewing.');
  return name;
}

export function WorkspaceGeneral({workspace, csrf, onChanged}: {workspace: Workspace; csrf: string; onChanged: () => Promise<void>}) {
  const send = useCommand(csrf), [record, setRecord] = useState(workspace), [name, setName] = useState(''), [review, setReview] = useState<{name:string;revision:number;previous:string} | null>(null), [pending,setPending] = useState(false), [error,setError] = useState<Error|null>(null), [notice,setNotice] = useState('');
  useEffect(() => {setRecord(workspace);}, [workspace]);
  const owner = record.role === 'owner';
  async function refresh() {setPending(true); setError(null); try {const latest = await resource<Workspace>(workspacePath(workspace.id)); if (!latest?.id || latest.id !== workspace.id) throw Error('The current workspace record was unavailable.'); setRecord(latest); await onChanged();} catch(cause) {setError(formError(cause));} finally {setPending(false);}}
  function prepare(event: FormEvent) {event.preventDefault(); setError(null); setNotice(''); try {setReview({name:workspaceRename(name,record.name), revision:record.revision, previous:record.name});} catch(cause) {setError(formError(cause));}}
  async function save(event: FormEvent) {
    event.preventDefault(); if (!review || !owner) return;
    setPending(true); setError(null);
    try {
      const saved = await send<Workspace>(workspacePath(workspace.id),{name:review.name},'PATCH',review.revision);
      if (saved?.id !== workspace.id || saved.name !== review.name) throw Error('No matching saved workspace name was returned. Refresh before retrying.');
      setRecord(saved); setName(''); setReview(null); setNotice('Workspace name saved.'); await onChanged();
    } catch(cause) {
      setError(formError(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        setReview(null); // Retain the proposed edit, but require a new review of current authority/revision.
        try {setRecord(await resource<Workspace>(workspacePath(workspace.id))); await onChanged();} catch {setNotice('Latest workspace could not be refreshed. Refresh before reviewing again.');}
      }
    } finally {setPending(false);}
  }
  return <><div className="page-heading"><div><h1>Workspace<span className="heading-dot">.</span></h1></div><button className="secondary" disabled={pending} onClick={() => void refresh()}>Refresh</button></div><ErrorNotice error={error}/>{notice && <p role="status">{notice}</p>}<section className="panel"><div className="section-heading"><h2>{record.name}</h2><Status>{record.role}</Status></div><details><summary>Workspace details</summary><p className="fine-print">ID {record.id} · Version {record.revision}</p></details>{owner ? <form onSubmit={prepare}><Field label="New name"><input value={name} onChange={event => setName(event.target.value)} required maxLength={200} disabled={pending}/></Field><button className="primary" disabled={pending}>Review change</button></form> : <p className="notice">Only an owner can rename this workspace.</p>}</section>{review && <Modal title="Rename workspace" onClose={() => {if (!pending) setReview(null);}}><form onSubmit={save}><ErrorNotice error={error}/><dl><dt>Current name</dt><dd>{review.previous}</dd><dt>New name</dt><dd>{review.name}</dd></dl><label className="review-checkbox"><input type="checkbox" required disabled={pending}/>I checked this name change.</label><div className="form-actions"><button type="button" className="secondary" disabled={pending} onClick={() => setReview(null)}>Cancel</button><button className="primary" disabled={pending}>{pending ? 'Saving…' : 'Save name'}</button></div></form></Modal>}</>;
}
