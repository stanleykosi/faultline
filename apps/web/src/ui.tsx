import {displayLabel, plainSummary} from './plain-language';
import { useEffect, useRef, useId, cloneElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { ApiError } from './api';
import {restoreFocus, trapFocus} from './focus';

export function ErrorNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  const staleReview = error instanceof ApiError && error.status === 409 && /STALE|REVISION|CHANGED|REVIEW_EXPIRED/.test(error.code);
  return <div className="notice error" role="alert"><strong>{staleReview ? 'This page changed' : 'Couldn’t complete that'}</strong><p>{plainSummary(error.message)}</p>{error instanceof ApiError && error.fields.length > 0 && <ul>{error.fields.map((field, i) => <li key={i}>{displayLabel(field.field)}: {plainSummary(field.message)}</li>)}</ul>}{staleReview && <p>Refresh and try again.</p>}{error instanceof ApiError && error.requestId && <details className="technical-details"><summary>Details</summary><small>Request ID: {error.requestId}</small></details>}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) { return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>; }
export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'muted' | 'warning' | 'good' }) { return <span className={`status ${tone}`}>{typeof children === 'string' ? displayLabel(children) : children}</span>; }
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty"><h2>{title}</h2><p>{children}</p>{action}</div>; }

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {const current = dialog.current, trigger = document.activeElement; current?.showModal(); return () => {current?.close(); restoreFocus(trigger);};}, []);
  return <dialog ref={dialog} className="modal" onKeyDown={event => {if (dialog.current) trapFocus(event, dialog.current);}} onCancel={event => {event.preventDefault(); onClose();}} aria-label={title}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></div>{children}</dialog>;
}

export function Field({label,hint,children}:{label:string;hint?:string;children:ReactNode}){
 const generated=useId(),element=isValidElement(children)?children as ReactElement<{id?:string;'aria-describedby'?:string}>:null,id=element?.props.id??generated,hintId=id+'-hint';
 return <div className="field"><label htmlFor={id}>{label}</label>{element?cloneElement(element,{id,...(hint?{'aria-describedby':[element.props['aria-describedby'],hintId].filter(Boolean).join(' ')}:{})}):children}{hint&&<small id={hintId}>{hint}</small>}</div>;
}
export function formError(error: unknown): Error { return error instanceof Error ? error : new Error('The action could not be completed.'); }
export function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
