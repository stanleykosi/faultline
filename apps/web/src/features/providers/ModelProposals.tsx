import {plainSummary, displayLabel} from '../../plain-language';
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  resource,
  workspacePath,
  type Investigation,
  type Workspace,
} from "../../api";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  formError,
} from "../../ui";
import { JobPanel, useJobRecovery } from "../data/Presentation";
import { safeId, type AcceptedJob, type Job } from "../data/types";
import { EvidenceReferences, useCommand } from "../investigation/Shared";
import type {
  AnalysisContext,
  Evidence,
  Hypothesis,
} from "../investigation/types";
import {
  rememberProvider,
  type ModelProfile,
  type ModelProposal,
} from "./types";
import {useProposalRequestReadiness} from './request-readiness';

export function ModelProposals({
  base,
  workspace,
  csrf,
  investigation,
  context,
  evidence,
  canMutate,
  refreshToken,
  onChanged,
}: {
  base: string;
  workspace: Workspace;
  csrf: string;
  investigation: Investigation;
  context: AnalysisContext | null;
  evidence: Evidence[];
  canMutate: boolean;
  refreshToken: number;
  onChanged: () => Promise<void>;
}) {
  const send = useCommand(csrf),
    [profiles, setProfiles] = useState<ModelProfile[]>([]),
    [proposals, setProposals] = useState<ModelProposal[]>([]),
    [known, setKnown] = useState(false),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [profileId, setProfileId] = useState(""),
    [proposalId, setProposalId] = useState(
      safeId(new URLSearchParams(location.search).get("model_proposal")),
    ),
    [proposal, setProposal] = useState<ModelProposal | null>(null),
    [proposalError, setProposalError] = useState<Error | null>(null),
    [refresh, setRefresh] = useState(0),
    [review, setReview] = useState<{
      proposal: ModelProposal;
      caseRevision: number;
    } | null>(null),
    [accepted, setAccepted] = useState<string[]>([]);
  const [jobId, setJobId] = useState(
      safeId(new URLSearchParams(location.search).get("model_job")),
    ),
    [job, setJob] = useState<Job | null>(null),
    [jobPending, setJobPending] = useState(false),
    [jobError, setJobError] = useState<Error | null>(null),
    [jobRefresh, setJobRefresh] = useState(0),
    handled = useRef(new Set<string>()),
    allowed = workspace.role !== "viewer";
  const profile = profiles.find((item) => item.id === profileId),
    ready =
      !!profile &&
      profile.status === "available" &&
      profile.capabilities?.status === "available" &&
      !profile.credential?.revoked;
  const requestReviewKey = [
    profile?.id,
    profile?.profile_hash,
    profile?.credential?.active_version,
    profile?.capabilities?.checked_at,
    context?.binding.revision_id,
    context?.binding.metric_hash,
    context?.binding.snapshot_hash,
  ].join(":");
  const requestReadiness = useProposalRequestReadiness({base, revisionId: context?.binding.revision_id ?? '', profileId, kind: 'hypotheses', refreshKey: JSON.stringify([refresh, refreshToken, requestReviewKey, jobId, job?.status])}, allowed && canMutate && ready && !!context && !loading);
  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.allSettled([
      resource<ModelProfile[]>(
        `${workspacePath(workspace.id)}/model-profiles`,
        { signal: controller.signal },
      ),
      resource<ModelProposal[]>(`${base}/model-proposals`, {
        signal: controller.signal,
      }),
    ])
      .then((values) => {
        if (controller.signal.aborted) return;
        const [profileResult, proposalResult] = values;
        if (
          profileResult.status === "fulfilled" &&
          Array.isArray(profileResult.value)
        )
          setProfiles(profileResult.value);
        else {
          setProfiles([]);
          setError(
            profileResult.status === "rejected"
              ? formError(profileResult.reason)
              : new Error("Profile inventory was unavailable."),
          );
        }
        if (
          proposalResult.status === "fulfilled" &&
          Array.isArray(proposalResult.value)
        ) {
          setProposals(proposalResult.value);
          setKnown(true);
        } else {
          setProposals([]);
          setKnown(false);
          setError(
            proposalResult.status === "rejected"
              ? formError(proposalResult.reason)
              : new Error("Proposal inventory was unavailable."),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspace.id, base, allowed, refreshToken, refresh]);
  useEffect(() => {
    setProposal(null);
    setProposalError(null);
    if (!allowed || !proposalId) return;
    const controller = new AbortController();
    resource<ModelProposal>(
      `${base}/model-proposals/${encodeURIComponent(proposalId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!value?.value || value.draft_only !== true)
          throw new Error(
            "The proposal did not carry the required draft-only authority.",
          );
        if (!controller.signal.aborted) setProposal(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setProposalError(formError(cause));
      });
    return () => controller.abort();
  }, [base, allowed, proposalId, refreshToken, refresh]);
  useEffect(() => {
    if (!allowed || !jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      setJobPending(true);
      setJobError(null);
      try {
        const value = await resource<Job>(
          `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(jobId)}`,
          { signal: controller.signal },
        );
        if (value.case_id && value.case_id !== investigation.id)
          throw new Error("The selected model job belongs to another case.");
        if (!controller.signal.aborted) {
          setJob(value);
          if (["queued", "running", "cancel_requested"].includes(value.status))
            timer = setTimeout(read, 2500);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setJobError(formError(cause));
      } finally {
        if (!controller.signal.aborted) setJobPending(false);
      }
    }
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workspace.id, investigation.id, allowed, jobId, jobRefresh]);
  useEffect(() => {
    if (!job || job.status !== "succeeded" || handled.current.has(job.id))
      return;
    const id = safeId(
      typeof job.result?.proposal_id === "string"
        ? job.result.proposal_id
        : null,
    );
    if (!id || job.result?.draft_only !== true) {
      setJobError(
        new Error(
          "The completed job did not record a bounded draft-only proposal. No independent result is inferred.",
        ),
      );
      return;
    }
    handled.current.add(job.id);
    setProposalId(id);
    rememberProvider("model_proposal", id);
    setRefresh((value) => value + 1);
  }, [job]);
  async function request(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (!ready || !context)
        throw new Error(
          "Select a current available profile with frozen metric and snapshot inputs.",
        );
      if (!requestReadiness.canRequest)
        throw new Error(requestReadiness.message ?? 'Refresh this agent request’s allowance before generating possible reasons.');
      const value = await send<AcceptedJob>(`${base}/hypothesis-proposals`, {
        revision_id: context.binding.revision_id,
        profile_id: profile!.id,
      });
      if (!value?.job_id)
        throw new Error("No durable model job identity was returned.");
      setJobId(value.job_id);
      setJob(null);
      setProposalId("");
      setProposal(null);
      rememberProvider("model_job", value.job_id);
      rememberProvider("model_proposal", "");
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review) return;
    setPending(true);
    setError(null);
    try {
      const proposal_item_indexes = new FormData(event.currentTarget)
        .getAll("proposal_index")
        .map(Number);
      if (!proposal_item_indexes.length)
        throw new Error(
          "Select at least one actual draft possible reason after reviewing its evidence and what would rule this out.",
        );
      const value = await send<Hypothesis[]>(
        `${base}/hypothesis-proposals/${encodeURIComponent(review.proposal.id)}/accept`,
        { proposal_item_indexes },
        "POST",
        review.caseRevision,
      );
      if (!Array.isArray(value) || !value.length)
        throw new Error(
          "The service did not return reviewed possible reason identities.",
        );
      setAccepted(value.map((item) => item.id));
      setReview(null);
      await onChanged();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  const recovery = useJobRecovery({
    workspaceId: workspace.id,
    caseId: investigation.id,
    role: workspace.role,
    csrf,
    job,
    canMutate,
    onAccepted: (value) => {
      setJobId(value.job_id);
      setJob(null);
      setProposalId("");
      setProposal(null);
      rememberProvider("model_job", value.job_id);
      rememberProvider("model_proposal", "");
    },
  });
  async function cancel(reason: string) {
    if (!job || typeof job.attempt !== "number")
      throw new Error(
        "Refresh the exact recorded attempt before cancellation.",
      );
    await send(
      `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(job.id)}/cancel`,
      { reason },
      "POST",
      job.attempt,
    );
    setJobRefresh((value) => value + 1);
  }
  if (!allowed)
    return (
      <section className="notice">
        <strong>Model drafts require owner or analyst access</strong>
        <p>
          Independent observed results and permitted evidence remain visible
          elsewhere.
        </p>
      </section>
    );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          
          <h2>Possible reason suggestions</h2>
        </div>
        <Status tone="warning">Review required</Status>
      </div>

      <ErrorNotice error={review ? null : error} />
      <button
        className="secondary"
        disabled={loading || pending}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh
      </button>
      {loading && !known && <Loading label="Reading optional draft state…" />}
      {canMutate && (
        <details open={!proposals.length}><summary>Suggest possible reasons</summary><form onSubmit={request}>
          <Field label="Agent model">
            <select
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              disabled={loading || pending}
            >
              <option value="">Choose the agent model</option>
              {profiles.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name} · {item.model_name} · {item.status}
                </option>
              ))}
            </select>
          </Field>
          {!profiles.length && !loading && (
            <p className="notice">
              The agent needs a model connection. An owner can connect one in Settings / Agent models.
            </p>
          )}
          {profile && (
            <div className="notice">
              <strong>
                {profile.provider.replaceAll("_", " ")} · {profile.model_name}
              </strong>
              <p>Connection: {profile.capabilities?.status ?? "Not checked"}</p>
              <details><summary>Connection details</summary><p>URL: {profile.base_url}. Credential version: {profile.credential?.active_version ?? "None"}.</p><p className="hash-line">Profile hash {profile.profile_hash}</p><p className="fine-print">This request may use your provider allowance.</p></details>
            </div>
          )}
          {profile && !ready && (
            <p className="notice warning">
              This model is not ready: {profile.reason_code ?? profile.status}.
              Check the connection in Settings.
            </p>
          )}
          {!context && (
            <p className="notice warning">
              Lock a metric and choose data before asking agent for ideas.
            </p>
          )}
          {ready && context && requestReadiness.message && <p className={`notice${requestReadiness.status === 'loading' ? '' : ' warning'}`} role="status">{requestReadiness.message}</p>}
          <label className="review-checkbox" key={requestReviewKey}>
            <input
              type="checkbox"
              required
              disabled={loading || pending || !ready || !context || !requestReadiness.canRequest}
            />
            I reviewed the model and evidence. agent suggestions are drafts and may use
            my provider allowance.
          </label>
          <button
            className="primary"
            disabled={loading || pending || !ready || !context || !requestReadiness.canRequest}
          >
            {pending
              ? "Generating drafts…"
              : "Suggest possible reasons"}
          </button>
        </form></details>
      )}
      <JobPanel
        {...recovery}
        job={job}
        pending={jobPending}
        error={jobError}
        onRefresh={() => setJobRefresh((value) => value + 1)}
        onCancel={canMutate ? cancel : undefined}
      />
      <ErrorNotice error={jobError} />
      <div className="report-list">
        {proposals.map((item) => (
          <button
            key={item.id}
            className={`report-list-item ${proposalId === item.id ? "selected" : ""}`}
            onClick={() => {
              setProposalId(item.id);
              rememberProvider("model_proposal", item.id);
            }}
          >
            <span>
              <strong>
                {displayLabel(item.value.kind)} · agent draft
              </strong>
              <small>
                {item.created_at}
              </small>
            </span>
            <Status tone={item.freshness === "fresh" ? "muted" : "warning"}>
              {item.freshness}
            </Status>
          </button>
        ))}
      </div>
      {known && !proposals.length && (
        <p className="muted">
          No agent suggestions yet. You can still add and test a cause yourself.
        </p>
      )}
      {!known && !loading && (
        <p className="notice warning">
          Draft inventory unavailable; no empty or passing outcome is inferred.
        </p>
      )}
      <ErrorNotice error={proposalError} />
      {proposal && (
        <>
          <ModelDraft proposal={proposal} evidence={evidence} />
          <details><summary>Draft details</summary><p className="hash-line">Frozen proposal input hash {proposal.value.input_hash}</p></details>
          {canMutate && proposal.value.kind === "hypotheses" && (
            <button
              className="primary"
              disabled={
                pending ||
                loading ||
                proposal.freshness !== "fresh" ||
                proposal.revision_id !== investigation.active_revision_id ||
                !proposal.value.hypotheses.length
              }
              onClick={() => {
                setError(null);
                setReview({ proposal, caseRevision: investigation.revision });
              }}
            >
              Review and add possible reasons
            </button>
          )}
        </>
      )}
      {accepted.length > 0 && (
        <p className="notice">
          Possible reasons added. They still need testing.
        </p>
      )}
      {review && (
        <Modal
          title="Add agent possible reasons"
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <form onSubmit={accept}>
            <ErrorNotice error={error} />
            <p>
              Choose the suggestions you reviewed. Every added possible reason still
              needs a test.
            </p>
            {review.proposal.value.hypotheses.map((item, index) => (
              <div key={index} className="draft-hypothesis">
                <label className="picker-choice">
                  <input name="proposal_index" type="checkbox" value={index} />
                  <strong>{plainSummary(item.title)}</strong>
                </label>
                <p>{plainSummary(item.statement)}</p>
                <p>
                  <strong>What would rule this out:</strong> {plainSummary(item.falsifier)}
                </p>
                <EvidenceReferences
                  ids={item.supporting_evidence_ids}
                  evidence={evidence}
                />
                <EvidenceReferences
                  ids={item.contradicting_evidence_ids}
                  evidence={evidence}
                />
                <p>
                  Missing evidence:{" "}
                  {item.missing_evidence.length
                    ? item.missing_evidence.map(plainSummary).join("; ")
                    : "None declared by the model — review independently."}
                </p>
                <p>Proposed tests: {item.proposed_test_kinds.map(displayLabel).join(", ")}.</p>
              </div>
            ))}
            <label className="review-checkbox">
              <input type="checkbox" required disabled={pending} />I reviewed
              each selected statement, its evidence, gaps, and what could disprove it.
              Adding it does not make it true.
            </label>
            {error && (
              <p className="notice warning">
                A changed case revision or stale proposal requires closing this
                review, refreshing recorded inputs, and reviewing again. The
                captured revision is retained for an uncertain-response retry.
              </p>
            )}
            <button className="primary" disabled={pending}>
              {pending
                ? "Recording reviewed possible reason selection…"
                : "Add selected possible reasons"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function ModelDraft({
  proposal,
  evidence,
}: {
  proposal: ModelProposal;
  evidence: Evidence[];
}) {
  return (
    <div className="model-draft">
      <div className="section-heading">
        <h3>agent draft</h3>
        <Status tone={proposal.freshness === "fresh" ? "muted" : "warning"}>
          {proposal.freshness}
        </Status>
      </div>
      {proposal.value.hypotheses.map((item, index) => (
        <article className="draft-hypothesis" key={index}>
          <h4>{plainSummary(item.title)}</h4>
          <p>{plainSummary(item.statement)}</p>
          <p>
            <strong>What would rule this out:</strong> {plainSummary(item.falsifier)}
          </p>
          <EvidenceReferences
            ids={item.supporting_evidence_ids}
            evidence={evidence}
          />
          <p className="fine-print">
            The agent chose these sources. Check them before accepting this explanation.
          </p>
        </article>
      ))}
      {proposal.value.draft_sentences.map((item, index) => (
        <article key={index}>
          <p>
            <Status tone="muted">
              Model qualification: {displayLabel(item.qualification)}
            </Status>
          </p>
          <p>{plainSummary(item.text)}</p>
          <EvidenceReferences ids={item.evidence_ids} evidence={evidence} />
        </article>
      ))}
      {proposal.value.questions.length > 0 && (
        <>
          <h4>Draft questions</h4>
          <ul>
            {proposal.value.questions.map((text, index) => (
              <li key={index}>{plainSummary(text)}</li>
            ))}
          </ul>
        </>
      )}
      {proposal.value.limitations.length > 0 && (
        <>
          <h4>Agent limitations</h4>
          <ul>
            {proposal.value.limitations.map((text, index) => (
              <li key={index}>{plainSummary(text)}</li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>Draft details</summary>
        <pre>{JSON.stringify(proposal.value, null, 2)}</pre>
      </details>
      <p className="notice warning">
        Draft only. Agent text cannot change metrics, test results or publishing
        permissions. Outdated drafts cannot be added.
      </p>
    </div>
  );
}
