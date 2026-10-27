import { useEffect, useState, type FormEvent } from "react";
import { resource, workspacePath, type Workspace } from "../../api";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  formError,
} from "../../ui";
import { useCommand } from "../investigation/Shared";

const policyFields = [
  ["max_automatic_model_calls", "Agent requests", "requests", 0, 24],
  ["max_input_tokens", "Input allowance", "units", 0, 500000],
  ["max_output_tokens", "Output allowance", "tokens", 0, 64000],
  ["max_records_per_snapshot", "Records per snapshot", "records", 1, 100000],
  ["raw_upload_retention_days", "Original uploads", "days", 1, 3650],
  ["canonical_event_retention_days", "Processed events", "days", 1, 3650],
  ["attachment_retention_days", "Attachments", "days", 1, 3650],
  ["report_retention_days", "Reports", "days", 1, 3650],
  ["audit_retention_days", "Activity log", "days", 1, 3650],
] as const;
interface PolicyRecord {
  value: Record<string, number | string>;
  revision: number;
  installation_ceilings?: Record<string, number>;
  retention?: string;
}
type PolicyPatch = Record<string, number>;
interface Reference {
  resource_kind: string;
  resource_id: string;
  content_hash: string;
  revision_id: string | null;
}
interface ImpactResource extends Reference {
  case_id: string | null;
  captured_at: string;
  age_days: number;
  resource_revision: number | null;
  object_keys: string[];
  previous_expires_at: string;
  expires_at: string;
  shortened: boolean;
  caused_by: Reference[];
  cited_reports: Reference[];
  report_downloads: Reference[];
  shared_reference_count: number;
  binding: Record<string, unknown>;
}
interface RetentionImpact {
  resources: ImpactResource[];
  counts: Record<string, number>;
  affected_citations: number;
  physical_cleanup: "pending_separate_review";
}
export interface RetentionPreview {
  policy_revision: number;
  previous_policy_hash: string;
  policy_hash: string;
  patch: PolicyPatch;
  as_of: string;
  effective_at: string;
  grace_days: number;
  impact: RetentionImpact;
  impact_hash: string;
  review_token: string;
  review_expires_at: string;
  backup_notice: string;
}
interface RetentionReceipt {
  id: string;
  status: string;
  revision: number;
  policy_revision: number;
  effective_at: string;
  impact_hash: string;
  result: Record<string, unknown> | null;
  error_code: string | null;
  impact: RetentionImpact;
  patch: PolicyPatch;
  backup_notice: string;
  expirations?: {
    id: string;
    resource_kind: string;
    resource_id: string;
    status: string;
    content_hash: string;
    captured_at: string;
    expires_at: string;
    expired_at?: string | null;
    result?: unknown;
  }[];
}
export interface Budgets {
  work_units: {
    case_id: string;
    revision_id: string;
    ceiling: number | string;
    reserved: number | string;
    spent: number | string;
  }[];
  model_calls: string;
  model_usage?: {
    case_id: string;
    revision_id: string;
    calls_reserved: number | string;
    calls_spent: number | string;
    input_reserved: number | string;
    input_spent: number | string;
    output_reserved: number | string;
    output_spent: number | string;
  }[];
  installation_expensive_jobs: number;
  workspace_expensive_jobs: number;
}
const sorted = (value: Record<string, number>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
const validTime = (value: string) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function readPolicyPatch(
  form: FormData,
  record: PolicyRecord,
): PolicyPatch {
  const patch: PolicyPatch = {};
  for (const [name, label, , minimum, maximum] of policyFields) {
    const raw = form.get(name);
    if (
      typeof raw !== "string" ||
      !raw.trim() ||
      typeof record.value[name] !== "number"
    )
      throw new Error(
        `${label} is unavailable. Refresh the recorded policy before changing it.`,
      );
    const value = Number(raw),
      declared = record.installation_ceilings?.[name],
      ceiling = name.endsWith("_days") ? maximum : declared;
    if (ceiling === undefined || !Number.isSafeInteger(ceiling))
      throw new Error(
        `${label} has no recorded installation ceiling. Refresh before changing it.`,
      );
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > Math.min(maximum, ceiling)
    )
      throw new Error(
        `${label} must be an integer from ${minimum} to ${Math.min(maximum, ceiling)}.`,
      );
    if (value !== record.value[name]) patch[name] = value;
  }
  if (!Object.keys(patch).length)
    throw new Error(
      "Choose an actual policy change before requesting a preview.",
    );
  return patch;
}

export function validateRetentionPreview(
  preview: RetentionPreview,
  patch: PolicyPatch,
  revision: number,
  now = Date.now(),
): void {
  const expectedRetention = Object.fromEntries(
    Object.entries(patch).filter(([name]) => name.endsWith("_retention_days")),
  );
  if (
    !preview ||
    preview.policy_revision !== revision ||
    !preview.review_token ||
    !/^[a-f0-9]{64}$/.test(preview.impact_hash ?? "") ||
    !/^[a-f0-9]{64}$/.test(preview.previous_policy_hash ?? "") ||
    !/^[a-f0-9]{64}$/.test(preview.policy_hash ?? "") ||
    !preview.patch ||
    sorted(preview.patch) !== sorted(expectedRetention)
  )
    throw new Error(
      "The retention preview does not match this policy revision and exact changed fields. Review a fresh preview.",
    );
  if (
    !validTime(preview.as_of) ||
    !validTime(preview.effective_at) ||
    !validTime(preview.review_expires_at) ||
    Date.parse(preview.review_expires_at) <= now
  )
    throw new Error(
      "The retention review expired or its server times are unavailable. Request a fresh preview.",
    );
  if (
    !Number.isSafeInteger(preview.grace_days) ||
    preview.grace_days < 7 ||
    Date.parse(preview.effective_at) - Date.parse(preview.as_of) <
      preview.grace_days * 86_400_000
  )
    throw new Error(
      "The required review grace is unavailable. No retention change can be approved.",
    );
  const impact = preview.impact;
  if (
    !impact ||
    impact.physical_cleanup !== "pending_separate_review" ||
    !Array.isArray(impact.resources) ||
    impact.resources.length > 10000 ||
    impact.counts?.total !== impact.resources.length ||
    !Number.isSafeInteger(impact.affected_citations) ||
    impact.affected_citations < 0 ||
    impact.resources.some(
      (row) =>
        !row.resource_id ||
        !row.content_hash ||
        !validTime(row.captured_at) ||
        !validTime(row.previous_expires_at) ||
        !validTime(row.expires_at) ||
        !Number.isFinite(row.age_days) ||
        row.age_days < 0 ||
        !Number.isSafeInteger(row.shared_reference_count) ||
        row.shared_reference_count < 0 ||
        !Array.isArray(row.caused_by) ||
        !Array.isArray(row.cited_reports) ||
        !Array.isArray(row.report_downloads),
    )
  )
    throw new Error(
      "The affected resource inventory is incomplete or unavailable. No retention change can be approved.",
    );
}

export function reviewedPolicyBody(
  patch: PolicyPatch,
  preview: RetentionPreview,
  revision: number,
  acknowledged: boolean,
  now = Date.now(),
) {
  if (!acknowledged)
    throw new Error(
      "Review the exact affected resources, cited reports, shared references and grace before approving.",
    );
  validateRetentionPreview(preview, patch, revision, now);
  return { ...patch, retention_review_token: preview.review_token };
}

export function Policies({
  workspace,
  csrf,
  section,
}: {
  workspace: Workspace;
  csrf: string;
  section: "policy" | "privacy" | "budgets";
}) {
  const send = useCommand(csrf),
    [record, setRecord] = useState<PolicyRecord | null>(null),
    [budgets, setBudgets] = useState<Budgets | null>(null),
    [editing, setEditing] = useState<PolicyRecord | null>(null),
    [review, setReview] = useState<{
      patch: PolicyPatch;
      preview: RetentionPreview;
    } | null>(null),
    [acknowledged, setAcknowledged] = useState(false),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [reload, setReload] = useState(0);
  const [receiptId, setReceiptId] = useState(() => {
    const id = new URL(location.href).searchParams.get("retention");
    return id && /^[a-f0-9-]{36}$/i.test(id) ? id : "";
  });
  const [receipt, setReceipt] = useState<RetentionReceipt | null>(null),
    [receiptLoading, setReceiptLoading] = useState(false),
    [receiptError, setReceiptError] = useState<Error | null>(null),
    [receiptReload, setReceiptReload] = useState(0);
  const allowed =
      section === "budgets"
        ? workspace.role !== "viewer"
        : workspace.role === "owner",
    base = workspacePath(workspace.id),
    path = `${base}/${section === "privacy" ? "privacy-policy" : section}`;
  useEffect(() => {
    setRecord(null);
    setBudgets(null);
    setEditing(null);
    setReview(null);
    setAcknowledged(false);
    setError(null);
    if (!allowed) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    resource<PolicyRecord | Budgets>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          if (section === "budgets") {
            if (!Array.isArray((value as Budgets)?.work_units))
              throw new Error("Work-unit budget metadata was unavailable.");
            setBudgets(value as Budgets);
          } else {
            if (
              !(value as PolicyRecord)?.value ||
              typeof (value as PolicyRecord).revision !== "number"
            )
              throw new Error(
                "The policy resource and revision were unavailable.",
              );
            setRecord(value as PolicyRecord);
          }
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, allowed, section, reload]);
  useEffect(() => {
    setReceipt(null);
    setReceiptError(null);
    if (!allowed || section !== "policy" || !receiptId) {
      setReceiptLoading(false);
      return;
    }
    const controller = new AbortController();
    setReceiptLoading(true);
    resource<RetentionReceipt>(
      `${base}/policy/retention/${encodeURIComponent(receiptId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          if (
            !value?.id ||
            !value.impact ||
            !Array.isArray(value.impact.resources)
          )
            throw new Error("The actual retention receipt is unavailable.");
          setReceipt(value);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setReceiptError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setReceiptLoading(false);
      });
    return () => controller.abort();
  }, [base, allowed, section, receiptId, receiptReload]);
  function closeEdit() {
    if (!pending) {
      setEditing(null);
      setReview(null);
      setAcknowledged(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (section === "privacy") {
        if (form.get("policy_review") !== "on")
          throw new Error("Review the exact privacy policy before saving.");
        await send(
          path,
          {
            policy_version: String(form.get("policy_version")).trim(),
            viewer_evidence_mode: "minimized",
          },
          "PATCH",
          editing.revision,
        );
        setEditing(null);
        setReload((value) => value + 1);
      } else if (!review) {
        const patch = readPolicyPatch(form, editing),
          preview = await send<RetentionPreview>(
            `${base}/policy/retention-preview`,
            { patch },
          );
        validateRetentionPreview(preview, patch, editing.revision);
        setReview({ patch, preview });
        setAcknowledged(false);
      } else {
        const body = reviewedPolicyBody(
          review.patch,
          review.preview,
          editing.revision,
          acknowledged,
        );
        const saved = await send<{
          value: PolicyRecord["value"];
          revision: number;
          retention?: { id: string };
        }>(path, body, "PATCH", editing.revision);
        if (saved.retention?.id) {
          setReceiptId(saved.retention.id);
          const url = new URL(location.href);
          url.searchParams.set("retention", saved.retention.id);
          history.replaceState(null, "", url.pathname + url.search);
          setReceiptReload((value) => value + 1);
        }
        setEditing(null);
        setReview(null);
        setAcknowledged(false);
        setReload((value) => value + 1);
      }
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  async function resume() {
    if (!receipt || pending || !Number.isSafeInteger(receipt.revision)) return;
    setPending(true);
    setReceiptError(null);
    try {
      await send(
        `${base}/policy/retention/${encodeURIComponent(receipt.id)}/resume`,
        {},
        "POST",
        receipt.revision,
      );
      setReceiptReload((value) => value + 1);
    } catch (cause) {
      setReceiptError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  const title =
    section === "budgets"
      ? "Budgets & work units"
      : section === "privacy"
        ? "Privacy policy"
        : "Resource & retention policy";
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            {title}
            <span className="heading-dot">.</span>
          </h1>
          <p>
            {section === "budgets"
              ? "View current usage and limits."
              : "View or change workspace limits."}
          </p>
        </div>
        {allowed && (
          <button
            className="secondary"
            disabled={loading || pending}
            onClick={() => {
              setReload((value) => value + 1);
              setReceiptReload((value) => value + 1);
            }}
          >
            Refresh
          </button>
        )}
      </div>
      {!allowed ? (
        <section className="notice">
          <strong>
            {section === "budgets"
              ? "Owner or analyst access required"
              : "Owner access required"}
          </strong>
          <p>
            This setting is unavailable to your current {workspace.role} role.
          </p>
        </section>
      ) : (
        <>
          <ErrorNotice error={editing ? null : error} />
          {loading ? (
            <Loading label="Loading settings…" />
          ) : budgets ? (
            <BudgetView budgets={budgets} />
          ) : record ? (
            <section className="panel">
              <div className="section-heading">
                <h2>Current settings</h2>
                <Status tone="muted">Revision {record.revision}</Status>
              </div>
              {section === "privacy" ? (
                <>
                  <dl className="policy-values">
                    <div>
                      <dt>Policy version</dt>
                      <dd>{record.value.policy_version}</dd>
                    </div>
                    <div>
                      <dt>Viewer evidence mode</dt>
                      <dd>{record.value.viewer_evidence_mode}</dd>
                    </div>
                  </dl>
                  <p className="notice">
                    Viewer access stays limited. Policy changes do not reveal
                    restricted source data.
                  </p>
                </>
              ) : (
                <>
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label="Recorded resource and retention policy"
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Policy</th>
                          <th>Current value</th>
                          <th>Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policyFields.map(([name, label, unit]) => (
                          <tr key={name}>
                            <td>{label}</td>
                            <td>{record.value[name] ?? "Unknown"}</td>
                            <td>{unit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="notice warning">
                    Retention changes require an exact affected-resource preview
                    and at least seven days of review grace. Logical expiry
                    revokes access and dependent claims. Physical cleanup
                    requires a separate review.
                  </p>
                </>
              )}
              {record.retention && <p className="notice">{record.retention}</p>}
              {record.installation_ceilings && (
                <details>
                  <summary>System maximums</summary>
                  <pre>
                    {JSON.stringify(record.installation_ceilings, null, 2)}
                  </pre>
                </details>
              )}
              <button
                className="primary"
                onClick={() => {
                  setError(null);
                  setEditing(record);
                  setReview(null);
                  setAcknowledged(false);
                }}
              >
                Change settings
              </button>
            </section>
          ) : (
            <section className="panel">
              <h2>Settings unavailable</h2>
              <p>Try refreshing the page.</p>
            </section>
          )}
          {section === "policy" && receiptId && (
            <section className="panel">
              <div className="section-heading">
                <h2>Retention change</h2>
                <button
                  className="secondary"
                  disabled={receiptLoading || pending}
                  onClick={() => setReceiptReload((value) => value + 1)}
                >
                  Refresh
                </button>
              </div>
              <ErrorNotice error={receiptError} />
              {receiptLoading ? (
                <Loading label="Loading retention status…" />
              ) : receipt ? (
                <>
                  <Status tone="warning">
                    {receipt.status.replaceAll("_", " ")}
                  </Status>
                  <p className="hash-line">
                    Change {receipt.id} · Receipt revision{" "}
                    {receipt.revision ?? "Unknown"} · Policy revision{" "}
                    {receipt.policy_revision}
                    <br />
                    Effective no earlier than {receipt.effective_at}
                    <br />
                    Impact hash {receipt.impact_hash}
                  </p>
                  <p className="notice warning">
                    Physical cleanup remains pending separate review. This
                    policy change and its logical retry do not authorize
                    removing private bytes.{" "}
                    {receipt.result && Object.hasOwn(receipt.result, "removed")
                      ? `Actual reported removal: ${String(receipt.result.removed)}.`
                      : "No physical removal count has been reported."}
                  </p>
                  {receipt.error_code && (
                    <p className="notice error">
                      Recorded error: {receipt.error_code}
                    </p>
                  )}
                  <RetentionImpactView impact={receipt.impact} />
                  <p>{receipt.backup_notice}</p>
                  <details>
                    <summary>
                      Inspect recorded result and expiration states
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          result: receipt.result,
                          expirations: receipt.expirations ?? null,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  {["scheduled", "expiring", "pending_cleanup"].includes(
                    receipt.status,
                  ) && (
                    <>
                      <p className="fine-print">
                        The original reviewer must still be an owner. Resume
                        checks logical retention only; a current fenced check
                        can reject it as busy.
                      </p>
                      <button
                        className="secondary"
                        disabled={
                          pending || !Number.isSafeInteger(receipt.revision)
                        }
                        onClick={resume}
                      >
                        {pending
                          ? "Requesting logical retry…"
                          : "Retry retention check"}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <p>
                  The receipt is unavailable. No expiry, cleanup or successful
                  retry is inferred.
                </p>
              )}
            </section>
          )}
        </>
      )}
      {editing && (
        <Modal
          title={`Review ${title.toLowerCase()} change`}
          onClose={closeEdit}
        >
          <form onSubmit={save}>
            <ErrorNotice error={error} />
            <p className="fine-print">
              Reviewing resource revision {editing.revision}. Concurrent policy
              or evidence changes require a new review.
            </p>
            {section === "privacy" ? (
              <>
                <Field label="Privacy policy version">
                  <input
                    name="policy_version"
                    required
                    maxLength={128}
                    defaultValue={String(editing.value.policy_version)}
                  />
                </Field>
                <Field label="Viewer evidence mode">
                  <input readOnly value="minimized" />
                </Field>
                <label className="review-checkbox">
                  <input
                    name="policy_review"
                    type="checkbox"
                    required
                    disabled={pending}
                  />
                  I reviewed these exact policy values, limits, privacy
                  obligations, and retention dependencies.
                </label>
              </>
            ) : review ? (
              <>
                <h3>Review affected data</h3>
                <dl className="policy-values">
                  {Object.entries(review.patch).map(([name, value]) => (
                    <div key={name}>
                      <dt>
                        {policyFields.find(([key]) => key === name)?.[1] ??
                          name}
                      </dt>
                      <dd>
                        {editing.value[name]} → {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Inventory captured at {review.preview.as_of}. Effective no
                  earlier than {review.preview.effective_at}. Approval preserves
                  the full {review.preview.grace_days}-day grace and may extend
                  this date.
                </p>
                <p className="hash-line">
                  Previous policy {review.preview.previous_policy_hash}
                  <br />
                  Proposed policy {review.preview.policy_hash}
                  <br />
                  Reviewed impact {review.preview.impact_hash}
                  <br />
                  Review expires {review.preview.review_expires_at}
                </p>
                <RetentionImpactView impact={review.preview.impact} />
                <p className="notice warning">{review.preview.backup_notice}</p>
                <label className="review-checkbox">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={pending}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I reviewed these exact affected IDs and hashes, capture ages,
                  cited reports, download dependencies and shared references,
                  and the full {review.preview.grace_days}-day grace. Physical
                  cleanup remains pending a separate review.
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={() => {
                    setReview(null);
                    setAcknowledged(false);
                  }}
                >
                  Change values
                </button>
              </>
            ) : (
              <div className="mapping-field-grid">
                {policyFields.map(([name, label, unit, minimum, maximum]) => (
                  <Field label={`${label} (${unit})`} key={name}>
                    <input
                      name={name}
                      type="number"
                      required
                      step={1}
                      min={minimum}
                      max={
                        name.endsWith("_days")
                          ? maximum
                          : Math.min(
                              maximum,
                              editing.installation_ceilings?.[name] ?? maximum,
                            )
                      }
                      defaultValue={Number(editing.value[name])}
                      disabled={pending}
                    />
                  </Field>
                ))}
              </div>
            )}
            <button
              className="primary"
              disabled={
                pending || (section !== "privacy" && !!review && !acknowledged)
              }
            >
              {pending
                ? review || section === "privacy"
                  ? "Recording reviewed policy…"
                  : "Reading actual impact…"
                : section === "privacy"
                  ? "Save policy"
                  : review
                    ? "Approve retention change"
                    : "Review affected data"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

export function BudgetView({ budgets }: { budgets: Budgets }) {
  return (
    <section className="panel">
      <h2>Run usage</h2>
      <p>{budgets.model_calls}</p>
      <div className="comparison-facts">
        <div>
          <span>System run slots</span>
          <strong>{budgets.installation_expensive_jobs}</strong>
        </div>
        <div>
          <span>Workspace run slots</span>
          <strong>{budgets.workspace_expensive_jobs}</strong>
        </div>
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="Case revision work-unit budgets"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Case / input revision</th>
              <th>Ceiling · work units</th>
              <th>Reserved · work units</th>
              <th>Spent · work units</th>
            </tr>
          </thead>
          <tbody>
            {budgets.work_units.map((row) => (
              <tr key={`${row.case_id}:${row.revision_id}`}>
                <td>
                  <strong>{row.case_id}</strong>
                  <small>{row.revision_id}</small>
                </td>
                <td>{row.ceiling}</td>
                <td>{row.reserved}</td>
                <td>{row.spent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!budgets.work_units.length && (
        <p className="muted">
          No case revision work-unit budgets have been allocated.
        </p>
      )}
      <p className="fine-print">
        A work unit is job accounting. It is separate from provider calls, token
        usage, financial charges and test outcomes.
      </p>
      <h3>Agent usage</h3>
      {!Array.isArray(budgets.model_usage) ? (
        <p className="notice warning">
          Model usage was not returned. Calls and token consumption remain
          unknown.
        </p>
      ) : !budgets.model_usage.length ? (
        <p className="muted">
          No model usage rows have been recorded. No provider execution or
          passing model capability is inferred.
        </p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Actual case revision model usage"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Case / input revision</th>
                <th>Calls reserved</th>
                <th>Calls spent</th>
                <th>Input tokens reserved</th>
                <th>Input tokens spent</th>
                <th>Output tokens reserved</th>
                <th>Output tokens spent</th>
              </tr>
            </thead>
            <tbody>
              {budgets.model_usage.map((row) => (
                <tr key={`${row.case_id}:${row.revision_id}`}>
                  <td>
                    <strong>{row.case_id}</strong>
                    <small>{row.revision_id}</small>
                  </td>
                  <td>{row.calls_reserved ?? "Unknown"}</td>
                  <td>{row.calls_spent ?? "Unknown"}</td>
                  <td>{row.input_reserved ?? "Unknown"}</td>
                  <td>{row.input_spent ?? "Unknown"}</td>
                  <td>{row.output_reserved ?? "Unknown"}</td>
                  <td>{row.output_spent ?? "Unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RetentionImpactView({ impact }: { impact: RetentionImpact }) {
  const [page, setPage] = useState(0),
    pageSize = 25,
    rows = impact.resources.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => setPage(0), [impact]);
  return (
    <>
      <div className="comparison-facts">
        {Object.entries(impact.counts).map(([name, value]) => (
          <div key={name}>
            <span>{name.replaceAll("_", " ")}</span>
            <strong>{value}</strong>
          </div>
        ))}
        <div>
          <span>Affected report links</span>
          <strong>{impact.affected_citations}</strong>
        </div>
      </div>
      <p className="notice warning">
        Cleanup authority: pending separate review. Shared references and cited
        reports require the recorded dependency checks; an HTTP success does not
        prove deletion.
      </p>
      {impact.resources.length ? (
        <>
          <p>
            Showing {page * pageSize + 1}–
            {Math.min((page + 1) * pageSize, impact.resources.length)} of{" "}
            {impact.resources.length} exact affected resources.
          </p>
          {rows.map((row) => (
            <details
              className="snapshot-card"
              key={`${row.resource_kind}:${row.resource_id}`}
            >
              <summary>
                <span>
                  <strong>
                    {row.resource_kind.replaceAll("_", " ")} · {row.resource_id}
                  </strong>
                  <small>
                    {row.shortened
                      ? "Retention shortened"
                      : "Recorded retention dependency"}{" "}
                    · {row.shared_reference_count} shared references
                  </small>
                </span>
              </summary>
              <dl className="policy-values">
                <div>
                  <dt>Case / input revision</dt>
                  <dd>
                    {row.case_id ?? "Workspace resource"} /{" "}
                    {row.revision_id ?? "Not applicable"}
                  </dd>
                </div>
                <div>
                  <dt>Server capture time / age</dt>
                  <dd>
                    {row.captured_at} /{" "}
                    {Number.isFinite(row.age_days)
                      ? row.age_days.toFixed(6) + " days"
                      : "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt>Previous expiration</dt>
                  <dd>{row.previous_expires_at}</dd>
                </div>
                <div>
                  <dt>Reviewed expiration</dt>
                  <dd>{row.expires_at}</dd>
                </div>
                <div>
                  <dt>Resource revision</dt>
                  <dd>{row.resource_revision ?? "Not applicable"}</dd>
                </div>
              </dl>
              <p className="hash-line">Content hash {row.content_hash}</p>
              <h4>Cited reports</h4>
              <ReferenceList rows={row.cited_reports} />
              <h4>Dependent report downloads</h4>
              <ReferenceList rows={row.report_downloads} />
              <h4>Resources causing this dependency</h4>
              <ReferenceList rows={row.caused_by} />
              <details>
                <summary>Inspect exact objects and input binding</summary>
                <pre>
                  {JSON.stringify(
                    { object_keys: row.object_keys, binding: row.binding },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </details>
          ))}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="secondary"
              disabled={(page + 1) * pageSize >= impact.resources.length}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <p>
          No existing resources are affected by this returned preview. The
          changed policy still governs subsequent captured resources under the
          service’s retention rules.
        </p>
      )}
    </>
  );
}
function ReferenceList({ rows }: { rows: Reference[] }) {
  return rows.length ? (
    <ul>
      {rows.map((row) => (
        <li key={`${row.resource_kind}:${row.resource_id}`}>
          <strong>
            {row.resource_kind} · {row.resource_id}
          </strong>
          <span className="hash-line">
            Hash {row.content_hash} · Input revision{" "}
            {row.revision_id ?? "Not applicable"}
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="muted">None recorded.</p>
  );
}
