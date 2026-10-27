import { useCallback, useEffect, useState } from "react";
import { resource, workspacePath, type Workspace } from "../../api";
import {
  Empty,
  ErrorNotice,
  Loading,
  Status,
  dateLabel,
  formError,
} from "../../ui";

export interface WorkspaceJob {
  id: string;
  case_id: string;
  revision_id: string;
  kind: string;
  status: string;
  attempt: number;
  retry_of: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}
export function WorkspaceJobTable({
  jobs,
  workspaceId,
  navigate,
}: {
  jobs: WorkspaceJob[];
  workspaceId: string;
  navigate: (path: string) => void;
}) {
  return (
    <div
      className="table-scroll"
      role="region"
      aria-label="Workspace runs"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Investigation</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <strong>{job.kind.replaceAll("_", " ")}</strong>
                <details>
                  <summary>Details</summary>
                  <small>{job.id}</small>
                  {job.retry_of && <small>Retry of {job.retry_of}</small>}
                </details>
              </td>
              <td>
                <Status
                  tone={
                    [
                      "failed",
                      "blocked",
                      "cancelled",
                      "waiting_for_input",
                    ].includes(job.status)
                      ? "warning"
                      : "neutral"
                  }
                >
                  {job.status || "Unknown"}
                </Status>
                {job.error_code && <small>{job.error_code}</small>}
              </td>
              <td>
                {job.attempt}
                <details>
                  <summary>Input</summary>
                  <small>Revision {job.revision_id}</small>
                </details>
              </td>
              <td>
                <button
                  className="text-button"
                  onClick={() =>
                    navigate(
                      `/w/${encodeURIComponent(workspaceId)}/cases/${encodeURIComponent(job.case_id)}`,
                    )
                  }
                >
                  Open
                </button>
              </td>
              <td>{dateLabel(job.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function WorkspaceJobs({
  workspace,
  csrf: _csrf,
  navigate,
}: {
  workspace: Workspace;
  csrf: string;
  navigate: (path: string) => void;
}) {
  const [jobs, setJobs] = useState<WorkspaceJob[] | null>(null),
    [pending, setPending] = useState(true),
    [error, setError] = useState<Error | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setPending(true);
      setError(null);
      try {
        const value = await resource<WorkspaceJob[]>(
          `${workspacePath(workspace.id)}/jobs`,
          { signal },
        );
        if (!Array.isArray(value))
          throw Error("The recorded workspace job inventory was unavailable.");
        if (!signal?.aborted) setJobs(value);
      } catch (cause) {
        if (!signal?.aborted) setError(formError(cause));
      } finally {
        if (!signal?.aborted) setPending(false);
      }
    },
    [workspace.id],
  );
  useEffect(() => {
    setJobs(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>
            Runs<span className="heading-dot">.</span>
          </h1>
          <p>Recent work in {workspace.name}.</p>
        </div>
        <button
          className="secondary"
          disabled={pending}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      <p className="notice">
        A completed run can still fail its checks. Open the investigation to see
        the result.
      </p>
      <ErrorNotice error={error} />
      {pending && <Loading label="Loading runs…" />}
      {jobs?.length ? (
        <WorkspaceJobTable
          jobs={jobs}
          workspaceId={workspace.id}
          navigate={navigate}
        />
      ) : jobs ? (
        <Empty title="No runs yet">Runs will appear here.</Empty>
      ) : (
        !pending && (
          <Empty title="Runs unavailable">Fix the error and refresh.</Empty>
        )
      )}
    </>
  );
}
