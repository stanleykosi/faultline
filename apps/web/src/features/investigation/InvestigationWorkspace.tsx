import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  casePath,
  resource,
  workspacePath,
  type Investigation,
  type Workspace,
} from "../../api";
import { Empty, ErrorNotice, Loading, Status, formError } from "../../ui";
import {
  CaseNavigation,
  JobPanel,
  useJobRecovery,
  recordedFollowupOutcome,
  type RecoveryJob,
} from "../data/Presentation";
import {
  safeId,
  type AcceptedJob,
  type Job,
  type Snapshot,
} from "../data/types";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { CommentsPanel } from "./CommentsPanel";
import { EvidencePanel } from "./EvidencePanel";
import { TimelinePanel } from "./TimelinePanel";
import { FollowUpsPanel } from "./FollowUpsPanel";
import { HypothesesPanel } from "./HypothesesPanel";
import { ReportsPanel } from "./ReportsPanel";
import { ExternalVerificationPanel } from "./ExternalVerificationPanel";
import { ModelProposals } from "../providers/ModelProposals";
import { useCommand } from "./Shared";
import type {
  AnalyticRecord,
  AnalysisContext,
  Comment,
  Evidence,
  FollowUp,
  Hypothesis,
  PlanRecord,
  ReportRecord,
} from "./types";

const StagingRegistryPanel = lazy(() =>
  import("../targets/StagingRegistryPanel").then((module) => ({
    default: module.StagingRegistryPanel,
  })),
);
const sections = [
  ["evidence", "Evidence", "Understand"],
  ["timeline", "Timeline", "Understand"],
  ["hypotheses", "Possible causes", "Explain"],
  ["tests", "Data checks", "Explain"],
  ["verification", "Browser tests", "Test"],
  ["staging", "Test setup", "Test"],
  ["reports", "Reports", "Share"],
  ["discussion", "Discussion", "Share"],
  ["followup", "Follow-up", "Share"],
] as const;
type Section = (typeof sections)[number][0];
function persistSelection(values: Record<string, string>) {
  const url = new URL(location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  history.replaceState(null, "", url.pathname + url.search);
}

export function InvestigationWorkspace({
  workspace,
  csrf,
  currentUserId,
  caseId,
  navigate,
  embedded = false,
  onChanged,
  initialSection,
  initialDiagnosisProposalId,
  preferredModelProfileId,
}: {
  workspace: Workspace;
  csrf: string;
  currentUserId: string;
  caseId: string;
  navigate: (path: string) => void;
  embedded?: boolean;
  onChanged?: () => void;
  initialSection?: string;
  initialDiagnosisProposalId?: string;
  preferredModelProfileId?: string;
}) {
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const remember = useCallback((values: Record<string, string>) => {
    if (!embedded) persistSelection(values);
  }, [embedded]);
  const query = useRef(new URLSearchParams(location.search)),
    base = casePath(workspace.id, caseId),
    send = useCommand(csrf);
  const [tab, setTab] = useState<Section>(
    sections.some(([id]) => id === (initialSection ?? query.current.get("tab")))
      ? ((initialSection ?? query.current.get("tab")) as Section)
      : "evidence",
  );
  const [investigation, setInvestigation] = useState<Investigation | null>(
      null,
    ),
    [context, setContext] = useState<AnalysisContext | null>(null),
    [contextError, setContextError] = useState<Error | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]),
    [evidenceKnown, setEvidenceKnown] = useState(false),
    [hypotheses, setHypotheses] = useState<Hypothesis[]>([]),
    [reports, setReports] = useState<ReportRecord[]>([]),
    [comments, setComments] = useState<Comment[]>([]),
    [followups, setFollowups] = useState<FollowUp[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [errors, setErrors] = useState<Record<string, Error>>({}),
    [version, setVersion] = useState(0);
  const [planId, setPlanId] = useState(safeId(query.current.get("plan"))),
    [plan, setPlan] = useState<PlanRecord | null>(null),
    [planError, setPlanError] = useState<Error | null>(null);
  const [reportId, setReportId] = useState(safeId(query.current.get("report"))),
    [selectedReport, setSelectedReport] = useState<ReportRecord | null>(null),
    [reportError, setReportError] = useState<Error | null>(null);
  const [jobId, setJobId] = useState(safeId(query.current.get("job"))),
    [job, setJob] = useState<Job | null>(null),
    [jobError, setJobError] = useState<Error | null>(null),
    [jobPending, setJobPending] = useState(false),
    [jobRefresh, setJobRefresh] = useState(0);
  const [resultId, setResultId] = useState(safeId(query.current.get("result"))),
    [result, setResult] = useState<AnalyticRecord | null>(null),
    [resultError, setResultError] = useState<Error | null>(null),
    [resultPending, setResultPending] = useState(false),
    handledJobs = useRef(new Set<string>());
  const canMutate =
    workspace.role !== "viewer" &&
    !!investigation &&
    !investigation.archived &&
    investigation.lifecycle === "open";
  const recordsLoad = useRef<AbortController | null>(null),
    refreshIdentity = useRef(0);
  const loadRecords = useCallback(
    async (signal?: AbortSignal) => {
      recordsLoad.current?.abort();
      const controller = new AbortController();
      recordsLoad.current = controller;
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abort, {once: true});
      const paths = [
        "",
        "/analysis-context",
        "/evidence",
        "/hypotheses",
        "/reports",
        "/comments",
        "/follow-ups",
        "/snapshots",
      ];
      const values: PromiseSettledResult<unknown>[] = new Array(paths.length);
      let next = 0;
      async function readNext() {
        while (!controller.signal.aborted) {
          const index = next++;
          if (index >= paths.length) return;
          try {
            const value = await resource<unknown>(base + paths[index], {signal: controller.signal});
            values[index] = {status: "fulfilled", value};
          } catch (reason) {
            values[index] = {status: "rejected", reason};
          }
        }
      }
      // Inventory reads share a small database pool. Each worker waits for its
      // current read before dispatching the next resource, including on failure.
      await Promise.all([readNext(), readNext()]);
      signal?.removeEventListener("abort", abort);
      if (controller.signal.aborted || recordsLoad.current !== controller) return false;
      const failures: Record<string, Error> = {};
      function valueAt<T>(index: number, list = false): T | null {
        const value = values[index];
        if (value.status === "rejected") {
          if (!(
            index === 1 &&
            value.reason instanceof ApiError &&
            value.reason.code === "INPUTS_REQUIRED"
          ))
            failures[paths[index] || "case"] = formError(value.reason);
          return null;
        }
        if (list && !Array.isArray(value.value)) {
          failures[paths[index]] = new Error(
            `${paths[index].slice(1).replaceAll('-', ' ')} is unavailable.`,
          );
          return null;
        }
        return value.value as T;
      }
      const currentCase = valueAt<Investigation>(0);
      setInvestigation(currentCase);
      const currentContext = valueAt<AnalysisContext>(1);
      setContext(currentContext);
      setContextError(
        values[1].status === "rejected" ? formError(values[1].reason) : null,
      );
      const currentEvidence = valueAt<Evidence[]>(2, true);
      setEvidence(currentEvidence ?? []);
      setEvidenceKnown(currentEvidence !== null);
      setHypotheses(valueAt<Hypothesis[]>(3, true) ?? []);
      setReports(valueAt<ReportRecord[]>(4, true) ?? []);
      setComments(valueAt<Comment[]>(5, true) ?? []);
      setFollowups(valueAt<FollowUp[]>(6, true) ?? []);
      setSnapshots(valueAt<Snapshot[]>(7, true) ?? []);
      setErrors(failures);
      if (currentCase && Object.keys(failures).length === 0) changed.current?.();
      return true;
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    refreshIdentity.current += 1;
    setLoading(true);
    setRefreshing(false);
    void loadRecords(controller.signal).then(published => {
      if (published && !controller.signal.aborted) setLoading(false);
    });
    return () => {
      controller.abort();
      recordsLoad.current?.abort();
    };
  }, [loadRecords]);
  async function refresh(id?: string) {
    const identity = ++refreshIdentity.current;
    setRefreshing(true);
    try {
      const published = await loadRecords();
      if (!published || refreshIdentity.current !== identity) return;
      setLoading(false);
      if (id) chooseReport(id);
      setVersion((previous) => previous + 1);
    } finally {
      if (refreshIdentity.current === identity) setRefreshing(false);
    }
  }
  function chooseReport(id: string) {
    setReportId(id);
    remember({ report: id });
  }
  useEffect(() => {
    if (!reportId && reports[0]) chooseReport(reports[0].id);
  }, [reports, reportId]);
  useEffect(() => {
    if (!planId) {
      setPlan(null);
      return;
    }
    const controller = new AbortController();
    setPlanError(null);
    resource<PlanRecord>(
      `${base}/analytic-plans/${encodeURIComponent(planId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setPlan(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setPlan(null);
          setPlanError(formError(cause));
        }
      });
    return () => controller.abort();
  }, [base, planId, version]);
  useEffect(() => {
    if (!reportId) {
      setSelectedReport(null);
      return;
    }
    const controller = new AbortController();
    setReportError(null);
    resource<ReportRecord>(`${base}/reports/${encodeURIComponent(reportId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSelectedReport(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setSelectedReport({
            id: reportId,
            reason: "Current report citations or access are unavailable.",
          });
          setReportError(formError(cause));
        }
      });
    return () => controller.abort();
  }, [base, reportId, version]);
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      polls = 0;
    async function read() {
      setJobPending(true);
      setJobError(null);
      try {
        const value = await resource<Job>(
          `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(jobId)}`,
          { signal: controller.signal },
        );
        if (value.case_id && value.case_id !== caseId)
          throw new Error("The selected job belongs to another investigation.");
        if (!controller.signal.aborted) {
          setJob(value);
          if (
            ![
              "succeeded",
              "failed",
              "cancelled",
              "waiting_for_input",
              "blocked",
            ].includes(value.status)
          )
            timer = setTimeout(read, ++polls < 20 ? 2000 : 5000);
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
  }, [workspace.id, caseId, jobId, jobRefresh]);
  useEffect(() => {
    if (!job || job.status !== "succeeded" || handledJobs.current.has(job.id))
      return;
    if ((job as RecoveryJob).kind === "followup_due") {
      const outcome = recordedFollowupOutcome(job);
      if (!outcome || outcome.state !== "compared") {
        setJobError(
          new Error(
            "The follow-up job completed without its recognized recorded domain outcome. Its result remains unknown.",
          ),
        );
        return;
      }
      handledJobs.current.add(job.id);
      void refresh();
      return;
    }
    if ((job as RecoveryJob).kind === "external_browser_execute") {
      handledJobs.current.add(job.id);
      setVersion((value) => value + 1);
      void refresh();
      return;
    }
    const id = safeId(
      typeof job.result?.analytic_result_id === "string"
        ? job.result.analytic_result_id
        : null,
    );
    if (!id) {
      setJobError(
        new Error(
          "Computation completed without a recorded analytic-result identity. No domain verdict is inferred.",
        ),
      );
      return;
    }
    handledJobs.current.add(job.id);
    setResultId(id);
    remember({ result: id });
    setVersion((value) => value + 1);
  }, [job]);
  useEffect(() => {
    if (!resultId) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    setResultPending(true);
    setResultError(null);
    resource<AnalyticRecord>(
      `${base}/analytic-results/${encodeURIComponent(resultId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setResultError(formError(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setResultPending(false);
      });
    return () => controller.abort();
  }, [base, resultId, version]);
  function acceptedJob(accepted: AcceptedJob) {
    if (!accepted?.job_id)
      throw new Error("No durable job identity was returned.");
    setJobId(accepted.job_id);
    setJob(null);
    setResultId("");
    setResult(null);
    remember({ job: accepted.job_id, result: "" });
    changed.current?.();
  }
  const recovery = useJobRecovery({
    workspaceId: workspace.id,
    caseId,
    role: workspace.role,
    csrf,
    job,
    canMutate,
    onAccepted: acceptedJob,
  });
  async function cancelJob(reason: string) {
    if (!job || typeof job.attempt !== "number")
      throw new Error(
        "Refresh the persisted job attempt before requesting cancellation.",
      );
    await send(
      `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(job.id)}/cancel`,
      { reason },
      "POST",
      job.attempt,
    );
    setJobRefresh((value) => value + 1);
  }
  if (loading) return <Loading label="Loading investigation…" />;
  return (
    <>
      {!embedded && <>
      <button
        className="back-link"
        onClick={() => navigate(`/w/${workspace.id}/cases`)}
      >
        ← All investigations
      </button>
      <CaseNavigation
        workspaceId={workspace.id}
        caseId={caseId}
        current="investigation"
        navigate={navigate}
      />
      <div className="page-heading">
        <div>
          <p className="eyebrow">Investigation</p>
          <h1>{investigation?.title ?? "Investigation unavailable"}</h1>
          <p>
            {investigation?.question ?? "This investigation is unavailable."}
          </p>
        </div>
        <button
          className="secondary"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      </>}
      {Object.entries(errors).map(([name, error]) => (
        <div key={name}>
          <p className="tiny-label">
            {name.replaceAll("/", "") || "Investigation"} unavailable
          </p>
          <ErrorNotice error={error} />
        </div>
      ))}
      {investigation ? (
        <>
          <div className="investigation-context">
            <Status>{investigation.lifecycle}</Status>
            <span>{workspace.role}</span>
            <details>
              <summary>Investigation details</summary>
              <span>Input revision {investigation.active_revision_id}</span>
              <span> · Investigation revision {investigation.revision}</span>
            </details>
          </div>
          {investigation.archived && (
            <p className="notice warning">
              This investigation is archived. Restore it from Overview to make changes.
            </p>
          )}
          {investigation.lifecycle !== "open" && (
            <p className="notice warning">
              This investigation is closed. Reopen it from Overview to make changes.
            </p>
          )}
          {contextError && (
            <p className="notice warning">
              Current test inputs are unavailable: {contextError.message}
            </p>
          )}
          <label className="investigation-section-picker">
            <span>Work area</span>
            <select value={tab} onChange={event => {const id = event.target.value as Section; setTab(id); remember({tab: id});}}>
              {['Understand', 'Explain', 'Test', 'Share'].map(group => <optgroup label={group} key={group}>{sections.filter(([, , sectionGroup]) => sectionGroup === group).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</optgroup>)}
            </select>
          </label>
          <div
            id="panel-evidence"
            hidden={tab !== "evidence"}
          >
            <EvidencePanel
              base={base}
              csrf={csrf}
              evidence={evidence}
              known={evidenceKnown}
              canMutate={canMutate}
              isOwner={workspace.role === "owner"}
              onChanged={refresh}
            />
          </div>
          <div
            id="panel-timeline"
            hidden={tab !== "timeline"}
          >
            {tab === "timeline" && <TimelinePanel base={base} />}
          </div>
          <div
            id="panel-hypotheses"
            hidden={tab !== "hypotheses"}
          >
            <HypothesesPanel
              base={base}
              csrf={csrf}
              hypotheses={hypotheses}
              known={!errors["/hypotheses"]}
              evidence={evidence}
              context={context}
              canMutate={canMutate}
              onChanged={refresh}
            />
            <ModelProposals
              base={base}
              workspace={workspace}
              csrf={csrf}
              investigation={investigation}
              context={context}
              evidence={evidence}
              canMutate={canMutate}
              refreshToken={version}
              onChanged={refresh}
            />
          </div>
          <div
            id="panel-tests"
            hidden={tab !== "tests"}
          >
            <JobPanel
              {...recovery}
              job={job}
              pending={jobPending}
              error={jobError}
              onRefresh={() => setJobRefresh((value) => value + 1)}
              onCancel={canMutate ? cancelJob : undefined}
            />
            <ErrorNotice error={jobError} />
            <ErrorNotice error={planError} />
            <ErrorNotice error={resultError} />
            <AnalyticsPanel
              base={base}
              csrf={csrf}
              context={context}
              hypotheses={hypotheses}
              evidence={evidence}
              canMutate={canMutate}
              plan={plan}
              result={result}
              resultPending={resultPending}
              onPlan={(value) => {
                setPlan(value);
                setPlanId(value.id);
                remember({ plan: value.id });
                changed.current?.();
              }}
              onJob={acceptedJob}
            />
          </div>
          <div
            id="panel-verification"
            hidden={tab !== "verification"}
          >
            <JobPanel
              {...recovery}
              job={job}
              pending={jobPending}
              error={jobError}
              onRefresh={() => setJobRefresh((value) => value + 1)}
              onCancel={canMutate ? cancelJob : undefined}
            />
            <ExternalVerificationPanel
              base={base}
              workspace={workspace}
              csrf={csrf}
              investigation={investigation}
              hypotheses={hypotheses}
              evidence={evidence}
              refreshToken={version}
              onChanged={refresh}
              onJob={acceptedJob}
            />
          </div>
          <div
            id="panel-staging"
            hidden={tab !== "staging"}
          >
            {tab === "staging" && (
              <Suspense fallback={<Loading label="Loading test setup…" />}>
                <StagingRegistryPanel
                  base={base}
                  workspace={workspace}
                  csrf={csrf}
                  investigation={investigation}
                  evidence={evidence}
                />
              </Suspense>
            )}
          </div>
          <div
            id="panel-reports"
            hidden={tab !== "reports"}
          >
            <ErrorNotice error={reportError} />
            <ReportsPanel
              initialDiagnosisProposalId={initialDiagnosisProposalId}
              preferredModelProfileId={preferredModelProfileId}
              role={workspace.role}
              base={base}
              csrf={csrf}
              context={context}
              reports={reports}
              known={!errors["/reports"]}
              selectedReport={selectedReport}
              evidence={evidence}
              analyticResult={result}
              canMutate={canMutate}
              onSelect={chooseReport}
              onChanged={refresh}
            />
          </div>
          <div
            id="panel-discussion"
            hidden={tab !== "discussion"}
          >
            <CommentsPanel
              base={base}
              csrf={csrf}
              comments={comments}
              known={!errors["/comments"]}
              evidence={evidence}
              currentUserId={currentUserId}
              isOwner={workspace.role === "owner"}
              canMutate={canMutate}
              onChanged={refresh}
            />
          </div>
          <div
            id="panel-followup"
            hidden={tab !== "followup"}
          >
            <FollowUpsPanel
              base={base}
              csrf={csrf}
              investigation={investigation}
              context={context}
              followups={followups}
              known={!errors["/follow-ups"]}
              snapshots={snapshots}
              evidence={evidence}
              canMutate={canMutate}
              onChanged={refresh}
            />
          </div>
        </>
      ) : (
        <Empty title="Investigation unavailable">Refresh to try again.</Empty>
      )}
    </>
  );
}
