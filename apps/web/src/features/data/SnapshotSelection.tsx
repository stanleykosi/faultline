import { useEffect, useRef, useState, type FormEvent } from "react";
import { casePath, resource, type Investigation, type Role } from "../../api";
import { commandKey, type CommandIdentity } from "../../command-key";
import { boundedResource } from "../../read-state";
import { ErrorNotice, Field, Loading, Status, formError } from "../../ui";
import { CoverageSummary } from "./Presentation";
import { safeId, type Coverage, type Snapshot } from "./types";

export type SnapshotReference = {
  id: string;
  content_hash: string;
  source_id: string;
};
export type SnapshotSelectionValue = {
  revision_id: string;
  selected_snapshots: SnapshotReference[];
  snapshot_bundle_hash: string;
  selection_reason: string;
};
export type SnapshotSelectionReceipt = SnapshotSelectionValue & {
  parent_id: string;
  revision: number;
  metric_status: "requires_freeze";
};
export type SelectableSnapshot = Snapshot & {
  withdrawn?: boolean;
  retention_expired?: boolean;
};
export type SelectionInvestigation = Investigation & {
  snapshot_selection?: SnapshotSelectionValue | null;
};
type SelectionIntent = {
  base: string;
  csrf: string;
  role?: Role;
  canMutate: boolean;
  metadataAvailable: boolean;
  investigation: Investigation;
  snapshots: SelectableSnapshot[];
  snapshotIds: string[];
  reason: string;
  reviewed: boolean;
};
const sha = /^[a-f0-9]{64}$/;
const finiteId = (value: unknown): value is string =>
  typeof value === "string" && !!safeId(value);
function retained(snapshot: SelectableSnapshot): boolean {
  return !snapshot.withdrawn && !snapshot.retention_expired;
}
function validReference(value: unknown): value is SnapshotReference {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SnapshotReference>;
  return (
    finiteId(row.id) &&
    finiteId(row.source_id) &&
    typeof row.content_hash === "string" &&
    sha.test(row.content_hash)
  );
}
export function isSnapshotSelection(
  value: unknown,
  revisionId: string,
): value is SnapshotSelectionValue {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SnapshotSelectionValue>;
  return (
    row.revision_id === revisionId &&
    finiteId(row.revision_id) &&
    typeof row.snapshot_bundle_hash === "string" &&
    sha.test(row.snapshot_bundle_hash) &&
    typeof row.selection_reason === "string" &&
    row.selection_reason.trim().length > 0 &&
    row.selection_reason.length <= 2000 &&
    Array.isArray(row.selected_snapshots) &&
    row.selected_snapshots.length <= 100 &&
    row.selected_snapshots.every(validReference) &&
    new Set(row.selected_snapshots.map((snapshot) => snapshot.id)).size ===
      row.selected_snapshots.length
  );
}

function reviewedSelection(input: SelectionIntent): SnapshotReference[] {
  const item = input.investigation;
  if (
    !["owner", "analyst"].includes(input.role ?? "") ||
    !input.canMutate ||
    !input.metadataAvailable ||
    item.archived ||
    item.lifecycle !== "open" ||
    !finiteId(item.id) ||
    !finiteId(item.workspace_id) ||
    !finiteId(item.active_revision_id) ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1 ||
    !input.csrf ||
    input.base !== casePath(item.workspace_id, item.id)
  ) {
    throw new Error(
      "Refresh the permitted current investigation and retained snapshot metadata before saving a selection.",
    );
  }
  if (!input.reviewed)
    throw new Error(
      "Review the exact snapshot identities and metric freeze requirement before saving.",
    );
  if (!input.reason.trim() || input.reason.length > 2000)
    throw new Error("Explain this selection in one to 2,000 characters.");
  if (
    !Array.isArray(input.snapshotIds) ||
    input.snapshotIds.length > 100 ||
    new Set(input.snapshotIds).size !== input.snapshotIds.length
  )
    throw new Error("Select at most 100 distinct retained snapshots.");
  return [...input.snapshotIds].sort().map((id) => {
    const matches = input.snapshots.filter((snapshot) => snapshot.id === id),
      snapshot = matches[0];
    if (
      matches.length !== 1 ||
      !snapshot ||
      !retained(snapshot) ||
      !validReference(snapshot)
    )
      throw new Error(
        "A selected snapshot is unavailable, withdrawn, expired, or missing its immutable binding. Refresh before reviewing again.",
      );
    return {
      id: snapshot.id,
      source_id: snapshot.source_id,
      content_hash: snapshot.content_hash!,
    };
  });
}

/** The synchronous fence prevents duplicate submissions before React renders pending state. */
export function createSnapshotSelectionCommand() {
  const identity: { current: CommandIdentity } = { current: null };
  let pending = false;
  return {
    get pending() {
      return pending;
    },
    async submit(input: SelectionIntent): Promise<SnapshotSelectionReceipt> {
      if (pending)
        throw new Error("This snapshot selection is already being saved.");
      const selected = reviewedSelection(input),
        path = `${input.base}/snapshot-selections`;
      const body = {
          snapshot_ids: selected.map((snapshot) => snapshot.id),
          reason: input.reason.trim(),
        },
        revision = input.investigation.revision;
      pending = true;
      try {
        const value = await resource<SnapshotSelectionReceipt>(path, {
          method: "POST",
          csrf: input.csrf,
          revision,
          body,
          idempotencyKey: commandKey(identity, {
            path,
            method: "POST",
            revision,
            body,
          }),
        });
        if (
          !isSnapshotSelection(value, value?.revision_id) ||
          value.parent_id !== input.investigation.active_revision_id ||
          value.revision_id === value.parent_id ||
          value.revision !== revision + 1 ||
          value.metric_status !== "requires_freeze" ||
          value.selection_reason !== body.reason ||
          value.selected_snapshots.length !== selected.length ||
          value.selected_snapshots.some(
            (row, index) =>
              row.id !== selected[index].id ||
              row.source_id !== selected[index].source_id ||
              row.content_hash !== selected[index].content_hash,
          )
        ) {
          throw new Error(
            "The server did not return the reviewed snapshot selection and new investigation revision. Refresh its recorded state before proceeding.",
          );
        }
        identity.current = null;
        return value;
      } finally {
        pending = false;
      }
    },
  };
}

function coverage(value: unknown): value is Coverage {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Coverage>,
    time = (v: unknown) =>
      v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v));
  return (
    ["complete", "partial", "unknown"].includes(row.extraction_status ?? "") &&
    typeof row.basis === "string" &&
    typeof row.attestation === "string" &&
    time(row.covered_start) &&
    time(row.covered_end) &&
    time(row.event_watermark) &&
    Array.isArray(row.event_time_intervals) &&
    row.event_time_intervals.length <= 100 &&
    row.event_time_intervals.every(
      (interval) =>
        !!interval &&
        typeof interval.start === "string" &&
        typeof interval.end === "string",
    ) &&
    (row.assumptions === undefined ||
      (Array.isArray(row.assumptions) &&
        row.assumptions.every((item) => typeof item === "string")))
  );
}
export async function readSnapshotQuality(
  base: string,
  snapshot: SelectableSnapshot,
  signal?: AbortSignal,
): Promise<Coverage> {
  if (
    !/^\/api\/v1\/workspaces\/[A-Za-z0-9:_-]+\/cases\/[A-Za-z0-9:_-]+$/.test(
      base,
    ) ||
    !retained(snapshot) ||
    !validReference(snapshot)
  )
    throw new Error(
      "Choose a retained snapshot with its immutable binding before reading coverage.",
    );
  const value = await boundedResource<Coverage>(
    `${base}/snapshots/${encodeURIComponent(snapshot.id)}/quality`,
    signal,
  );
  if (!coverage(value))
    throw new Error(
      "The exact snapshot coverage response was unavailable. Its quality remains unknown.",
    );
  return value;
}

export function SnapshotSelectionSummary({
  value,
  receipt = false,
}: {
  value: SnapshotSelectionValue;
  receipt?: boolean;
}) {
  return (
    <section
      aria-label={
        receipt
          ? "Saved snapshot selection receipt"
          : "Current saved snapshot bundle"
      }
    >
      <h3>{receipt ? "Data selection saved" : "Saved data selection"}</h3>
      <p>
        {value.selected_snapshots.length} snapshot
        {value.selected_snapshots.length === 1 ? "" : "s"} selected ·{" "}
        {value.selection_reason}
      </p>
      <details>
        <summary>Selection details</summary>
        <dl className="binding-list">
          <div>
            <dt>Investigation version</dt>
            <dd>{value.revision_id}</dd>
          </div>
          <div>
            <dt>Selection hash</dt>
            <dd>{value.snapshot_bundle_hash}</dd>
          </div>
        </dl>
        <ul>
          {value.selected_snapshots.map((snapshot) => (
            <li key={snapshot.id}>
              Snapshot {snapshot.id} · Source {snapshot.source_id}
              <div className="snapshot-hash">
                Content hash: {snapshot.content_hash}
              </div>
            </li>
          ))}
        </ul>
      </details>
      {receipt && (
        <p role="status">
          Lock the metric again before running a new comparison. Saving data
          does not create a result.
        </p>
      )}
    </section>
  );
}

export function SnapshotSelection({
  base,
  csrf,
  role,
  investigation,
  snapshots,
  canMutate,
  metadataAvailable,
  onSaved,
}: {
  base: string;
  csrf: string;
  role?: Role;
  investigation: SelectionInvestigation;
  snapshots: SelectableSnapshot[];
  canMutate: boolean;
  metadataAvailable: boolean;
  onSaved: (value: SnapshotSelectionReceipt) => void;
}) {
  const [ids, setIds] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null),
    [receipt, setReceipt] = useState<SnapshotSelectionReceipt | null>(null);
  const [quality, setQuality] = useState<{
      id: string;
      value: Coverage;
    } | null>(null),
    [qualityPending, setQualityPending] = useState(""),
    [qualityError, setQualityError] = useState<Error | null>(null);
  const command = useRef<ReturnType<
      typeof createSnapshotSelectionCommand
    > | null>(null),
    activeScope = useRef(base),
    qualityRead = useRef<AbortController | null>(null);
  if (!command.current) command.current = createSnapshotSelectionCommand();
  activeScope.current = base;
  const binding = JSON.stringify([
    investigation.active_revision_id,
    investigation.revision,
    snapshots.map((snapshot) => [
      snapshot.id,
      snapshot.source_id,
      snapshot.content_hash,
      snapshot.withdrawn,
      snapshot.retention_expired,
    ]),
  ]);
  useEffect(() => {
    setReviewed(false);
  }, [binding]);
  useEffect(() => {
    activeScope.current = base;
    command.current = createSnapshotSelectionCommand();
    setPending(false);
    setQualityPending("");
    setIds([]);
    setReason("");
    setReviewed(false);
    setReceipt(null);
    setError(null);
    setQuality(null);
    setQualityError(null);
    return () => {
      activeScope.current = "";
      qualityRead.current?.abort();
    };
  }, [base]);
  const editable = ["owner", "analyst"].includes(role ?? "") && canMutate,
    saved = investigation.snapshot_selection;
  const savedValid =
    saved !== null &&
    saved !== undefined &&
    isSnapshotSelection(saved, investigation.active_revision_id);
  const knownEmpty = metadataAvailable && snapshots.length === 0 && saved === null;
  const clearingSelection = savedValid && saved.selected_snapshots.length > 0 && ids.length === 0;
  let issue: string | null = null;
  try {
    reviewedSelection({
      base,
      csrf,
      role,
      canMutate,
      metadataAvailable,
      investigation,
      snapshots,
      snapshotIds: ids,
      reason,
      reviewed,
    });
  } catch (cause) {
    issue = formError(cause).message;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (command.current!.pending) return;
    const scope = base;
    setError(null);
    setPending(true);
    try {
      const value = await command.current!.submit({
        base,
        csrf,
        role,
        canMutate,
        metadataAvailable,
        investigation,
        snapshots,
        snapshotIds: ids,
        reason,
        reviewed,
      });
      if (activeScope.current !== scope) return;
      setReceipt(value);
      setReviewed(false);
      onSaved(value);
    } catch (cause) {
      if (activeScope.current === scope) setError(formError(cause));
    } finally {
      if (activeScope.current === scope) setPending(false);
    }
  }
  async function inspect(snapshot: SelectableSnapshot) {
    if (qualityRead.current) return;
    const controller = new AbortController(),
      scope = base;
    qualityRead.current = controller;
    setQuality(null);
    setQualityError(null);
    setQualityPending(snapshot.id);
    try {
      const value = await readSnapshotQuality(
        base,
        snapshot,
        controller.signal,
      );
      if (activeScope.current === scope && !controller.signal.aborted)
        setQuality({ id: snapshot.id, value });
    } catch (cause) {
      if (activeScope.current === scope && !controller.signal.aborted)
        setQualityError(formError(cause));
    } finally {
      if (qualityRead.current === controller) qualityRead.current = null;
      if (activeScope.current === scope) setQualityPending("");
    }
  }
  if (knownEmpty) return <section className="panel" aria-label="Selected snapshots review"><h2>Choose data</h2><p className="muted">Upload a file first.</p></section>;
  return (
    <section className="panel" aria-label="Selected snapshots review">
      <div className="section-heading">
        <div>
          <h2>Choose data</h2>
        </div>
        <Status tone="muted">
          {metadataAvailable && (saved === null || savedValid) ? "Ready" : "Unavailable"}
        </Status>
      </div>
      {savedValid ? (
        <SnapshotSelectionSummary value={saved} />
      ) : saved === null ? (
        <p className="muted">No data selected yet.</p>
      ) : (
        <p className="notice warning">
          Could not load your saved selection. Refresh to try again.
        </p>
      )}
      {receipt && <SnapshotSelectionSummary value={receipt} receipt />}
      <ErrorNotice error={error} />
      <details open={!savedValid || !metadataAvailable || !editable}><summary>{savedValid ? "Change selected data" : "Select data"}</summary>
      {!metadataAvailable ? (
        <p className="notice warning">
          Could not load your saved data. Refresh to try again.
        </p>
      ) : (
        <>
          <div className="snapshot-list">
            {snapshots.map((snapshot) => {
              const available = retained(snapshot) && validReference(snapshot),
                checked = ids.includes(snapshot.id);
              return (
                <div className="snapshot-card" key={snapshot.id}>
                  {editable ? (
                    <label className="review-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          pending ||
                          !available ||
                          (!checked && ids.length >= 100)
                        }
                        onChange={(event) => {
                          setIds((previous) =>
                            event.target.checked
                              ? [...previous, snapshot.id]
                              : previous.filter((id) => id !== snapshot.id),
                          );
                          setReviewed(false);
                        }}
                      />
                      Include{" "}
                      {snapshot.record_kind ??
                        snapshot.record_type ??
                        snapshot.kind ??
                        "saved"}{" "}
                      data
                      {snapshot.record_count === undefined
                        ? ""
                        : ` · ${snapshot.record_count.toLocaleString()} records`}
                    </label>
                  ) : (
                    <strong>
                      {snapshot.record_kind ??
                        snapshot.record_type ??
                        snapshot.kind ??
                        "Saved"}{" "}
                      data
                    </strong>
                  )}
                  <details>
                    <summary>Snapshot details</summary>
                    <p>
                      Snapshot {snapshot.id} · Source {snapshot.source_id}
                    </p>
                    <div className="snapshot-hash">
                      Content hash: {snapshot.content_hash ?? "Unavailable"}
                    </div>
                  </details>
                  {!available && (
                    <p className="notice warning">
                      Withdrawn, expired, or missing binding; unavailable for
                      new selection.
                    </p>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={!available || !!qualityPending}
                    onClick={() => {
                      void inspect(snapshot);
                    }}
                  >
                    Check coverage
                  </button>
                </div>
              );
            })}
          </div>
          {!snapshots.length && (
            <p className="muted">
              No saved data is available to add.
            </p>
          )}
          <ErrorNotice error={qualityError} />
          {qualityPending && (
            <Loading label="Checking data coverage…" />
          )}
          {quality && (
            <section aria-label="Exact snapshot coverage">
              <h3>Recorded coverage</h3>
              <CoverageSummary coverage={quality.value} />
              <details>
                <summary>Inspect exact coverage declaration</summary>
                <p>Snapshot {quality.id}</p>
                <pre>{JSON.stringify(quality.value, null, 2)}</pre>
              </details>

            </section>
          )}
        </>
      )}
      {editable ? (
        <form onSubmit={save}>
          <Field
            label="Reason for this selection"
          >
            <textarea
              value={reason}
              required
              maxLength={2000}
              disabled={pending}
              onChange={(event) => {
                setReason(event.target.value);
                setReviewed(false);
              }}
            />
          </Field>
          <label className="review-checkbox">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={pending || !metadataAvailable}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I reviewed this data. Saving changes the investigation version; I must
            lock the metric again.
          </label>
          <p className="fine-print">
            {ids.length} of at most 100 snapshots selected.
          </p>
          {issue && <p className="fine-print">{issue}</p>}
          {clearingSelection && (
            <p className="notice warning">
              This removes the selected data. Lock the metric again before testing.
            </p>
          )}
          <button
            className="primary"
            type="submit"
            disabled={pending || !!issue}
          >
            {pending ? "Saving…" : "Save selected data"}
          </button>
        </form>
      ) : (
        <p className="notice">
          Only owners and analysts can change the selected data. You can view
          available data and its coverage.
        </p>
      )}
      </details>
    </section>
  );
}
