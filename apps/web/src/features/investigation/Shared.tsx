import {displayLabel, evidenceSummary, plainSummary} from '../../plain-language';
import {useCallback, useRef} from 'react';
import {resource} from '../../api';
import {commandKey, type CommandIdentity} from '../../command-key';
import {Status} from '../../ui';
import type {Binding, Evidence} from './types';

export function useCommand(csrf: string) {
  const identities = useRef<Record<string, {current: CommandIdentity}>>({});
  return useCallback(async function send<T>(path: string, body: unknown, method = 'POST', revision?: number): Promise<T> {
    const slot = `${method}:${path}`, reference = identities.current[slot] ??= {current: null};
    const value = await resource<T>(path, {method, body, csrf, revision, idempotencyKey: commandKey(reference, {path, method, body: body ?? null, revision: revision ?? null})});
    reference.current = null; return value;
  }, [csrf]);
}

export function EvidencePicker({evidence, name, label, defaultIds = [], required = false}: {evidence: Evidence[]; name: string; label: string; defaultIds?: string[]; required?: boolean}) {
  const available = evidence.filter(item => item.redaction_status === 'sanitized'), unavailable = defaultIds.filter(id => !available.some(item => item.id === id));
  return <fieldset className="finite-picker"><legend>{label}{required ? ' — select at least one' : ''}</legend>{available.length ? available.map(item => <label className="picker-choice" key={item.id}><input type="checkbox" name={name} value={item.id} defaultChecked={defaultIds.includes(item.id)} /><span><strong>{displayLabel(item.source_kind)}</strong> {evidenceSummary(item).slice(0, 180)}<small>{item.id}</small></span></label>) : <p className="muted">No accessible sanitized evidence is available. Review a restricted record in Evidence to create a sanitized version.</p>}{unavailable.map(id => <div className="notice warning" key={id}>Selected citation {id} is unavailable for a new reviewed use. Resolve it explicitly before saving.<label className="picker-choice"><input type="checkbox" name={name} value={id} defaultChecked /><span>Retain this reference (clear to remove it explicitly)</span></label></div>)}<p className="fine-print">Only accessible sanitized evidence can be selected for shared citations and analytic plans.</p></fieldset>;
}

export function BindingSummary({binding}: {binding: Binding}) {return <details className="binding-inspector"><summary>Input details</summary><dl><div><dt>Input revision</dt><dd>{binding.revision_id}</dd></div><div><dt>Metric hash</dt><dd>{binding.metric_hash}</dd></div><div><dt>Snapshot hash</dt><dd>{binding.snapshot_hash}</dd></div></dl></details>;}

export function EvidenceReferences({ids, evidence}: {ids: string[]; evidence: Evidence[]}) {return <ul className="citation-list">{ids.map(id => {const item = evidence.find(entry => entry.id === id); return <li key={id}><code>{id}</code> <Status tone={item?.redaction_status === 'sanitized' ? 'muted' : 'warning'}>{item?.redaction_status ?? 'unavailable'}</Status>{item?.redaction_status === 'sanitized' && <p>{evidenceSummary(item).slice(0, 280)}</p>}</li>;})}</ul>;}
