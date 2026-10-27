import {displayLabel, evidenceSummary, plainSummary} from '../../plain-language';
import { useEffect, useRef, useState, type FormEvent } from "react";
import { resource, workspacePath, type Role } from "../../api";
import { commandKey, type CommandIdentity } from "../../command-key";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  dateLabel,
  formError,
} from "../../ui";
import {
  rateLabel,
  pointsLabel,
  safeId,
  type AcceptedJob,
  type Comparison,
  type Coverage,
  type Job,
  type PeriodResult,
  type Rate,
} from "./types";
import type { JobStreamView } from "./job-stream";

export function CaseNavigation({
  workspaceId,
  caseId,
  current,
  navigate,
}: {
  workspaceId: string;
  caseId: string;
  current: "agent" | "overview" | "data" | "investigation";
  navigate: (path: string) => void;
}) {
  return (
    <nav className="case-section-nav" aria-label="Investigation sections">
      {[
        ["agent", "Agent"],
        ["overview", "Overview"],
        ["data", "Data"],
        ["investigation", "Findings"],
      ].map(([section, label]) => (
        <a
          key={section}
          href={`/w/${workspaceId}/cases/${caseId}/${section}`}
          aria-current={current === section ? "page" : undefined}
          onClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
              event.preventDefault();
              navigate(`/w/${workspaceId}/cases/${caseId}/${section}`);
            }
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function SourceRows({
  rows,
  title = "Private source preview",
}: {
  rows: Record<string, unknown>[];
  title?: string;
}) {
  if (!rows.length)
    return <p className="muted">No preview records were returned.</p>;
  const shown = rows.slice(0, 20),
    columns = [...new Set(shown.flatMap((row) => Object.keys(row)))].slice(
      0,
      8,
    );
  return (
    <div className="source-preview">
      <div
        className="table-scroll"
        role="region"
        aria-label={title}
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{displayLabel(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>
                    <span className="preview-cell">
                      {row[column] === null || row[column] === undefined
                        ? "Unknown"
                        : typeof row[column] === "object"
                          ? JSON.stringify(row[column])
                          : String(row[column])}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Inspect exact preview records</summary>
        <pre>{JSON.stringify(shown, null, 2)}</pre>
      </details>
      <p className="fine-print">
        Up to 20 actual preview records. Source text is displayed as data.
      </p>
    </div>
  );
}

export function CoverageSummary({ coverage }: { coverage?: Coverage }) {
  if (!coverage)
    return <p className="muted">Coverage metadata is unavailable.</p>;
  return (
    <div className="coverage-summary">
      <dl>
        <div>
          <dt>Transfer</dt>
          <dd>
            <Status
              tone={
                coverage.extraction_status === "complete"
                  ? "neutral"
                  : "warning"
              }
            >
              {coverage.extraction_status}
            </Status>
          </dd>
        </div>
        <div>
          <dt>Completeness basis</dt>
          <dd>{displayLabel(coverage.basis)}</dd>
        </div>
        <div>
          <dt>Event-time range</dt>
          <dd>
            {coverage.covered_start ?? "Unknown"} →{" "}
            {coverage.covered_end ?? "Unknown"}
          </dd>
        </div>
        <div>
          <dt>Declared watermark</dt>
          <dd>{coverage.event_watermark ?? "Unknown"}</dd>
        </div>
      </dl>
      {coverage.attestation && <p>{coverage.attestation}</p>}
      {coverage.assumptions?.map((assumption, index) => (
        <p className="notice warning" key={index}>
          {assumption}
        </p>
      ))}
      <p className="fine-print">
        A complete transfer and a human completeness attestation are separate
        facts. Source collection must cover the metric windows and conversion
        observation tail.
      </p>
    </div>
  );
}

export type RecoveryJob = Job & { kind?: string; retry_of?: string | null };
export type JobRecoveryReceipt = AcceptedJob & {
  retry_of: string;
  attempt: number;
};
type RecoveryMode = "retry" | "resume";
const registeredJobKinds = new Set([
  "import_commit",
  "comparison_compute",
  "analytic_compute",
  "browser_execute",
  "external_browser_execute",
  "followup_due",
  "source_capture",
  "model_proposal",
  "redaction_preview",
  "redaction_apply",
]);
const mutationRole = (role?: Role) => role === "owner" || role === "analyst";
const knownAttempt = (job: Job) =>
  Number.isSafeInteger(job.attempt) && Number(job.attempt) >= 0;

export function jobRecoveryMode(
  job: RecoveryJob,
  role?: Role,
): RecoveryMode | null {
  if (!mutationRole(role)) return null;
  if (job.status === "failed" && registeredJobKinds.has(job.kind ?? ""))
    return "retry";
  if (
    job.status === "waiting_for_input" &&
    job.kind === "followup_due" &&
    job.error_code === "FOLLOWUP_DATA_REQUIRED"
  )
    return "resume";
  return null;
}

/** A user-triggered recovery keeps immutable inputs and an uncertain command key. */
export async function recoverJob({
  workspaceId,
  caseId,
  role,
  csrf,
  job,
  mode,
  identity,
}: {
  workspaceId: string;
  caseId: string;
  role?: Role;
  csrf: string;
  job: RecoveryJob;
  mode: RecoveryMode;
  identity: { current: CommandIdentity };
}): Promise<JobRecoveryReceipt> {
  if (
    jobRecoveryMode(job, role) !== mode ||
    !knownAttempt(job) ||
    !safeId(job.id) ||
    job.case_id !== caseId
  )
    throw new Error(
      "Refresh this run before reviewing a retry.",
    );
  const path = `${workspacePath(workspaceId)}/jobs/${encodeURIComponent(job.id)}/${mode}`,
    body = mode === "resume" ? { prerequisite_ids: [] } : {};
  const value = await resource<JobRecoveryReceipt>(path, {
    method: "POST",
    csrf,
    body,
    revision: job.attempt,
    idempotencyKey: commandKey(identity, {
      path,
      method: "POST",
      body,
      attempt: job.attempt,
    }),
  });
  if (
    !safeId(value?.job_id) ||
    value.job_id === job.id ||
    value.retry_of !== job.id ||
    value.status !== "queued" ||
    value.attempt !== 0
  )
    throw new Error(
      "The retry did not return a new queued run. Refresh before continuing.",
    );
  identity.current = null;
  return value;
}

export function useJobRecovery({
  workspaceId,
  caseId,
  role,
  csrf,
  job,
  canMutate,
  onAccepted,
}: {
  workspaceId: string;
  caseId: string;
  role?: Role;
  csrf: string;
  job: RecoveryJob | null;
  canMutate: boolean;
  onAccepted: (value: JobRecoveryReceipt) => void;
}) {
  const retryIdentity = useRef<CommandIdentity>(null),
    resumeIdentity = useRef<CommandIdentity>(null);
  const [history, setHistory] = useState<RecoveryJob[]>([]),
    [historyError, setHistoryError] = useState<Error | null>(null);
  useEffect(() => {
    setHistory([]);
    setHistoryError(null);
    retryIdentity.current = null;
    resumeIdentity.current = null;
  }, [workspaceId, caseId]);
  useEffect(() => {
    const predecessor = safeId(job?.retry_of ?? null);
    if (!predecessor || history.some((item) => item.id === predecessor)) return;
    const controller = new AbortController();
    setHistoryError(null);
    resource<RecoveryJob>(
      `${workspacePath(workspaceId)}/jobs/${encodeURIComponent(predecessor)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (value.id !== predecessor || value.case_id !== caseId)
          throw new Error(
            "Recovery history did not match the current investigation.",
          );
        if (!controller.signal.aborted)
          setHistory((previous) =>
            [...previous.filter((item) => item.id !== value.id), value].slice(
              -10,
            ),
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setHistoryError(formError(cause));
      });
    return () => controller.abort();
  }, [workspaceId, caseId, job?.retry_of, history]);
  async function recover(id: string, mode: RecoveryMode) {
    if (!canMutate || !job || job.id !== id)
      throw new Error(
        "The reviewed run changed or retry is unavailable. Refresh and review it again.",
      );
    const original = job,
      value = await recoverJob({
        workspaceId,
        caseId,
        role,
        csrf,
        job: original,
        mode,
        identity: mode === "retry" ? retryIdentity : resumeIdentity,
      });
    setHistory((previous) =>
      [...previous.filter((item) => item.id !== original.id), original].slice(
        -10,
      ),
    );
    onAccepted(value);
    return value;
  }
  return {
    role,
    history,
    historyError,
    onRetry:
      canMutate && mutationRole(role)
        ? (id: string) => recover(id, "retry")
        : undefined,
    onResume:
      canMutate && mutationRole(role)
        ? (id: string) => recover(id, "resume")
        : undefined,
  };
}

export function RecoveryAcceptance({
  receipt,
}: {
  receipt: JobRecoveryReceipt;
}) {
  return (
    <p className="notice" role="status">
      Retry started. The earlier result is still saved.{" "}
      <small>
        Run {receipt.job_id} · {receipt.status}
      </small>
    </p>
  );
}
export function recordedFollowupOutcome(
  job: RecoveryJob,
): { id: string; state: "compared" | "waiting_for_data" } | null {
  if (
    job.kind !== "followup_due" ||
    !safeId(typeof job.result?.id === "string" ? job.result.id : null)
  )
    return null;
  if (job.status === "succeeded" && job.result?.state === "compared")
    return { id: job.result.id as string, state: "compared" };
  if (
    job.status === "waiting_for_input" &&
    job.result?.state === "waiting_for_data"
  )
    return { id: job.result.id as string, state: "waiting_for_data" };
  return null;
}
export function FollowupJobOutcome({ job }: { job: RecoveryJob }) {
  const outcome = recordedFollowupOutcome(job);
  if (!outcome)
    return (
      <p className="notice warning">
        The follow-up domain outcome is unavailable or inconsistent with the job
        checkpoint. Its result remains unknown.
      </p>
    );
  return (
    <p className="notice">
      Recorded follow-up {outcome.id}: {outcome.state.replaceAll("_", " ")}.
      Review its actual source, coverage and comparison in Follow-up. This
      observational recheck does not prove the overall cause.
    </p>
  );
}

export function JobProgressConnection({ stream }: { stream: JobStreamView }) {
  const { connection, lastEvent, lastJobReadAt } = stream;
  const labels = {
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Disconnected; reconnecting",
    unavailable: "Unavailable",
    access_closed: "Access closed",
    closed: "Closed after recorded terminal state",
  };
  const revoked = connection.state === "access_closed";
  return (
    <section
      aria-label="Progress connection"
      className="notice"
      data-connection-state={connection.state}
      data-event-cursor={connection.cursor ?? ""}
    >
      <p role="status">Live updates: {labels[connection.state]}</p>
      {connection.reason && <p>{connection.reason}</p>}
      {["reconnecting", "unavailable"].includes(connection.state) && (
        <p>
          Progress may be out of date. Faultline is still checking the saved
          run.
        </p>
      )}
      <details>
        <summary>Connection details</summary>
        <dl className="binding-list">
          <div>
            <dt>Event cursor</dt>
            <dd>{connection.cursor ?? "No event received"}</dd>
          </div>
          <div>
            <dt>Last event</dt>
            <dd>
              {!revoked && lastEvent
                ? `${lastEvent.status.replaceAll("_", " ")} · ${lastEvent.created_at}${lastEvent.attempt !== undefined ? ` · attempt ${lastEvent.attempt}` : ""}`
                : revoked
                  ? "Cleared when access closed"
                  : "None"}
            </dd>
          </div>
          <div>
            <dt>Last run update</dt>
            <dd>{!revoked && lastJobReadAt ? lastJobReadAt : "Unknown"}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export function JobPanel({
  job: suppliedJob,
  pending,
  error,
  onRefresh,
  onCancel,
  onRetry,
  onResume,
  role,
  history: suppliedHistory = [],
  historyError = null,
  stream,
  authority = "current",
}: {
  job: RecoveryJob | null;
  pending: boolean;
  error: Error | null;
  onRefresh: () => void;
  onCancel?: (reason: string) => Promise<void>;
  onRetry?: (jobId: string) => Promise<JobRecoveryReceipt>;
  onResume?: (jobId: string) => Promise<JobRecoveryReceipt>;
  role?: Role;
  history?: RecoveryJob[];
  historyError?: Error | null;
  stream?: JobStreamView | null;
  authority?: "current" | "unknown";
}) {
  const revoked = stream?.connection.state === "access_closed",
    job = revoked ? null : suppliedJob,
    history = revoked ? [] : suppliedHistory;
  const [cancelling, setCancelling] = useState(false),
    [cancelError, setCancelError] = useState<Error | null>(null);
  const [review, setReview] = useState<{
      job: RecoveryJob;
      mode: RecoveryMode;
    } | null>(null),
    [recovering, setRecovering] = useState(false),
    [recoveryError, setRecoveryError] = useState<Error | null>(null),
    [accepted, setAccepted] = useState<JobRecoveryReceipt | null>(null);
  useEffect(() => {
    if (
      job &&
      accepted &&
      job.id !== accepted.job_id &&
      job.id !== accepted.retry_of
    )
      setAccepted(null);
  }, [job?.id, accepted]);
  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      revoked ||
      authority !== "current" ||
      error ||
      !onCancel ||
      !mutationRole(role)
    )
      return;
    const reason = String(
      new FormData(event.currentTarget).get("reason"),
    ).trim();
    if (!reason) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel(reason);
    } catch (cause) {
      setCancelError(formError(cause));
    } finally {
      setCancelling(false);
    }
  }
  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      authority !== "current" ||
      error ||
      !review ||
      !job ||
      job.id !== review.job.id ||
      job.attempt !== review.job.attempt ||
      jobRecoveryMode(job, role) !== review.mode
    ) {
      setRecoveryError(
        new Error(
          "The reviewed run changed. Refresh and review it again.",
        ),
      );
      return;
    }
    const action = review.mode === "retry" ? onRetry : onResume;
    if (!action) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      const value = await action(review.job.id);
      setAccepted(value);
      setReview(null);
    } catch (cause) {
      setRecoveryError(formError(cause));
    } finally {
      setRecovering(false);
    }
  }
  const terminal =
      job &&
      [
        "succeeded",
        "failed",
        "cancelled",
        "waiting_for_input",
        "blocked",
      ].includes(job.status),
    mode = job ? jobRecoveryMode(job, role) : null;
  const hasAction =
    authority === "current" &&
    !error &&
    (mode === "retry" ? !!onRetry : mode === "resume" ? !!onResume : false);
  const reviewCurrent =
    authority === "current" &&
    !error &&
    !!job &&
    !!review &&
    job.id === review.job.id &&
    job.attempt === review.job.attempt &&
    jobRecoveryMode(job, role) === review.mode;
  if (!job && !pending && !error && !accepted && !history.length && !stream)
    return null;
  return (
    <section
      className={`panel job-panel ${job?.status === "failed" ? "job-failed" : ""}`}
    >
      {stream && <JobProgressConnection stream={stream} />}
      {!revoked && accepted && <RecoveryAcceptance receipt={accepted} />}
      {!revoked && job && authority === "unknown" && (
        <p className="notice warning" role="status">
          Run access is unknown. The displayed status is last known
          and may be stale. Refresh before making changes.
        </p>
      )}
      {!job ? (
        pending ? (
          <Loading label="Loading saved run…" />
        ) : error ? (
          <div className="notice warning">
            <strong>Run status unavailable</strong>
            <p>
              The last run could not be read. Its outcome is unknown.
            </p>
            <button className="secondary" onClick={onRefresh}>
              Refresh run status
            </button>
          </div>
        ) : (
          <p className="muted">Loading the new run.</p>
        )
      ) : (
        <>
          <div className="section-heading">
            <h2>{terminal ? "Run result" : "Work in progress"}</h2>
            <Status
              tone={
                job.status === "failed" ||
                job.status === "blocked" ||
                job.status === "waiting_for_input"
                  ? "warning"
                  : "neutral"
              }
            >
              {job.status === "succeeded"
                ? "Finished"
                : job.status.replaceAll("_", " ")}
            </Status>
          </div>
          <p>
            {job.status === "queued"
              ? "Waiting to start."
              : job.status === "running"
                ? "Faultline is working. You can leave this page and return later."
                : job.status === "succeeded"
                  ? "Finished. Review the result below."
                  : job.status === "failed"
                    ? "The run failed. No result was accepted."
                    : job.status === "waiting_for_input"
                      ? "More information is needed before this can continue."
                      : `Status: ${job.status.replaceAll("_", " ")}.`}
          </p>
          {job.error_code && (
            <p className="job-code">Reason: {job.error_code}</p>
          )}
          {job.kind === "followup_due" &&
            ["succeeded", "waiting_for_input"].includes(job.status) && (
              <FollowupJobOutcome job={job} />
            )}
          {job.retry_of && (
            <p className="fine-print">
              Retry of run {job.retry_of}. Current run {job.id}; status{" "}
              {job.status.replaceAll("_", " ")}; attempt{" "}
              {job.attempt ?? "unknown"}.
            </p>
          )}
          {job.status === "cancel_requested" && (
            <p className="notice warning">
              Cancellation has been requested. The terminal state and cleanup
              remain pending until recorded by the worker.
            </p>
          )}
          {authority === "current" &&
            !error &&
            mutationRole(role) &&
            onCancel &&
            !terminal &&
            job.status !== "cancel_requested" && (
              <form className="job-cancel-form" onSubmit={cancel}>
                <Field label="Cancellation reason">
                  <input
                    name="reason"
                    maxLength={2000}
                    required
                    disabled={cancelling || pending}
                  />
                </Field>
                <button
                  className="secondary"
                  disabled={cancelling || pending || !knownAttempt(job)}
                >
                  {cancelling
                    ? "Requesting cancellation…"
                    : "Request cancellation"}
                </button>
                {!knownAttempt(job) && (
                  <p className="fine-print">
                    Attempt identity is unavailable. Refresh before cancelling.
                  </p>
                )}
                <ErrorNotice error={cancelError} />
              </form>
            )}
          {hasAction && (
            <>
              <button
                className="secondary"
                disabled={
                  pending || !!error || recovering || !knownAttempt(job)
                }
                onClick={() => {
                  setRecoveryError(null);
                  setReview({ job, mode: mode! });
                }}
              >
                {mode === "retry" ? "Retry" : "Resume"}
              </button>
              {!knownAttempt(job) && (
                <p className="fine-print">Refresh before trying again.</p>
              )}
            </>
          )}
          {job.status === "waiting_for_input" && !hasAction && (
            <p className="notice warning">
              This waiting checkpoint has no available resume command under your
              current role and recorded handler. Review the reason; do not treat
              it as a passing result.
            </p>
          )}
          <div className="job-footer">
            <span>Run {job.id}</span>
            <span>Attempt {job.attempt ?? "unknown"}</span>
            {job.updated_at && <span>Updated {dateLabel(job.updated_at)}</span>}
            <button className="text-button" onClick={onRefresh}>
              Refresh run status
            </button>
          </div>
        </>
      )}
      {history.length > 0 && (
        <details open>
          <summary>Original run history</summary>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <strong>Run {item.id}</strong> ·{" "}
                {item.status.replaceAll("_", " ")} · attempt{" "}
                {item.attempt ?? "unknown"}
                {item.error_code ? ` · ${item.error_code}` : ""}
                {item.retry_of ? ` · retry of ${item.retry_of}` : ""}
              </li>
            ))}
          </ul>
          <p className="fine-print">
            Retry creates a new run; these original outcomes remain
            unchanged.
          </p>
        </details>
      )}
      {!revoked && <ErrorNotice error={historyError} />}
      {!revoked && review && (
        <Modal
          title={
            review.mode === "retry"
              ? "Review new-run retry"
              : "Review unchanged-input resume"
          }
          onClose={() => {
            if (!recovering) setReview(null);
          }}
        >
          <form onSubmit={recover}>
            <dl className="binding-list">
              <div>
                <dt>Original run</dt>
                <dd>{review.job.id}</dd>
              </div>
              <div>
                <dt>Recorded status / reason</dt>
                <dd>
                  {review.job.status} /{" "}
                  {review.job.error_code ?? "No reason supplied"}
                </dd>
              </div>
              <div>
                <dt>Reviewed attempt</dt>
                <dd>{review.job.attempt ?? "Unknown"}</dd>
              </div>
            </dl>
            <p>
              {review.mode === "retry"
                ? "This starts a separate run with the same inputs. The failed run stays in history. Changed inputs require a new review."
                : "This checks the recorded follow-up again after its missing-data prerequisite is addressed. The original immutable inputs remain unchanged; no arbitrary replacement prerequisite IDs are submitted."}
            </p>
            <p className="fine-print">
              The server rechecks current access, inputs, attempt, handler and
              budgets. Accepted queued work does not imply a passing computation
              or verification.
            </p>
            {!reviewCurrent && (
              <p className="notice warning">
                The saved run changed or access is unavailable. Close this
                review and refresh before continuing.
              </p>
            )}
            <ErrorNotice error={recoveryError} />
            <label className="review-checkbox">
              <input
                type="checkbox"
                required
                disabled={!reviewCurrent || recovering || pending}
              />
              {review.mode === "retry"
                ? "I reviewed the failure and unchanged inputs, and request a separate recorded run."
                : "I reviewed the missing-data prerequisite and unchanged inputs, and request an explicit recheck."}
            </label>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={recovering}
                onClick={() => setReview(null)}
              >
                Cancel recovery review
              </button>
              <button
                className="primary"
                disabled={
                  !reviewCurrent ||
                  recovering ||
                  pending ||
                  !knownAttempt(review.job)
                }
              >
                {recovering
                  ? "Requesting recorded recovery…"
                  : review.mode === "retry"
                    ? "Request new-run retry"
                    : "Resume unchanged inputs"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function CountCell({ value }: { value: Rate | null | undefined }) {
  return (
    <td>
      {value ? (
        <>
          <strong>
            {value.converted.toLocaleString()} /{" "}
            {value.eligible.toLocaleString()}
          </strong>
          <small>
            {rateLabel(value.rate)}
            {value.interval
              ? ` · 95% interval ${rateLabel(value.interval.low)}–${rateLabel(value.interval.high)}`
              : " · interval unknown"}
          </small>
        </>
      ) : (
        <span className="muted">Unknown</span>
      )}
    </td>
  );
}
export function RateTable({
  baseline,
  comparison,
  delta,
}: {
  baseline: PeriodResult | null;
  comparison: PeriodResult | null;
  delta?: number | null;
}) {
  const cohorts = [
    ...new Set([
      ...Object.keys(baseline?.strata ?? {}),
      ...Object.keys(comparison?.strata ?? {}),
    ]),
  ];
  return (
    <>
      <div
        className="table-scroll"
        role="region"
        aria-label="Session conversion comparison"
        tabIndex={0}
      >
        <table className="rate-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Before</th>
              <th>After</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            <tr className="aggregate-row">
              <td>All sessions</td>
              <CountCell value={baseline} />
              <CountCell value={comparison} />
              <td>{pointsLabel(delta)}</td>
            </tr>
            {cohorts.map((cohort) => {
              const b = baseline?.strata[cohort],
                c = comparison?.strata[cohort];
              return (
                <tr key={cohort}>
                  <td>{cohort}</td>
                  <CountCell value={b} />
                  <CountCell value={c} />
                  <td>
                    {b?.rate === null ||
                    b?.rate === undefined ||
                    c?.rate === null ||
                    c?.rate === undefined
                      ? "Unknown"
                      : pointsLabel(100 * (c.rate - b.rate))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details>
        <summary>How these rates are calculated</summary>
        <p>
          Faultline calculates these counts and rates from the saved inputs.
          Unknown rates stay unknown. The ranges shown are descriptive 95%
          intervals.
        </p>
      </details>
      {!!baseline?.unknown_cohort_count ||
      !!comparison?.unknown_cohort_count ? (
        <div className="notice warning">
          Sessions with an unknown group: before{" "}
          {baseline?.unknown_cohort_count ?? "unknown"}, after{" "}
          {comparison?.unknown_cohort_count ?? "unknown"}. Check the source
          fields.
        </div>
      ) : null}
    </>
  );
}

export function ComparisonResult({ result }: { result: Comparison }) {
  const value = result.value,
    mix = result.mix;
  return (
    <section className="panel comparison-result">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Comparison</p>
          <h2>Conversion change</h2>
        </div>
        <div className="status-group">
          <Status tone={result.freshness === "stale" ? "warning" : "neutral"}>
            {result.freshness}
          </Status>
          <Status
            tone={value.quality === "complete_attested" ? "neutral" : "warning"}
          >
            {displayLabel(value.quality)}
          </Status>
        </div>
      </div>
      {result.freshness === "stale" && (
        <div className="notice warning">
          <strong>This result uses older inputs.</strong>
        </div>
      )}
      {value.reason && (
        <div className="notice warning">
          <strong>Limit</strong>
          <p>{displayLabel(value.reason)}</p>
        </div>
      )}
      <RateTable
        baseline={value.baseline}
        comparison={value.comparison}
        delta={value.delta_pp}
      />
      <div className="comparison-facts">
        <div>
          <span>Overall change</span>
          <strong>{pointsLabel(value.delta_pp)}</strong>
        </div>
        <div>
          <span>Relative change</span>
          <strong>
            {value.relative_change === null
              ? "Unknown"
              : `${(value.relative_change * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`}
          </strong>
        </div>
        <div>
          <span>Data coverage</span>
          <strong>{displayLabel(value.basis)}</strong>
        </div>
      </div>
      <section className="mix-panel">
        <div className="section-heading">
          <h3>Traffic mix</h3>
          <Status tone={mix.status === "complete" ? "neutral" : "warning"}>
            {mix.status}
          </Status>
        </div>
        <p>
          After rate with the before-period group mix:{" "}
          <strong>{rateLabel(mix.standardized_rate)}</strong>.
        </p>
        <div className="mix-facts">
          <span>
            Rate change within groups: {pointsLabel(mix.within_component_pp)}
          </span>
          <span>
            Change from group mix: {pointsLabel(mix.composition_component_pp)}
          </span>
        </div>
        {Object.keys(mix.baseline_weights).length > 0 && (
          <details>
            <summary>Group weights</summary>
            <p>
              {Object.entries(mix.baseline_weights)
                .map(([cohort, weight]) => `${cohort} ${rateLabel(weight)}`)
                .join(" · ")}
              .
            </p>
          </details>
        )}
        {mix.reason && (
          <p className="notice warning">{displayLabel(mix.reason)}</p>
        )}
        {mix.missing_comparison_strata.length > 0 && (
          <p>Missing groups: {mix.missing_comparison_strata.join(", ")}.</p>
        )}
        {mix.limitations.map((limitation, index) => (
          <p className="fine-print" key={index}>
            {plainSummary(limitation)}
          </p>
        ))}
      </section>
      <p className="notice">
        This shows an association in the selected data. It does not prove what
        caused the overall change.
      </p>
      <details>
        <summary>Result details</summary>
        <dl className="binding-list">
          <div>
            <dt>Result</dt>
            <dd>{result.id}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{result.revision_id}</dd>
          </div>
          <div>
            <dt>Metric hash</dt>
            <dd>{result.metric_hash}</dd>
          </div>
          <div>
            <dt>Snapshot hash</dt>
            <dd>{result.snapshot_hash}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
