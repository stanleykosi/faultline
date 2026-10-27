import {plainSummary, displayLabel} from '../../plain-language';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {resource, type Role} from '../../api';
import {ErrorNotice, Field, Loading, Modal, Status, formError} from '../../ui';
import {JobPanel, useJobRecovery} from '../data/Presentation';
import {safeId, type AcceptedJob, type Job} from '../data/types';
import {EvidenceReferences, useCommand} from '../investigation/Shared';
import type {AnalysisContext, Evidence, ReportRecord} from '../investigation/types';
import {diagnosisDraftIssue, diagnosisSentenceIssue, reviewedDiagnosisCommand} from './diagnosis-review';
import {rememberProvider, type ModelProfile, type ModelProposal} from './types';
import {useProposalRequestReadiness} from './request-readiness';

export async function readPreparedReport(base: string, createdId: string): Promise<ReportRecord> {
  if (!safeId(createdId)) throw new Error('The report creation did not return a valid report identity.');
  const record = await resource<ReportRecord>(`${base}/reports/${encodeURIComponent(createdId)}`);
  if (record?.id !== createdId) throw new Error('The report read did not return the exact created draft.');
  return record;
}

export function DiagnosisModelDraft({canMutate = true, initialProposalId, preferredModelProfileId, reports = [], onSelect, base, csrf, role, context, selectedReport, evidence, refreshToken, onChanged}: {canMutate?: boolean; initialProposalId?: string; preferredModelProfileId?: string; reports?: ReportRecord[]; onSelect?: (id: string) => void; base: string; csrf: string; role?: Role; context: AnalysisContext | null; selectedReport: ReportRecord | null; evidence: Evidence[]; refreshToken: string; onChanged: (id?: string) => Promise<void>}) {
  const send = useCommand(csrf), workspaceBase = base.slice(0, base.indexOf('/cases/'));
  const [profiles, setProfiles] = useState<ModelProfile[]>([]), [proposals, setProposals] = useState<ModelProposal[]>([]), [known, setKnown] = useState(false), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const [profileId, setProfileId] = useState(preferredModelProfileId ?? ''), [pending, setPending] = useState(false), [error, setError] = useState<Error | null>(null), [applied, setApplied] = useState('');
  const [proposalId, setProposalId] = useState(safeId(initialProposalId ?? new URLSearchParams(location.search).get('diagnosis_proposal'))), [proposal, setProposal] = useState<ModelProposal | null>(null), [proposalLoading, setProposalLoading] = useState(false), [proposalError, setProposalError] = useState<Error | null>(null);
  const [review, setReview] = useState<{proposal: ModelProposal; record: ReportRecord} | null>(null);
  const [jobId, setJobId] = useState(initialProposalId ? '' : safeId(new URLSearchParams(location.search).get('diagnosis_model_job'))), [job, setJob] = useState<Job | null>(null), [jobPending, setJobPending] = useState(false), [jobError, setJobError] = useState<Error | null>(null), [jobRefresh, setJobRefresh] = useState(0), handled = useRef(new Set<string>());
  const recovery = useJobRecovery({workspaceId: decodeURIComponent(workspaceBase.slice(workspaceBase.lastIndexOf('/') + 1)), caseId: decodeURIComponent(base.slice(base.lastIndexOf('/') + 1)), role, csrf, job, canMutate: role === 'owner' || role === 'analyst', onAccepted: value => {setJobId(value.job_id); setJob(null); setProposalId(''); setProposal(null); rememberProvider('diagnosis_model_job', value.job_id); rememberProvider('diagnosis_proposal', '');}});
  const profile = profiles.find(item => item.id === profileId), ready = !!profile && profile.status === 'available' && profile.capabilities?.status === 'available' && !profile.credential?.revoked;
  const reviewKey = [profile?.id, profile?.profile_hash, profile?.credential?.active_version, profile?.capabilities?.checked_at, context?.binding.revision_id, context?.binding.metric_hash, context?.binding.snapshot_hash].join(':');
  const contextKey = context ? [context.binding.revision_id, context.binding.metric_hash, context.binding.snapshot_hash].join(':') : '';
  const reviewIssue = proposal ? diagnosisDraftIssue(proposal, selectedReport, context) : null;
  const requestReadiness = useProposalRequestReadiness({base, revisionId: context?.binding.revision_id ?? '', profileId, kind: 'diagnosis_draft', refreshKey: JSON.stringify([refresh, refreshToken, reviewKey, jobId, job?.status])}, canMutate && ready && !!context && !loading);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    Promise.allSettled([resource<ModelProfile[]>(`${workspaceBase}/model-profiles`, {signal: controller.signal}), resource<ModelProposal[]>(`${base}/model-proposals`, {signal: controller.signal})]).then(([profileResult, proposalResult]) => {
      if (controller.signal.aborted) return;
      if (profileResult.status === 'fulfilled' && Array.isArray(profileResult.value)) {setProfiles(profileResult.value); setProfileId(current => current || preferredModelProfileId || profileResult.value.find(item => item.status === 'available' && item.capabilities?.status === 'available' && !item.credential?.revoked)?.id || '');}
      else {setProfiles([]); setError(profileResult.status === 'rejected' ? formError(profileResult.reason) : new Error('Model profile inventory was unavailable.'));}
      if (proposalResult.status === 'fulfilled' && Array.isArray(proposalResult.value)) {setProposals(proposalResult.value.filter(item => item.value?.kind === 'diagnosis_draft')); setKnown(true);}
      else {setProposals([]); setKnown(false); setError(proposalResult.status === 'rejected' ? formError(proposalResult.reason) : new Error('Diagnosis draft inventory was unavailable.'));}
    }).finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [base, workspaceBase, refresh, refreshToken, contextKey]);

  useEffect(() => {
    setProposal(null); setProposalError(null); setProposalLoading(!!proposalId);
    if (!proposalId) return;
    const controller = new AbortController();
    resource<ModelProposal>(`${base}/model-proposals/${encodeURIComponent(proposalId)}`, {signal: controller.signal}).then(value => {
      if (value?.id !== proposalId || value.draft_only !== true || value.value?.kind !== 'diagnosis_draft') throw new Error('The selected resource was not a bounded draft-only diagnosis proposal.');
      if (!controller.signal.aborted) setProposal(value);
    }).catch(cause => {if (!controller.signal.aborted) setProposalError(formError(cause));}).finally(() => {if (!controller.signal.aborted) setProposalLoading(false);});
    return () => controller.abort();
  }, [base, proposalId, refresh, refreshToken, contextKey]);

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      setJobPending(true); setJobError(null);
      try {
        const value = await resource<Job>(`${workspaceBase}/jobs/${encodeURIComponent(jobId)}`, {signal: controller.signal});
        if (value.case_id !== context?.binding.case_id && value.case_id !== decodeURIComponent(base.slice(base.lastIndexOf('/') + 1))) throw new Error('The selected model job is not bound to this investigation.');
        if (!controller.signal.aborted) {setJob(value); if (['queued', 'running', 'cancel_requested'].includes(value.status)) timer = setTimeout(read, 2500);}
      } catch (cause) {if (!controller.signal.aborted) setJobError(formError(cause));}
      finally {if (!controller.signal.aborted) setJobPending(false);}
    }
    void read(); return () => {controller.abort(); if (timer) clearTimeout(timer);};
  }, [workspaceBase, base, jobId, jobRefresh, context?.binding.case_id]);

  useEffect(() => {
    if (!job || job.status !== 'succeeded' || handled.current.has(job.id)) return;
    const id = safeId(typeof job.result?.proposal_id === 'string' ? job.result.proposal_id : null);
    if (!id || job.result?.draft_only !== true) {setJobError(new Error('The completed job did not return a draft-only model proposal. No diagnosis or verification outcome is inferred.')); return;}
    handled.current.add(job.id); setProposalId(id); rememberProvider('diagnosis_proposal', id); setRefresh(value => value + 1);
  }, [job]);

  async function prepareReport() {
    if (!canMutate || !context || !proposal) return;
    setPending(true); setError(null);
    try {
      const created = await send<ReportRecord>(`${base}/diagnoses`, {revision_id: context.binding.revision_id, mode: 'manual'});
      const record = await readPreparedReport(base, created?.id);
      const issue = diagnosisDraftIssue(proposal, record, context);
      if (issue) throw new Error(issue);
      await onChanged(record.id);
      setReview({proposal, record});
    } catch (cause) {setError(formError(cause));} finally {setPending(false);}
  }

  async function requestDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setApplied('');
    try {
      if (!ready || !context) throw new Error('Select a current available model profile and frozen investigation inputs.');
      if (!requestReadiness.canRequest) throw new Error(requestReadiness.message ?? 'Refresh this agent request’s allowance before generating a draft.');
      const result = await send<AcceptedJob>(`${base}/diagnoses`, {revision_id: context.binding.revision_id, mode: 'model', profile_id: profile!.id});
      if (!safeId(result?.job_id)) throw new Error('The explicit request did not return a durable job identity.');
      setJobId(result.job_id); setJob(null); setProposalId(''); setProposal(null); rememberProvider('diagnosis_model_job', result.job_id); rememberProvider('diagnosis_proposal', '');
    } catch (cause) {setError(formError(cause));}
    finally {setPending(false);}
  }

  async function append(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!review) return; setPending(true); setError(null);
    try {
      const indexes = new FormData(event.currentTarget).getAll('diagnosis_sentence').map(value => Number(String(value)));
      const command = reviewedDiagnosisCommand(review.proposal, review.record, context, evidence, indexes);
      const updated = await send<ReportRecord>(`${base}/diagnoses/${encodeURIComponent(review.record.id)}`, command.body, 'PATCH', command.revision);
      if (updated?.id !== review.record.id || updated.value?.status !== 'draft' || typeof updated.revision !== 'number') throw new Error('The service did not return the reviewed report draft. Refresh before preparing any publication.');
      setReview(null); setApplied(`Appended ${indexes.length} explicitly reviewed model sentence${indexes.length === 1 ? '' : 's'} to report draft ${updated.id}. Review the full updated draft and its limitations before publication.`);
      await onChanged(updated.id); setRefresh(value => value + 1);
    } catch (cause) {setError(formError(cause));}
    finally {setPending(false);}
  }

  async function cancel(reason: string) {
    if (!job || typeof job.attempt !== 'number') throw new Error('Refresh the recorded model job attempt before requesting cancellation.');
    await send(`${workspaceBase}/jobs/${encodeURIComponent(job.id)}/cancel`, {reason}, 'POST', job.attempt); setJobRefresh(value => value + 1);
  }

  return <section className="panel diagnosis-model-panel">
    <div className="section-heading"><div><h2>agent report draft</h2></div><button className="text-button" disabled={loading || pending} onClick={() => setRefresh(value => value + 1)}>Refresh</button></div>
    <p>Review each sentence and its citations before adding it. agent text cannot change metrics or test results.</p>
    <ErrorNotice error={error} />{loading && <Loading label="Reading recorded model profiles and diagnosis proposals…" />}
    {canMutate && <details open={!proposalId && !proposals.length}><summary>Generate draft</summary><form onSubmit={requestDraft}>
      <Field label="Agent model"><select value={profileId} onChange={event => setProfileId(event.target.value)} disabled={loading || pending} required><option value="">Choose a configured profile</option>{profiles.map(item => <option key={item.id} value={item.id} disabled={item.status !== 'available' || item.capabilities?.status !== 'available' || !!item.credential?.revoked}>{item.name} · {item.model_name} · {item.status}</option>)}</select></Field>
      {!loading && !profiles.length && <p className="notice warning">No accessible configured profiles are recorded. Manual reports remain available. Owners can configure and explicitly probe a provider in workspace settings.</p>}
      {profile && <div className="notice"><strong>{profile.provider.replaceAll('_', ' ')} · {profile.model_name}</strong><details><summary>Model details</summary><p>Configured endpoint: {profile.base_url}. Capability: {profile.capabilities?.status ?? 'Unprobed'}. Credential version: {profile.credential?.active_version ?? 'None'}.</p><p className="hash-line">Current profile hash {profile.profile_hash}</p><p className="fine-print">This explicit request can consume configured provider usage. Workspace call and token limits are enforced by the server.</p></details>{!ready && <p className="notice warning">Current profile unavailable: {profile.reason_code ?? profile.status}. No passing or callable capability is inferred.</p>}</div>}
      {!context && <p className="notice warning">Freeze a metric and snapshot before requesting draft text.</p>}
      {ready && context && requestReadiness.message && <p className={`notice${requestReadiness.status === 'loading' ? '' : ' warning'}`} role="status">{requestReadiness.message}</p>}
      <label className="review-checkbox" key={reviewKey}><input type="checkbox" required disabled={loading || pending || !ready || !context || !requestReadiness.canRequest} />I reviewed this endpoint, model and frozen sanitized evidence scope and authorize this bounded draft text request.</label>
      <button className="primary" disabled={loading || pending || !ready || !context || !requestReadiness.canRequest}>{pending ? 'Recording explicit review command…' : 'Generate report draft'}</button>
    </form></details>}
    <JobPanel {...recovery} job={job} pending={jobPending} error={jobError} onRefresh={() => setJobRefresh(value => value + 1)} onCancel={cancel} /><ErrorNotice error={jobError} />
    <div className="report-list">{proposals.map(item => <button className={`report-list-item ${proposalId === item.id ? 'selected' : ''}`} key={item.id} disabled={pending} onClick={() => {setProposalId(item.id); rememberProvider('diagnosis_proposal', item.id); setApplied('');}}><span><strong>agent report draft</strong><small>{item.created_at}</small></span><Status tone={item.freshness === 'fresh' ? 'muted' : 'warning'}>{item.freshness}</Status></button>)}</div>
    {known && !proposals.length && <p className="muted">No agent report draft yet.</p>}{!known && !loading && <p className="notice warning">Draft status is unknown. Refresh before continuing.</p>}
    {proposalLoading && <Loading label="Reading the exact diagnosis proposal…" />}<ErrorNotice error={proposalError} />
    {proposal && <><DiagnosisProposalView proposal={proposal} evidence={evidence} profile={profiles.find(item => item.id === proposal.profile_id)} />{onSelect && reports.some(record => !diagnosisDraftIssue(proposal, record, context)) && <Field label="Report for reviewed sentences"><select value={selectedReport?.id ?? ''} onChange={event => onSelect(event.target.value)}><option value="" disabled>Choose a current draft</option>{reports.filter(record => !diagnosisDraftIssue(proposal, record, context)).map(record => <option key={record.id} value={record.id}>{record.value?.title ?? record.id}</option>)}</select></Field>}{reviewIssue && <p className="notice warning">{reviewIssue}</p>}{canMutate && reviewIssue && context?.comparison && <button className="secondary" type="button" disabled={pending || proposalLoading || !!diagnosisDraftIssue(proposal, selectedReport, context)?.match(/proposal|input revision|binding/i)} onClick={() => void prepareReport()}>Prepare report for sentence review</button>}<button className="primary" disabled={!canMutate || pending || loading || proposalLoading || !!reviewIssue || !proposal.value.draft_sentences.length} onClick={() => {if (selectedReport && !reviewIssue) {setError(null); setReview({proposal, record: selectedReport});}}}>Review sentences</button></>}
    {applied && <p className="notice">{applied} Deterministic claims and test results were not supplied by the model.</p>}
    {review && <Modal title="Add agent sentences" onClose={() => {if (!pending) setReview(null);}}><form onSubmit={append}><ErrorNotice error={error} /><p>Select only sentences you reviewed.</p><details><summary>Review details</summary><p>Saved proposal {review.proposal.id}, input revision {review.proposal.revision_id}, report {review.record.id}, resource revision {review.record.revision}. Select only the sentences you independently reviewed. The server rechecks this exact binding.</p><p className="hash-line">Saved profile hash {review.proposal.profile_hash}<br />Proposal input hash {review.proposal.input_hash}</p></details><DiagnosisSentences proposal={review.proposal} evidence={evidence} selectable disabled={pending} />{diagnosisDraftIssue(review.proposal, review.record, context) && <p className="notice warning">{diagnosisDraftIssue(review.proposal, review.record, context)}</p>}<label className="review-checkbox"><input type="checkbox" required disabled={pending} />I reviewed each selected model qualification, statement and citation. Appending text supplies no deterministic test verdict or proof of the overall cause.</label>{error && <p className="fine-print">For an uncertain response, this review retains the original report revision and selected command identity for a deliberate retry. Changed or stale inputs require a new review.</p>}<button className="primary" disabled={pending || !!diagnosisDraftIssue(review.proposal, review.record, context)}>{pending ? 'Appending reviewed model prose…' : 'Add selected sentences'}</button></form></Modal>}
  </section>;
}

export function DiagnosisSentences({proposal, evidence, selectable = false, disabled = false}: {proposal: ModelProposal; evidence: Evidence[]; selectable?: boolean; disabled?: boolean}) {
  return <div className="model-diagnosis-sentences">{proposal.value.draft_sentences.map((sentence, index) => {
    const issue = diagnosisSentenceIssue(sentence, evidence);
    const destination = sentence.qualification === 'next_step' ? 'Recommended action' : sentence.qualification === 'limitation' ? 'Report limitation' : 'Human-reviewed model finding';
    return <article className="draft-hypothesis" key={index}>
      {selectable ? <label className="picker-choice"><input type="checkbox" name="diagnosis_sentence" value={index} disabled={disabled || !!issue} /><strong>Select sentence {index + 1} · {destination}</strong></label> : <h4>Sentence {index + 1} · {destination}</h4>}
      <Status tone="muted">Model qualification: {displayLabel(sentence.qualification)}</Status><p className="evidence-text">{plainSummary(sentence.text)}</p><EvidenceReferences ids={sentence.evidence_ids} evidence={evidence} />
      {issue && <p className="notice warning">{issue}</p>}{!sentence.evidence_ids.length && <p className="fine-print">No evidence citations were supplied for this model sentence.</p>}
    </article>;
  })}</div>;
}

function DiagnosisProposalView({proposal, evidence, profile}: {proposal: ModelProposal; evidence: Evidence[]; profile?: ModelProfile}) {
  return <div className="model-draft"><div className="section-heading"><h3>agent report draft</h3><Status tone={proposal.freshness === 'fresh' ? 'muted' : 'warning'}>{proposal.freshness}</Status></div><p>Profile {proposal.profile_id}{profile ? ` · ${profile.name} · ${profile.model_name}` : ' · Current profile unavailable'}. Draft only; qualification labels are model assertions requiring independent review.</p><details><summary>Draft details</summary><p className="hash-line">Saved profile hash {proposal.profile_hash ?? 'Unavailable'}<br />Saved proposal input hash {proposal.input_hash ?? 'Unavailable'}<br />Frozen input revision {proposal.revision_id}</p></details>{profile && profile.profile_hash !== proposal.profile_hash && <p className="notice warning">The model settings changed since this draft.</p>}<DiagnosisSentences proposal={proposal} evidence={evidence} />{!proposal.value.draft_sentences.length && <p className="muted">No report text was returned.</p>}{proposal.value.limitations.length > 0 && <><h4>Agent limitations</h4><ul>{proposal.value.limitations.map((text, index) => <li key={index}>{plainSummary(text)}</li>)}</ul><p className="fine-print">Choose the limitations to include in the report.</p></>}{proposal.value.questions.length > 0 && <><h4>Questions for you</h4><ul>{proposal.value.questions.map((text, index) => <li key={index}>{plainSummary(text)}</li>)}</ul></>}<details><summary>Draft details</summary><pre>{JSON.stringify({value: proposal.value, evidence_hashes: proposal.evidence_hashes}, null, 2)}</pre></details><p className="notice warning">An observed link does not prove the cause. Agent drafts cannot change test results or publish reports.</p></div>;
}
