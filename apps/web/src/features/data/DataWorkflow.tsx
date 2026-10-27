import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  casePath,
  resource,
  workspacePath,
  type Workspace,
} from "../../api";
import { commandKey, type CommandIdentity } from "../../command-key";
import {
  Empty,
  ErrorNotice,
  Loading,
  formError,
} from "../../ui";
import { ImportPanel } from "./ImportPanel";
import { SourceCapturePanel } from "../providers/SourceCapturePanel";
import { MetricPanel } from "./MetricPanel";
import {
  SnapshotSelection,
  type SelectionInvestigation,
  type SnapshotSelectionReceipt,
  type SelectableSnapshot,
} from "./SnapshotSelection";
import {
  CaseNavigation,
  ComparisonResult,
  JobPanel,
  useJobRecovery,
} from "./Presentation";
import { CasePreflight } from "../cases/Controls";
import {
  safeId,
  type AcceptedJob,
  type Comparison,
  type ImportRecord,
  type Job,
  type MetricRecord,
} from "./types";
import { boundedResource } from "../../read-state";
import { readRecords } from "./read-records";
import {
  JobCursorStore,
  watchJobEvents,
  type JobEvent,
  type JobStreamView,
} from "./job-stream";

function persistSelection(values: Record<string, string>): void {
  const current = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) current.searchParams.set(key, value);
    else current.searchParams.delete(key);
  }
  history.replaceState(null, "", current.pathname + current.search);
}

export function DataWorkflow({
  workspace,
  csrf,
  caseId,
  navigate,
  embedded = false,
  onChanged,
}: {
  workspace: Workspace;
  csrf: string;
  caseId: string;
  navigate: (path: string) => void;
  embedded?: boolean;
  onChanged?: () => void;
}) {
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const remember = useCallback((values: Record<string, string>) => {
    if (!embedded) persistSelection(values);
  }, [embedded]);
  const query = useRef(new URLSearchParams(location.search));
  const base = casePath(workspace.id, caseId);
  const [investigation, setInvestigation] =
      useState<SelectionInvestigation | null>(null),
    [snapshots, setSnapshots] = useState<SelectableSnapshot[]>([]),
    [metrics, setMetrics] = useState<MetricRecord[]>([]);
  const [snapshotsKnown, setSnapshotsKnown] = useState(false),
    [metricsKnown, setMetricsKnown] = useState(false);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true),
    [metricsLoading, setMetricsLoading] = useState(true),
    [snapshotsError, setSnapshotsError] = useState<Error | null>(null),
    [metricsError, setMetricsError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<Error | null>(null),
    [reload, setReload] = useState(0);
  const [importId, setImportId] = useState(safeId(query.current.get("import"))),
    [mappingId, setMappingId] = useState(safeId(query.current.get("mapping"))),
    [currentImport, setCurrentImport] = useState<ImportRecord | null>(null);
  const [metricId, setMetricId] = useState(safeId(query.current.get("metric"))),
    [snapshotId, setSnapshotId] = useState(
      safeId(query.current.get("snapshot")),
    );
  const [jobId, setJobId] = useState(safeId(query.current.get("job"))),
    [job, setJob] = useState<Job | null>(null),
    [jobPending, setJobPending] = useState(false),
    [jobError, setJobError] = useState<Error | null>(null),
    [jobRefresh, setJobRefresh] = useState(0);
  const jobBinding = `${workspace.id}/${caseId}/${jobId}`,
    activeJobBinding = useRef(jobBinding);
  activeJobBinding.current = jobBinding;
  const cursorStore = useRef<JobCursorStore | null>(null),
    eventMetadata = useRef(new Map<string, JobEvent>()),
    accessClosedBinding = useRef<string | null>(null),
    streamController = useRef<AbortController | null>(null);
  if (!cursorStore.current) {
    let storage: Storage | undefined;
    try {
      storage = sessionStorage;
    } catch {
      /* Cursor persistence may be unavailable in this browser. */
    }
    cursorStore.current = new JobCursorStore(storage);
  }
  const [jobAuthority, setJobAuthority] = useState(false),
    [streamRestart, setStreamRestart] = useState(0),
    [streamState, setStreamState] = useState<
      (JobStreamView & { binding: string }) | null
    >(null);
  const [comparisonId, setComparisonId] = useState(
      safeId(query.current.get("comparison")),
    ),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [comparisonPending, setComparisonPending] = useState(false),
    [comparisonError, setComparisonError] = useState<Error | null>(null);
  const compareCommand = useRef<CommandIdentity>(null),
    cancelCommand = useRef<CommandIdentity>(null),
    handledJobs = useRef(new Set<string>()),
    recordsRead = useRef<AbortController | null>(null);
  const [sourceReviewOpen, setSourceReviewOpen] = useState(
    query.current.has("capture_source"),
  );
  const [selectedArea, setSelectedArea] = useState<"data" | "metric" | "compare" | null>(null);
  const activeArea = selectedArea ?? (
    currentImport && !["accepted", "discarded"].includes(currentImport.stage)
      ? "data"
      : comparisonId
        ? "compare"
        : snapshotsKnown && metricsKnown && snapshots.length > 0
          ? "metric"
          : "data"
  );
  useEffect(() => setSelectedArea(null), [base]);
  const canMutate =
    !loading &&
    workspace.role !== "viewer" &&
    !!investigation &&
    !investigation.archived &&
    investigation.lifecycle === "open" &&
    accessClosedBinding.current !== jobBinding;
  const displayedJob = job?.id === jobId && job.case_id === caseId ? job : null;
  const streamView = streamState?.binding === jobBinding ? streamState : null;
  const terminalJob =
    !!displayedJob &&
    [
      "succeeded",
      "failed",
      "cancelled",
      "waiting_for_input",
      "blocked",
    ].includes(displayedJob.status);
  const streamEligible =
    !!displayedJob &&
    !terminalJob &&
    accessClosedBinding.current !== jobBinding;
  const invalidateJobAccess = useCallback((binding: string) => {
    if (activeJobBinding.current !== binding) return;
    accessClosedBinding.current = binding;
    streamController.current?.abort();
    recordsRead.current?.abort();
    const cause = new ApiError(
      403,
      "JOB_ACCESS_CLOSED",
      "The recorded job is no longer accessible. Previously displayed job and input authority has been cleared. Refresh to recheck access.",
    );
    setJob(null);
    setJobAuthority(false);
    setJobPending(false);
    setJobError(cause);
    setError(cause);
    setInvestigation(null);
    setLoading(false);
    setSnapshots([]);
    setMetrics([]);
    setSnapshotsKnown(false);
    setMetricsKnown(false);
    setSnapshotsLoading(false);
    setMetricsLoading(false);
    setCurrentImport(null);
    setComparison(null);
    eventMetadata.current.delete(binding);
    setStreamState({
      binding,
      connection: {
        state: "access_closed",
        cursor: cursorStore.current!.get(binding),
        reason: cause.message,
      },
      lastEvent: null,
      lastJobReadAt: null,
    });
  }, []);
  function refreshJob() {
    const recheckAccess = accessClosedBinding.current === jobBinding;
    accessClosedBinding.current = null;
    setJobAuthority(false);
    setJobRefresh((value) => value + 1);
    setStreamRestart((value) => value + 1);
    if (recheckAccess) setReload((value) => value + 1);
  }

  const loadRecords = useCallback(async () => {
    recordsRead.current?.abort();
    const controller = new AbortController();
    recordsRead.current = controller;
    setLoading(true);
    setSnapshotsLoading(true);
    setMetricsLoading(true);
    setSnapshotsKnown(false);
    setMetricsKnown(false);
    setSnapshots([]);
    setMetrics([]);
    setSnapshotsError(null);
    setMetricsError(null);
    setError(null);
    try {
      await readRecords(base, controller.signal, {
        investigation: (state) => {
          if (
            state.status === "ready" &&
            state.value.id === caseId &&
            state.value.workspace_id === workspace.id
          )
            setInvestigation(state.value);
          else {
            setInvestigation(null);
            setError(
              state.status === "unavailable"
                ? state.error
                : new Error(
                    "The returned investigation did not match the selected workspace and case.",
                  ),
            );
          }
          setLoading(false);
        },
        snapshots: (state) => {
          if (state.status === "ready") {
            setSnapshots(state.value);
            setSnapshotsKnown(true);
          } else setSnapshotsError(state.error);
          setSnapshotsLoading(false);
        },
        metrics: (state) => {
          if (state.status === "ready") {
            setMetrics(state.value);
            setMetricsKnown(true);
          } else setMetricsError(state.error);
          setMetricsLoading(false);
        },
      });
      if (!controller.signal.aborted) changed.current?.();
    } finally {
      if (recordsRead.current === controller) recordsRead.current = null;
    }
  }, [base, caseId, workspace.id]);
  useEffect(() => {
    void loadRecords();
    return () => recordsRead.current?.abort();
  }, [loadRecords, reload]);
  useEffect(() => {
    if (!importId || !canMutate) {
      setCurrentImport(null);
      return;
    }
    const controller = new AbortController();
    resource<ImportRecord>(`${base}/imports/${encodeURIComponent(importId)}`, {
      signal: controller.signal,
    })
      .then((record) => {
        if (
          controller.signal.aborted ||
          accessClosedBinding.current === activeJobBinding.current
        )
          return;
        setCurrentImport(record);
        if (record.mapping_id) {
          setMappingId(record.mapping_id);
          remember({ mapping: record.mapping_id });
        }
      })
      .catch((cause) => {
        if (
          !controller.signal.aborted &&
          accessClosedBinding.current !== activeJobBinding.current
        )
          setError(formError(cause));
      });
    return () => controller.abort();
  }, [base, importId, canMutate, reload]);
  useEffect(() => {
    if (!jobId || accessClosedBinding.current === jobBinding) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      polls = 0;
    async function readJob() {
      if (
        controller.signal.aborted ||
        activeJobBinding.current !== jobBinding ||
        accessClosedBinding.current === jobBinding
      )
        return;
      setJobPending(true);
      setJobError(null);
      try {
        const next = await boundedResource<Job & { workspace_id?: string }>(
          `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(jobId)}`,
          controller.signal,
        );
        if (
          next?.id !== jobId ||
          next.case_id !== caseId ||
          (next.workspace_id !== undefined &&
            next.workspace_id !== workspace.id)
        )
          throw new Error(
            "The recorded job does not match the selected workspace and investigation.",
          );
        if (
          !controller.signal.aborted &&
          activeJobBinding.current === jobBinding &&
          accessClosedBinding.current !== jobBinding
        ) {
          setJob(next);
          setJobAuthority(true);
          setStreamState((previous) => ({
            binding: jobBinding,
            connection:
              previous?.binding === jobBinding
                ? previous.connection
                : {
                    state: "connecting",
                    cursor: cursorStore.current!.get(jobBinding),
                  },
            lastEvent:
              previous?.binding === jobBinding
                ? previous.lastEvent
                : (eventMetadata.current.get(jobBinding) ?? null),
            lastJobReadAt: new Date().toISOString(),
          }));
          if (
            ![
              "succeeded",
              "failed",
              "cancelled",
              "waiting_for_input",
              "blocked",
            ].includes(next.status)
          )
            timer = setTimeout(readJob, ++polls < 20 ? 2000 : 5000);
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          activeJobBinding.current === jobBinding
        ) {
          if (
            cause instanceof ApiError &&
            [401, 403, 404].includes(cause.status)
          )
            invalidateJobAccess(jobBinding);
          else {
            setJobAuthority(false);
            setJobError(formError(cause));
            timer = setTimeout(readJob, ++polls < 20 ? 2000 : 5000);
          }
        }
      } finally {
        if (
          !controller.signal.aborted &&
          activeJobBinding.current === jobBinding
        )
          setJobPending(false);
      }
    }
    void readJob();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    workspace.id,
    caseId,
    jobId,
    jobBinding,
    jobRefresh,
    invalidateJobAccess,
  ]);
  useEffect(() => {
    if (!jobId || accessClosedBinding.current === jobBinding) return;
    if (terminalJob) {
      setStreamState((previous) => ({
        binding: jobBinding,
        connection: {
          state: "closed",
          cursor: cursorStore.current!.get(jobBinding),
          reason:
            "Stream closed after the recorded-job read returned a terminal state.",
        },
        lastEvent:
          previous?.binding === jobBinding
            ? previous.lastEvent
            : (eventMetadata.current.get(jobBinding) ?? null),
        lastJobReadAt:
          previous?.binding === jobBinding ? previous.lastJobReadAt : null,
      }));
      return;
    }
    if (!streamEligible) return;
    const controller = new AbortController();
    streamController.current = controller;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      !controller.signal.aborted &&
      activeJobBinding.current === jobBinding &&
      accessClosedBinding.current !== jobBinding;
    const refreshFromEvent = () => {
      if (refreshTimer || !current()) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (current()) setJobRefresh((value) => value + 1);
      }, 150);
    };
    const online = () => {
      if (current()) {
        setJobAuthority(false);
        setStreamRestart((value) => value + 1);
        refreshFromEvent();
      }
    };
    window.addEventListener("online", online);
    void watchJobEvents(
      `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(jobId)}/events`,
      {
        signal: controller.signal,
        cursor: cursorStore.current!.get(jobBinding),
        onEvent: (event) => {
          if (!current()) return;
          cursorStore.current!.set(jobBinding, event.id);
          eventMetadata.current.set(jobBinding, event);
          while (eventMetadata.current.size > 20)
            eventMetadata.current.delete(
              eventMetadata.current.keys().next().value!,
            );
          setStreamState((previous) => ({
            binding: jobBinding,
            connection: { state: "connected", cursor: event.id },
            lastEvent: event,
            lastJobReadAt:
              previous?.binding === jobBinding ? previous.lastJobReadAt : null,
          }));
          refreshFromEvent();
        },
        onConnection: (connection) => {
          if (!current()) return;
          if (connection.state === "access_closed") {
            invalidateJobAccess(jobBinding);
            return;
          }
          setStreamState((previous) => ({
            binding: jobBinding,
            connection,
            lastEvent:
              previous?.binding === jobBinding
                ? previous.lastEvent
                : (eventMetadata.current.get(jobBinding) ?? null),
            lastJobReadAt:
              previous?.binding === jobBinding ? previous.lastJobReadAt : null,
          }));
          if (["reconnecting", "unavailable"].includes(connection.state)) {
            setJobAuthority(false);
            refreshFromEvent();
          }
        },
      },
    ).catch(() => {
      if (current()) {
        setJobAuthority(false);
        setStreamState((previous) => ({
          binding: jobBinding,
          connection: {
            state: "unavailable",
            cursor: cursorStore.current!.get(jobBinding),
            reason:
              "Progress transport is unavailable. Recorded-job polling remains separate.",
          },
          lastEvent:
            previous?.binding === jobBinding ? previous.lastEvent : null,
          lastJobReadAt:
            previous?.binding === jobBinding ? previous.lastJobReadAt : null,
        }));
        refreshFromEvent();
      }
    });
    return () => {
      controller.abort();
      window.removeEventListener("online", online);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (streamController.current === controller)
        streamController.current = null;
    };
  }, [
    workspace.id,
    caseId,
    jobId,
    jobBinding,
    streamEligible,
    terminalJob,
    streamRestart,
    invalidateJobAccess,
  ]);
  useEffect(() => {
    if (
      !job ||
      job.id !== jobId ||
      job.case_id !== caseId ||
      !jobAuthority ||
      accessClosedBinding.current === jobBinding ||
      job.status !== "succeeded" ||
      handledJobs.current.has(job.id)
    )
      return;
    const snapshot = safeId(
        typeof job.result?.snapshot_id === "string"
          ? job.result.snapshot_id
          : null,
      ),
      result = safeId(
        typeof job.result?.comparison_id === "string"
          ? job.result.comparison_id
          : null,
      );
    const stagedImport = safeId(
      typeof job.result?.import_id === "string" ? job.result.import_id : null,
    );
    if (stagedImport && job.result?.status !== "staged") {
      setJobError(
        new Error(
          "The source job did not record a staged-import result. Review its actual terminal state; no snapshot is accepted.",
        ),
      );
      return;
    }
    if (!snapshot && !result && !stagedImport) {
      setJobError(
        new Error(
          "Computation completed without the expected snapshot or comparison reference. Its domain outcome is not established.",
        ),
      );
      return;
    }
    handledJobs.current.add(job.id);
    if (stagedImport) {
      setSelectedArea("data");
      setImportId(stagedImport);
      setMappingId("");
      setCurrentImport(null);
      remember({ import: stagedImport, mapping: "" });
    }
    if (snapshot) {
      setSnapshotId(snapshot);
      remember({ snapshot });
    }
    if (result) {
      setSelectedArea("compare");
      setComparisonId(result);
      remember({ comparison: result });
    }
    setReload((value) => value + 1);
  }, [job, jobId, caseId, jobAuthority, jobBinding]);
  useEffect(() => {
    if (!comparisonId) {
      setComparison(null);
      return;
    }
    const controller = new AbortController();
    setComparisonPending(true);
    setComparisonError(null);
    setComparison(null);
    boundedResource<Comparison>(
      `${base}/comparisons/${encodeURIComponent(comparisonId)}`,
      controller.signal,
    )
      .then((value) => {
        if (
          !controller.signal.aborted &&
          accessClosedBinding.current !== activeJobBinding.current
        ) {
          if (
            value?.id !== comparisonId ||
            !["fresh", "stale"].includes(value.freshness)
          )
            throw new Error(
              "The selected comparison or its authoritative freshness was unavailable.",
            );
          setComparison(value);
        }
      })
      .catch((cause) => {
        if (
          !controller.signal.aborted &&
          accessClosedBinding.current !== activeJobBinding.current
        ) {
          setComparison(null);
          setComparisonError(formError(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setComparisonPending(false);
      });
    return () => controller.abort();
  }, [base, comparisonId, reload]);

  function imported(record: ImportRecord, mapping?: string) {
    setSelectedArea("data");
    setCurrentImport(record);
    setImportId(record.id);
    if (mapping !== undefined) setMappingId(mapping);
    remember({
      import: record.id,
      ...(mapping !== undefined ? { mapping } : {}),
    });
    changed.current?.();
  }
  function discardedImport() {
    setCurrentImport(null);
    setImportId("");
    setMappingId("");
    remember({ import: "", mapping: "" });
    setReload((value) => value + 1);
  }
  function acceptedJob(
    accepted: AcceptedJob,
    kind: "import" | "comparison" | "source",
  ) {
    if (!accepted?.job_id)
      throw new Error(
        "The accepted command did not return a durable job identity.",
      );
    if (kind === "comparison") setSelectedArea("compare");
    setJob(null);
    setJobAuthority(false);
    setJobId(accepted.job_id);
    setJobError(null);
    remember({ job: accepted.job_id, job_kind: kind });
    changed.current?.();
  }
  const recovery = useJobRecovery({
    workspaceId: workspace.id,
    caseId,
    role: workspace.role,
    csrf,
    job: displayedJob,
    canMutate: canMutate && jobAuthority && !jobError,
    onAccepted: (value) =>
      acceptedJob(
        value,
        (displayedJob as import("./Presentation").RecoveryJob | null)?.kind ===
          "source_capture"
          ? "source"
          : (displayedJob as import("./Presentation").RecoveryJob | null)
                ?.kind === "import_commit"
            ? "import"
            : "comparison",
      ),
  });
  function selectedMetric(id: string, record?: MetricRecord) {
    setMetricId(id);
    if (record)
      setMetrics((previous) => [
        ...previous.filter((metric) => metric.id !== record.id),
        record,
      ]);
    remember({ metric: id });
    if (record) changed.current?.();
  }
  async function frozenMetric(id: string) {
    setSelectedArea("metric");
    setMetricId(id);
    remember({ metric: id });
    setError(null);
    setLoading(true);
    setComparison(null);
    setReload((value) => value + 1);
  }
  function savedSnapshotBundle(_receipt: SnapshotSelectionReceipt) {
    setMetricId("");
    setSnapshotId("");
    remember({ metric: "", snapshot: "" });
    setError(null);
    setLoading(true);
    setComparison(null);
    setReload((value) => value + 1);
  }
  async function compare(revisionId: string) {
    const path = `${base}/comparisons`,
      body = { revision_id: revisionId };
    const accepted = await resource<AcceptedJob>(path, {
      method: "POST",
      csrf,
      body,
      idempotencyKey: commandKey(compareCommand, {
        path,
        method: "POST",
        body,
      }),
    });
    compareCommand.current = null;
    acceptedJob(accepted, "comparison");
  }
  async function cancelJob(reason: string) {
    if (
      !displayedJob ||
      !jobAuthority ||
      jobError ||
      accessClosedBinding.current === jobBinding ||
      typeof displayedJob.attempt !== "number"
    )
      throw new Error(
        "Refresh the permitted recorded job and attempt before requesting cancellation.",
      );
    const path = `${workspacePath(workspace.id)}/jobs/${encodeURIComponent(displayedJob.id)}/cancel`,
      body = { reason };
    await resource(path, {
      method: "POST",
      csrf,
      body,
      revision: displayedJob.attempt,
      idempotencyKey: commandKey(cancelCommand, {
        path,
        method: "POST",
        body,
        revision: displayedJob.attempt,
      }),
    });
    cancelCommand.current = null;
    setJobRefresh((value) => value + 1);
  }
  const comparisonView = (
    <>
      {loading || comparisonPending ? (
        <Loading label="Loading comparison…" />
      ) : comparison ? (
        <ComparisonResult result={comparison} />
      ) : (
        <section className="panel">
          <h2>{comparisonId ? "Result unavailable" : "Compare sessions"}</h2>
          <p>Choose saved data and lock a metric to compare periods.</p>
        </section>
      )}
    </>
  );
  if (loading && !investigation) return <Loading label="Loading data…" />;
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
        current="data"
        navigate={navigate}
      />
      <div className="page-heading data-heading">
        <div>
          <p className="eyebrow">Data</p>
          <h1>{investigation?.title ?? "Investigation unavailable"}</h1>
          <p>
            {investigation?.question ?? "This investigation is unavailable."}
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => {
            setError(null);
            setReload((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </div>
      </>}
      <ErrorNotice error={error} />
      {!investigation && streamView?.connection.state === "access_closed" && (
        <JobPanel
          job={null}
          pending={false}
          error={jobError}
          stream={streamView}
          authority="unknown"
          onRefresh={refreshJob}
        />
      )}
      {investigation ? (
        <>
          <nav className="data-progress" aria-label="Data workflow">
            <button type="button" aria-current={activeArea === "data" ? "step" : undefined} onClick={() => setSelectedArea("data")}>
              <b>1</b>Add data
            </button>
            <button type="button" aria-current={activeArea === "metric" ? "step" : undefined} onClick={() => setSelectedArea("metric")}>
              <b>2</b>Set metric
            </button>
            <button type="button" aria-current={activeArea === "compare" ? "step" : undefined} onClick={() => setSelectedArea("compare")}>
              <b>3</b>Compare
            </button>
          </nav>
          {investigation.archived && (
            <div className="notice warning">
              This investigation is archived. Restore it from Overview before
              changing its inputs.
            </div>
          )}
          {investigation.lifecycle !== "open" && (
            <p className="notice warning">
              This investigation is closed. Its historical inputs and results
              remain readable. Reopen it from Overview before changing evidence
              or metrics.
            </p>
          )}
          <ErrorNotice error={comparisonError} />
          <ErrorNotice error={snapshotsError} />
          {comparison?.freshness === "stale" && activeArea !== "compare" && <p className="notice warning">The recorded comparison is stale.</p>}
          {!canMutate && <div className="notice">
            <strong>Private capture review is unavailable</strong>
            <p>{workspace.role === "viewer"
              ? "Only owners and analysts can upload data. You can view permitted snapshots, metrics, and comparisons."
              : "Reopen or restore this investigation to add data."}</p>
          </div>}
          <CasePreflight workspaceId={workspace.id} item={investigation} />
          <JobPanel
            {...recovery}
            job={displayedJob}
            pending={jobPending}
            error={jobError}
            stream={streamView}
            authority={jobAuthority ? "current" : "unknown"}
            onRefresh={refreshJob}
            onCancel={
              canMutate && jobAuthority && !jobError ? cancelJob : undefined
            }
          />
          <ErrorNotice error={jobError} />
          {job?.status === "succeeded" && job.result?.status === "staged" && (
            <p className="notice">
              Data is ready for review. Check its fields and coverage before
              saving a snapshot.
            </p>
          )}
          <div className="workflow-workspace" hidden={activeArea !== "data"}>
          {canMutate && (
            <details
              className="panel optional-source-review"
              open={sourceReviewOpen}
              onToggle={(event) =>
                setSourceReviewOpen(event.currentTarget.open)
              }
            >
              <summary>Use a configured source</summary>
              {sourceReviewOpen && (
                <SourceCapturePanel
                  workspace={workspace}
                  base={base}
                  csrf={csrf}
                  onJob={acceptedJob}
                  navigate={navigate}
                />
              )}
            </details>
          )}
          {canMutate && snapshotsKnown ? (
            <ImportPanel
              key={currentImport?.id ?? "new-capture"}
              base={base}
              csrf={csrf}
              snapshots={snapshots}
              current={currentImport}
              savedMappingId={mappingId}
              onImport={imported}
              onJob={acceptedJob}
              onDiscard={discardedImport}
            />
          ) : canMutate ? (
            <section className="panel">
              {snapshotsLoading ? (
                <Loading label="Reading snapshot metadata for private capture review…" />
              ) : (
                <>
                  <p className="notice warning">
                    Private capture controls are unavailable until the current
                    snapshot metadata can be read. Refresh to retry.
                  </p>
                </>
              )}
            </section>
          ) : null}
          <SnapshotSelection
            key={base}
            base={base}
            csrf={csrf}
            role={workspace.role}
            investigation={investigation}
            snapshots={snapshots}
            canMutate={canMutate}
            metadataAvailable={snapshotsKnown}
            onSaved={savedSnapshotBundle}
          />
          </div>
          <div className="workflow-workspace" hidden={activeArea !== "metric"}>
          <MetricPanel
            metadataAvailable={snapshotsKnown && metricsKnown}
            base={base}
            csrf={csrf}
            investigation={investigation}
            snapshots={snapshots}
            metrics={metrics}
            selectedMetricId={metricId}
            selectedSnapshotId={snapshotId}
            canMutate={canMutate}
            onMetric={selectedMetric}
            onSnapshot={(id) => {
              setSnapshotId(id);
              remember({ snapshot: id });
            }}
            onFrozen={frozenMetric}
            onCompare={compare}
            onRefresh={loadRecords}
          />
          </div>
          {(!snapshotsKnown || !metricsKnown) && (
            <section className="panel">
              {snapshotsLoading || metricsLoading ? (
                <Loading label="Reading metric and snapshot bindings…" />
              ) : (
                <>
                  <ErrorNotice error={metricsError} />
                  <p className="notice warning">
                    Metric review is unavailable until its current metric and
                    snapshot lists can be read. Recorded comparison outcomes
                    remain separate from this metadata request.
                  </p>
                </>
              )}
            </section>
          )}
          <div className="workflow-workspace" hidden={activeArea !== "compare"}>
            {comparisonView}
            {!comparisonId && <button className="primary" type="button" onClick={() => setSelectedArea("metric")}>Review metric</button>}
          </div>
        </>
      ) : (
        <Empty title="Investigation unavailable">
          The selected case could not be loaded under your current workspace and
          session.
        </Empty>
      )}
    </>
  );
}
