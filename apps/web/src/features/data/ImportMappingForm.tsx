import {useEffect, useState, type FormEvent} from 'react';
import {ErrorNotice, Field, formError} from '../../ui';
import {addressDraft, changeAddressFormat, changeAddressText, confirmAddressFormat, mappingFromForm, parseAddress, type AddressDraft, type AddressFormat, type FieldPath, type ImportMapping} from './mapping';
import type {RecordKind} from './types';

interface SourceField {name: string; label: string; fallback?: string; required?: boolean; hint?: string}
const analyticsFields: SourceField[] = [
  {name: 'event_id_path', label: 'Event identity field', fallback: 'event_id', required: true},
  {name: 'session_id_path', label: 'Session identity field', fallback: 'session_id', required: true, hint: 'A person or account identity cannot replace a session identity.'},
  {name: 'event_time_path', label: 'Event timestamp field', fallback: 'occurred_at', required: true},
  {name: 'event_name_path', label: 'Event name field', fallback: 'event_name', required: true, hint: 'Event values are retained; choose entry and success values later in the metric.'},
  {name: 'device_path', label: 'Device field', fallback: 'device', required: true},
  {name: 'excluded_path', label: 'Exclusion field — optional', hint: 'Values must be true or false. A blank address requires explicit default review.'},
  {name: 'release_id_path', label: 'Release identity field — optional'},
];
const supportFields: SourceField[] = [
  {name: 'record_id_path', label: 'Stable record identity field', fallback: 'id', required: true},
  {name: 'text_path', label: 'Support text field', fallback: 'text', required: true},
  {name: 'event_time_path', label: 'Event timestamp field — optional', hint: 'Omit this when occurrence time is unknown; capture time never replaces it.'},
  {name: 'device_path', label: 'Device field — optional'},
];
const releaseFields: SourceField[] = [
  {name: 'record_id_path', label: 'Stable record identity field', fallback: 'id', required: true},
  {name: 'description_path', label: 'Release description field', fallback: 'description', required: true},
  {name: 'published_at_path', label: 'Published timestamp field — optional', hint: 'Publication is release metadata; it does not establish deployment or exposure.'},
  {name: 'commit_path', label: 'Reported commit/reference field — optional', hint: 'Maps an imported reported reference of at most 1,000 characters. It is unverified and does not establish an immutable build, deployment, or exposure.'},
];

function SourceAddress({field, draft, onChange}: {field: SourceField; draft: AddressDraft; onChange: (draft: AddressDraft) => void}) {
  const [confirmationError, setConfirmationError] = useState<Error | null>(null);
  let invalid = '';
  if (draft.text.trim()) {try {parseAddress(draft.text, draft.format, field.required);} catch (cause) {invalid = formError(cause).message;}}
  function confirm() {try {onChange(confirmAddressFormat(draft, field.required)); setConfirmationError(null);} catch (cause) {setConfirmationError(formError(cause));}}
  return <div>
    <Field label={field.label} hint={field.hint}><input name={field.name} value={draft.text} required={field.required} maxLength={draft.format === 'array' ? 8192 : 128} placeholder={draft.format === 'array' ? '["properties","field_name"]' : undefined} onChange={event => {onChange(changeAddressText(draft, event.target.value)); setConfirmationError(null);}} /></Field>
    <details open={draft.format === 'array' || draft.needsReview}><summary>Field address options</summary><Field label={field.label + ' address format'} hint={draft.format === 'array' ? 'Explicit JSON array, 1–8 string components. Each component names one own property; no expressions, numeric indexes, or JSONPath.' : 'Exact CSV header or top-level JSON property. Dots and brackets remain literal characters.'}><select name={field.name + '_format'} value={draft.format} onChange={event => {onChange(changeAddressFormat(draft, event.target.value as AddressFormat)); setConfirmationError(null);}}><option value="literal">Literal field name</option><option value="array">Finite JSON path array</option></select></Field></details>
    <input type="hidden" name={field.name + '_format_reviewed'} value={draft.needsReview ? 'pending' : 'reviewed'} />
    {draft.needsReview && <div className="notice warning" role="alert"><p>Address format changed. Edit or confirm the preserved field text.</p><button type="button" className="secondary" onClick={confirm}>Confirm {field.label.toLowerCase()} address</button></div>}
    {invalid && <p className="notice error" role="alert">{field.label}: {invalid}</p>}
    <ErrorNotice error={confirmationError} />
  </div>;
}

export function ImportMappingForm({kind, savedValue, savedId, revision, pending, immutable, onDirty, onApply, onRefreshRevision}: {kind: RecordKind; savedValue?: ImportMapping; savedId: string; revision: number | null; pending: boolean; immutable: boolean; onDirty: () => void; onApply: (mapping: ImportMapping) => Promise<boolean>; onRefreshRevision: () => Promise<void>}) {
  const fields = kind === 'analytics' ? analyticsFields : kind === 'support' ? supportFields : releaseFields;
  const [mode, setMode] = useState<'canonical' | 'fields'>(savedValue && savedValue.kind !== 'canonical' ? 'fields' : 'canonical'), [reviewed, setReviewed] = useState(false), [error, setError] = useState<Error | null>(null);
  const [devicePairs, setDevicePairs] = useState(savedValue?.kind === 'analytics' ? savedValue.device_map.map(pair => ({...pair})) : [{source_value: '', cohort: ''}]);
  const [addresses, setAddresses] = useState<Record<string, AddressDraft>>(() => {
    const old = savedValue && savedValue.kind === kind ? savedValue as unknown as Record<string, FieldPath | undefined> : {};
    return Object.fromEntries(fields.map(field => [field.name, addressDraft(old[field.name], field.fallback)]));
  });
  useEffect(() => setReviewed(false), [revision]);
  function changed() {setReviewed(false); setError(null); onDirty();}
  function setAddress(name: string, draft: AddressDraft) {setAddresses(previous => ({...previous, [name]: draft})); changed();}
  const unresolved = mode === 'fields' && Object.values(addresses).some(draft => draft.needsReview);
  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    try {
      const mapping = mappingFromForm(kind, mode, new FormData(event.currentTarget));
      if (await onApply(mapping)) setReviewed(false);
    } catch (cause) {setError(formError(cause));}
  }
  return <details className="mapping-editor" open={!savedId || unresolved}><summary>{savedId ? "Edit field mapping" : "Match file fields"}</summary><form onSubmit={apply}>
    <Field label="Field mapping"><select value={mode} onChange={event => {setMode(event.target.value as 'canonical' | 'fields'); changed();}} disabled={pending || immutable}><option value="canonical">Standard Faultline fields</option><option value="fields">Match my file fields</option></select></Field>
    {mode === 'canonical' ? <details><summary>Expected {kind} fields</summary><p>{kind === 'analytics' ? 'source_id, event_id, session_id, event_name, occurred_at, device, excluded, and release_id.' : kind === 'support' ? 'Stable id, event_time, and text. Unknown occurrence time stays unknown.' : 'Stable id, event_time, and text. Publication time is not deployment time.'}</p></details> : <fieldset className="mapping-fields" disabled={pending || immutable}>
      <legend>{kind === 'analytics' ? 'Event fields' : kind === 'support' ? 'Support fields' : 'Release fields'}</legend><div className="mapping-field-grid">{fields.map(field => <SourceAddress key={field.name} field={field} draft={addresses[field.name]} onChange={draft => setAddress(field.name, draft)} />)}</div>
      {kind === 'analytics' ? <><fieldset className="finite-picker"><legend>Device groups · up to 8</legend>
        {devicePairs.map((pair, index) => <div className="device-map-pair" key={index}>
          <Field label={'Source device value ' + (index + 1)}><input name="device_source" required maxLength={200} value={pair.source_value} onChange={event => {setDevicePairs(previous => previous.map((item, i) => i === index ? {...item, source_value: event.target.value} : item)); changed();}} /></Field>
          <Field label={'Group ' + (index + 1)}><input name="device_cohort" required maxLength={200} value={pair.cohort} onChange={event => {setDevicePairs(previous => previous.map((item, i) => i === index ? {...item, cohort: event.target.value} : item)); changed();}} /></Field>
          <button type="button" className="text-button danger" onClick={() => {setDevicePairs(previous => previous.filter((_, i) => i !== index)); changed();}} disabled={devicePairs.length <= 1}>Remove</button>
        </div>)}<button className="secondary" type="button" disabled={devicePairs.length >= 8} onClick={() => {setDevicePairs(previous => [...previous, {source_value: '', cohort: ''}]); changed();}}>Add device mapping</button>
        <p className="fine-print">Unmapped device values are rejected. Match source case and whitespace exactly.</p>
      </fieldset>{!addresses.excluded_path.text.trim() && <label className="review-checkbox"><input name="exclusion_default" type="checkbox" value="reviewed" required />I explicitly accept excluded=false for every imported event because no exclusion field is mapped.</label>}</> : kind === 'release' && <p className="fine-print">A reported commit or reference is unverified imported metadata. Release publication and reported references do not prove deployment or establish a controlled test build.</p>}
    </fieldset>}
    <details><summary>Date and mapping details</summary><p>Event times must use ISO timestamp text with a timezone. Times are stored with up to six fractional digits in UTC.</p><p className="fine-print">Saved mapping {savedId || 'none'} · Case revision {revision ?? 'unbound'}</p></details>
    {savedValue && <details><summary>Inspect saved finite mapping</summary><pre>{JSON.stringify(savedValue, null, 2)}</pre></details>}
    <ErrorNotice error={error} />
    {mode === 'fields' && <label className="review-checkbox"><input name="mapping_review" type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} required disabled={pending || immutable || unresolved} />I reviewed these exact field addresses, the device/exclusion policy, and timestamp precision.</label>}
    {unresolved && <p className="notice warning" role="alert">Resolve every changed address format before reviewing or saving this mapping.</p>}
    {revision === null && !immutable && <button type="button" className="secondary" disabled={pending} onClick={() => void onRefreshRevision().catch(cause => setError(formError(cause)))}>Refresh case revision for mapping review</button>}
    <button className="secondary" type="submit" disabled={pending || immutable || revision === null || unresolved || mode === 'fields' && !reviewed}>{pending ? 'Checking fields…' : savedId ? 'Save and refresh preview' : 'Save and preview'}</button>
    {immutable && <p className="notice warning">This import is queued or captured. Upload a new source revision to change mappings.</p>}
  </form></details>;
}
