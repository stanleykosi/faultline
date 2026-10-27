import {useRef,useState,type FormEvent} from 'react';
import {resource,type Investigation} from '../../api';
import {ErrorNotice,Field,Status,formError} from '../../ui';
import {useCommand} from './Shared';
import type {Evidence} from './types';

interface RedactionRow {id:string;redaction:{text:string;output_hash:string;counts:{emails:number;secrets:number;phones:number};limitations:string[]};}
interface Preview {preview_id:string;preview_hash:string;revision_id:string;review_status:string;binding:{policy_version:string};rows:RedactionRow[];limitations:string[];}
interface Job {id:string;kind:string;status:string;error_code?:string|null;result:Preview|{derivatives:{id:string;supersedes_id:string}[]}|null;}
const finiteId=/^[a-f0-9-]{36}$/i,sha=/^[a-f0-9]{64}$/;
export function reviewedRedaction(preview:Preview|null,reviewed:boolean,reason:string){
 if(!preview||preview.review_status!=='preview_only'||!finiteId.test(preview.preview_id)||!finiteId.test(preview.revision_id)||!sha.test(preview.preview_hash)||preview.binding.policy_version!=='contact-secrets-v1'||!preview.rows.length||preview.rows.length>100)throw Error('Read a complete supported redaction preview before approving it.');
 if(!reviewed||!reason.trim()||reason.length>2000)throw Error('Review every minimized excerpt and explain this approval.');
 return {preview_id:preview.preview_id,reason:reason.trim()};
}
export function RedactionPanel({base,csrf,evidence,canMutate,onChanged}:{base:string;csrf:string;evidence:Evidence[];canMutate:boolean;onChanged:()=>Promise<void>}){
 const send=useCommand(csrf),busy=useRef(false),[selected,setSelected]=useState<string[]>([]),[job,setJob]=useState<Job|null>(null),[jobId,setJobId]=useState<string|null>(null),[preview,setPreview]=useState<Preview|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<Error|null>(null);
 const workspaceBase=base.split('/cases/')[0]!;
 async function exclusive(action:()=>Promise<void>){if(busy.current)return;busy.current=true;setPending(true);setError(null);try{await action();}catch(cause){setError(formError(cause));}finally{busy.current=false;setPending(false);}}
 async function refresh(){if(!jobId)return;await exclusive(async()=>{
  const value=await resource<Job>(`${workspaceBase}/jobs/${jobId}`);if(value.id!==jobId)throw Error('The server returned a different job. Refresh recorded state.');setJob(value);
  if(value.kind==='redaction_preview'&&value.status==='succeeded'){
   const result=value.result as Preview;reviewedRedaction(result,true,'Read exact preview');setPreview(result);
  }
  if(value.kind==='redaction_apply'&&value.status==='succeeded'){
   const result=value.result as {derivatives:{id:string;supersedes_id:string}[]};if(!Array.isArray(result?.derivatives)||!result.derivatives.length)throw Error('Completed work did not contain published evidence identities.');setPreview(null);setSelected([]);await onChanged();
  }
 });}
 function queue(event:FormEvent){event.preventDefault();void exclusive(async()=>{
  if(!canMutate||!selected.length||selected.length>100||new Set(selected).size!==selected.length||selected.some(id=>!evidence.some(row=>row.id===id&&row.redaction_status!=='withdrawn')))throw Error('Select1..100 available evidence excerpts.');
  const result=await send<{job_id:string;status:string}>(`${base}/redaction-previews`,{evidence_ids:[...selected].sort(),policy_version:'contact-secrets-v1'});if(!finiteId.test(result.job_id)||result.status!=='queued')throw Error('Preview admission is unknown. Refresh recorded work before retrying.');setJobId(result.job_id);setJob(null);setPreview(null);
 });}
 function apply(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);void exclusive(async()=>{
  if(!canMutate)throw Error('Your current role cannot approve this redaction.');const body=reviewedRedaction(preview,form.get('reviewed')==='on',String(form.get('reason')??'')),current=await resource<Investigation>(base);
  if(current.active_revision_id!==preview!.revision_id)throw Error('The investigation changed. Request and review a new preview.');
  const result=await send<{job_id:string;status:string}>(`${base}/redactions`,body,'POST',current.revision);if(!finiteId.test(result.job_id)||result.status!=='queued')throw Error('Redaction admission is unknown. Refresh recorded work before retrying.');setJobId(result.job_id);setJob(null);setPreview(null);
 });}
 if(!canMutate)return null;
 return <section className="panel"><p className="eyebrow">Privacy</p><h2>Remove private details</h2><p>Preview the removal of emails, phone numbers, and recognized credentials. Review the preview. Other private text can remain. Original files and attachments stay separate and private.</p><details><summary>Policy details</summary><p><code>contact-secrets-v1</code> only removes recognized contact and credential patterns.</p></details><ErrorNotice error={error}/><form onSubmit={queue}><fieldset disabled={pending}><legend>Evidence to clean</legend>{evidence.filter(row=>row.redaction_status!=='withdrawn').map(row=><label className="review-checkbox" key={row.id}><input type="checkbox" checked={selected.includes(row.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/>{row.source_kind.replaceAll('_',' ')} · {row.id}</label>)}</fieldset><button className="secondary" disabled={pending||!selected.length}>Preview redaction</button></form>{jobId&&<div className="notice"><p>Recorded work {jobId} · <Status>{job?.status??'Awaiting current status'}</Status></p>{job?.error_code&&<p>Work did not complete: {job.error_code}. Review its inputs before requesting a new preview.</p>}<button className="secondary" disabled={pending} onClick={()=>void refresh()}>Refresh</button></div>}{preview&&<form onSubmit={apply}><h3>Review cleaned text</h3><p>Policy {preview.binding.policy_version}. Email pseudonyms join exact text only within this investigation.</p>{preview.rows.map(row=><article key={row.id}><p className="fine-print">Original citation {row.id}</p><p className="evidence-text">{row.redaction.text}</p><p>{row.redaction.counts.emails} email matches · {row.redaction.counts.secrets} secret matches · {row.redaction.counts.phones} phone matches</p><details><summary>Redaction limits and output identity</summary><p className="hash-line">{row.redaction.output_hash}</p>{row.redaction.limitations.map((text,index)=><p key={index}>{text}</p>)}</details></article>)}<p className="notice warning">Approval publishes new sanitized citations and withdraws the selected originals. Review every excerpt for sensitive content the finite policy did not recognize. Dependent earlier citations become stale.</p><Field label="Redaction approval reason"><textarea name="reason" required maxLength={2000} disabled={pending}/></Field><label className="review-checkbox"><input name="reviewed" type="checkbox" required disabled={pending}/>I reviewed every exact excerpt and approve this minimized text for shared evidence.</label><button className="primary" disabled={pending}>Save cleaned evidence</button></form>}</section>;
}
