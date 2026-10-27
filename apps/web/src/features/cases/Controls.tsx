import { useEffect, useRef, useState, type FormEvent } from "react";
import { casePath, resource, type Investigation } from "../../api";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  formError,
} from "../../ui";
import { useCommand } from "../investigation/Shared";
import { boundedResource } from "../../read-state";
import type {
  OperationAssessment,
  AssessmentOperation,
  AssessmentBinding,
  SelectedInputFact,
  CapabilityAssessment,
} from "../../../../../packages/core/src/preflight/assessment";

export interface PreflightLimits {
  source: {
    file_bytes: number;
    expanded_bytes: number;
    records: number;
    files: number;
    json_depth: number;
    csv_field_bytes: number;
  };
  metric: { cohorts: number; period_days: number; horizon_seconds: number };
  storage: {
    ceiling_bytes: number;
    used_bytes: number | null;
    reserved_bytes: number | null;
    remaining_bytes: number | null;
  };
  model: {
    automatic_calls: number;
    input_tokens: number;
    output_tokens: number;
    call_timeout_seconds: number;
  };
  jobs: {
    source_capture_deadline_seconds: number;
    workspace_concurrency: number;
    installation_concurrency: number;
    cancel_poll_seconds: number;
  };
  browser: {
    enabled: boolean;
    task_timeout_seconds: number;
    matrix_cells: number;
    repeats_per_cell: number;
    actions_per_cell: number;
    artifact_bytes: number;
  };
}
export interface PreflightUsage {
  work_units: {
    ceiling: number;
    spent: number;
    reserved: number;
    remaining: number;
  } | null;
  model: {
    calls_spent: number;
    calls_reserved: number;
    input_spent: number;
    input_reserved: number;
    output_spent: number;
    output_reserved: number;
  } | null;
}
export interface Preflight {
  case_id: string;
  revision_id: string;
  manual: boolean;
  metric: string;
  snapshot: string;
  active_work: boolean;
  model: string;
  runner: string;
  quality: string;
  limits?: PreflightLimits;
  usage?: PreflightUsage;
  selected_input?: { snapshot_id: string | null; records: number | null };
  assessment?: OperationAssessment;
}
function knownNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function countLabel(value: number | null | undefined, unit = "") {
  return knownNumber(value)
    ? `${value.toLocaleString("en-US")}${unit ? " " + unit : ""}`
    : "Unknown";
}
function byteLabel(value: number | null | undefined) {
  if (!knownNumber(value)) return "Unknown";
  const scale =
    value >= 1073741824
      ? ([1073741824, "GiB"] as const)
      : value >= 1048576
        ? ([1048576, "MiB"] as const)
        : value >= 1024
          ? ([1024, "KiB"] as const)
          : null;
  return `${value.toLocaleString("en-US")} bytes${scale ? ` (${(value / scale[0]).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${scale[1]})` : ""}`;
}
function LimitRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="binding-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface OperationSelection {
  operation: AssessmentOperation;
  objective: "" | "mechanism" | "correction";
  hypothesis_id: string;
  analytic_plan_id: string;
  candidate_id: string;
  mechanism_result_id: string;
  plan_id: string;
  grant_id: string;
  approval_id: string;
}
const emptySelection: OperationSelection = {
  operation: "analytic",
  objective: "",
  hypothesis_id: "",
  analytic_plan_id: "",
  candidate_id: "",
  mechanism_result_id: "",
  plan_id: "",
  grant_id: "",
  approval_id: "",
};
const operationNames: Record<AssessmentOperation, string> = {
  analytic: "Data analysis",
  browser_plan: "Prepare browser test",
  browser_run: "Run browser test",
};
const uuidPattern =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
  uuid = new RegExp("^" + uuidPattern + "$");

/** Only finite selections for this exact scoped read can reach the API. */
export function operationPreflightPath(
  base: string,
  selection: OperationSelection,
): string {
  if (
    !new RegExp(
      "^/api/v1/workspaces/" + uuidPattern + "/cases/" + uuidPattern + "$",
    ).test(base) ||
    !["analytic", "browser_plan", "browser_run"].includes(selection.operation)
  )
    throw new Error(
      "Select a finite operation for this workspace and investigation.",
    );
  const query = new URLSearchParams({ operation: selection.operation });
  let fields: (keyof OperationSelection)[] = [
    "hypothesis_id",
    "analytic_plan_id",
  ];
  if (selection.operation !== "analytic") {
    if (!["", "mechanism", "correction"].includes(selection.objective))
      throw new Error("Select the finite mechanism or correction objective.");
    if (selection.objective) query.set("objective", selection.objective);
    fields = [
      "hypothesis_id",
      ...(selection.objective === "correction"
        ? (["candidate_id", "mechanism_result_id"] as const)
        : []),
      ...(selection.operation === "browser_run"
        ? (["plan_id", "grant_id", "approval_id"] as const)
        : []),
    ];
  }
  for (const field of fields) {
    const raw = selection[field];
    if (typeof raw !== "string")
      throw new Error("Selected resource IDs must be UUIDs or empty.");
    const id = raw.trim();
    if (!id) continue;
    if (!uuid.test(id))
      throw new Error(
        "Selected resource IDs must be UUIDs, not URLs or expressions.",
      );
    query.set(field, id);
  }
  return `${base}/preflight?${query}`;
}

export async function readOperationAssessment(
  base: string,
  caseId: string,
  selection: OperationSelection,
  signal: AbortSignal,
  revisionId?: string,
): Promise<OperationAssessment> {
  const value = await boundedResource<Preflight>(
      operationPreflightPath(base, selection),
      signal,
    ),
    assessment = value?.assessment;
  if (
    value?.case_id !== caseId ||
    !assessment ||
    assessment.operation !== selection.operation ||
    !["ready", "blocked", "unknown"].includes(assessment.status) ||
    assessment.assessment_scope !== "prerequisites_only" ||
    assessment.admission_reserved !== false ||
    assessment.required_work_units !==
      (selection.operation === "browser_plan" ? 0 : 1) ||
    assessment.optional_model_calls !== 0 ||
    assessment.requested_storage_bytes !== null ||
    assessment.requested_duration_seconds !== null ||
    !Array.isArray(assessment.prerequisites) ||
    assessment.prerequisites.length > 32 ||
    !assessment.selected_input?.metric ||
    !assessment.selected_input.snapshot ||
    !assessment.admission ||
    !assessment.capabilities?.runner ||
    ![null, 12, 18].includes(assessment.expected_observations)
  )
    throw new Error(
      "The scoped operation assessment is unavailable or incomplete. No readiness or execution outcome is inferred.",
    );
  if (
    revisionId &&
    assessment.revision_id !== null &&
    assessment.revision_id !== revisionId
  )
    throw new Error(
      "The assessed input revision changed. Refresh this investigation before reviewing current prerequisites.",
    );
  if (
    assessment.prerequisites.some(
      (fact) =>
        !fact ||
        typeof fact.code !== "string" ||
        typeof fact.detail !== "string" ||
        !["ready", "missing", "stale", "blocked", "unknown"].includes(
          fact.status,
        ),
    )
  )
    throw new Error(
      "Prerequisite facts are unavailable. No readiness or execution outcome is inferred.",
    );
  return assessment;
}

function BindingMetadata({ binding }: { binding?: AssessmentBinding }) {
  return binding ? (
    <details>
      <summary>Inspect recorded binding</summary>
      <LimitRows
        rows={Object.entries(binding).map(([label, value]) => [
          label.replaceAll("_", " "),
          value === null
            ? "Unknown"
            : typeof value === "boolean"
              ? value
                ? "Yes"
                : "No"
              : String(value),
        ])}
      />
    </details>
  ) : null;
}
function SelectedOperationInput({
  label,
  input,
  records,
}: {
  label: string;
  input: SelectedInputFact;
  records?: number | null;
}) {
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <LimitRows
        rows={[
          ["Resource ID", input.id ?? "Unknown"],
          ["Content hash", input.hash ?? "Unknown"],
          ["Input revision", input.revision_id ?? "Unknown"],
          [
            "Frozen",
            input.frozen === true
              ? "Yes"
              : input.frozen === false
                ? "No"
                : "Unknown",
          ],
          ["Freshness", input.freshness ?? "unknown"],
          ...(records !== undefined
            ? [["Recorded rows", countLabel(records)] as [string, string]]
            : []),
        ]}
      />
    </section>
  );
}
function RecordedCapability({
  label,
  value,
}: {
  label: string;
  value?: CapabilityAssessment;
}) {
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <LimitRows
        rows={[
          [
            "Configured",
            value?.configured === true
              ? "Yes"
              : value?.configured === false
                ? "No"
                : "Unknown",
          ],
          ["Recorded availability", value?.status ?? "unknown"],
          [
            "Current configuration binding",
            value?.current_recorded_binding === true
              ? "Yes"
              : value?.current_recorded_binding === false
                ? "No"
                : "Unknown",
          ],
          ["Capability readiness", value?.readiness ?? "unknown"],
        ]}
      />
      <BindingMetadata binding={value?.binding} />
    </section>
  );
}

export function OperationAssessmentResult({
  assessment,
}: {
  assessment: OperationAssessment;
}) {
  return (
    <section
      className="operation-assessment"
      aria-label="Selected operation assessment"
    >
      <div className="section-heading">
        <h3>{operationNames[assessment.operation]}</h3>
        <Status tone={assessment.status === "ready" ? "muted" : "warning"}>
          {assessment.status}
        </Status>
      </div>
      <p className="notice">
        This only checks requirements. Ready does not mean the test passed, and
        nothing runs from this check.
      </p>
      <p className="fine-print">
        Input version {assessment.revision_id ?? "Unknown"}
      </p>
      <dl className="binding-list">
        {assessment.prerequisites.map((fact) => (
          <div key={fact.code} data-prerequisite-code={fact.code}>
            <dt>
              {fact.code.replaceAll("_", " ")}{" "}
              <Status tone={fact.status === "ready" ? "muted" : "warning"}>
                {fact.status}
              </Status>
            </dt>
            <dd>
              {fact.detail}
              <BindingMetadata binding={fact.binding} />
            </dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Selected inputs</summary>
        <SelectedOperationInput
          label="Metric"
          input={assessment.selected_input.metric}
        />
        <SelectedOperationInput
          label="Data snapshot"
          input={assessment.selected_input.snapshot}
          records={assessment.selected_input.snapshot.records}
        />
      </details>
      <details>
        <summary>Capacity and work details</summary>
        <LimitRows
          rows={[
            [
              "Workspace active work",
              countLabel(assessment.admission.workspace_active),
            ],
            [
              "Workspace concurrency limit",
              countLabel(assessment.admission.workspace_limit),
            ],
            [
              "Installation active work",
              countLabel(assessment.admission.installation_active),
            ],
            [
              "Installation concurrency limit",
              countLabel(assessment.admission.installation_limit),
            ],
            ["Required work units", countLabel(assessment.required_work_units)],
            [
              "Optional model calls required",
              countLabel(assessment.optional_model_calls),
            ],
            [
              "Required protected observations",
              assessment.expected_observations === null
                ? assessment.operation === "analytic"
                  ? "Not a browser operation"
                  : "Unknown"
                : countLabel(assessment.expected_observations),
            ],
            [
              "Requested storage estimate",
              byteLabel(assessment.requested_storage_bytes),
            ],
            [
              "Requested duration estimate",
              countLabel(assessment.requested_duration_seconds, "seconds"),
            ],
            ["Admission reserved", "No"],
          ]}
        />
        {assessment.browser_limits && (
          <LimitRows
            rows={[
              [
                "Browser task timeout ceiling",
                countLabel(
                  assessment.browser_limits.task_timeout_seconds,
                  "seconds",
                ),
              ],
              [
                "Browser artifact ceiling",
                byteLabel(assessment.browser_limits.artifact_bytes),
              ],
            ]}
          />
        )}
        <p className="fine-print">
          These are recorded capacity facts and configured requirements, not
          measured execution time or a storage reservation. Unknown capacity and
          estimates remain unknown.
        </p>
      </details>
      <details>
        <summary>Recorded capabilities</summary>
        <RecordedCapability
          label="Runner capability"
          value={assessment.capabilities.runner}
        />
        <RecordedCapability
          label="Optional model capability"
          value={assessment.capabilities.model}
        />
        {assessment.capabilities.adapters?.map((adapter, index) => (
          <RecordedCapability
            key={adapter.id ?? `${adapter.kind}-${index}`}
            label={`Adapter capability: ${adapter.kind}${adapter.id ? ` · ${adapter.id}` : ""}`}
            value={adapter}
          />
        ))}
        <p className="fine-print">
          Configuration and recorded availability are separate. No probe runs
          here. Optional model availability does not turn manual analysis into a
          model-dependent operation.
        </p>
      </details>
    </section>
  );
}

export function SelectedOperationPreflight({
  base,
  item,
}: {
  base: string;
  item: Investigation;
}) {
  const [selection, setSelection] =
      useState<OperationSelection>(emptySelection),
    [assessment, setAssessment] = useState<OperationAssessment | null>(null),
    [error, setError] = useState<Error | null>(null),
    [pending, setPending] = useState(false),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    setSelection(emptySelection);
    return () => request.current?.abort();
  }, [base]);
  useEffect(() => {
    request.current?.abort();
    setAssessment(null);
    setError(null);
    setPending(false);
  }, [base, item.revision, item.active_revision_id]);
  function change(field: keyof OperationSelection, value: string) {
    setSelection(
      (previous) => ({ ...previous, [field]: value }) as OperationSelection,
    );
    setAssessment(null);
    setError(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setAssessment(null);
    setError(null);
    try {
      const value = await readOperationAssessment(
        base,
        item.id,
        selection,
        controller.signal,
        item.active_revision_id,
      );
      if (!controller.signal.aborted) setAssessment(value);
    } catch (cause) {
      if (!controller.signal.aborted) setError(formError(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }
  const fields: [keyof OperationSelection, string][] =
    selection.operation === "analytic"
      ? [
          ["hypothesis_id", "Possible reason ID"],
          ["analytic_plan_id", "Analytic plan ID"],
        ]
      : [
          ["hypothesis_id", "Possible reason ID"],
          ...(selection.objective === "correction"
            ? ([
                ["candidate_id", "Correction candidate ID"],
                ["mechanism_result_id", "Reproduced mechanism result ID"],
              ] as [keyof OperationSelection, string][])
            : []),
          ...(selection.operation === "browser_run"
            ? ([
                ["plan_id", "Browser plan ID"],
                ["grant_id", "Target grant ID"],
                ["approval_id", "Plan approval ID"],
              ] as [keyof OperationSelection, string][])
            : []),
        ];
  return (
    <section aria-label="Check selected operation">
      <h3>Check if work can start</h3>
      <p>
        Choose an action. You can add IDs to check a specific saved item. This
        check does not start anything.
      </p>
      <form onSubmit={submit}>
        <Field label="Action">
          <select
            value={selection.operation}
            disabled={pending}
            onChange={(event) => change("operation", event.target.value)}
          >
            {Object.entries(operationNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {selection.operation !== "analytic" && (
          <Field label="Test goal">
            <select
              value={selection.objective}
              disabled={pending}
              onChange={(event) => change("objective", event.target.value)}
            >
              <option value="">Choose a goal</option>
              <option value="mechanism">Reproduce the issue</option>
              <option value="correction">Check a fix</option>
            </select>
          </Field>
        )}
        {fields.map(([field, label]) => (
          <Field key={field} label={label}>
            <input
              value={selection[field]}
              maxLength={36}
              pattern={uuidPattern}
              disabled={pending}
              onChange={(event) => change(field, event.target.value)}
            />
          </Field>
        ))}
        <ErrorNotice error={error} />
        <button className="secondary" disabled={pending}>
          {pending ? "Checking…" : "Check requirements"}
        </button>
      </form>
      {pending && <Loading label="Checking requirements…" />}
      {assessment && <OperationAssessmentResult assessment={assessment} />}
    </section>
  );
}

export function OperationLimits({
  limits,
  usage,
  selectedInput,
}: {
  limits?: PreflightLimits;
  usage?: PreflightUsage;
  selectedInput?: Preflight["selected_input"];
}) {
  const source = limits?.source,
    metric = limits?.metric,
    storage = limits?.storage,
    model = limits?.model,
    jobs = limits?.jobs,
    browser = limits?.browser;
  return (
    <section aria-label="Effective operation limits">
      <h3>Limits and usage</h3>
      {!limits && (
        <p className="notice warning">
          Limits are unknown. Refresh before continuing.
        </p>
      )}
      <div className="claim-grid">
        <div>
          <span>Records per capture</span>
          <strong>{countLabel(source?.records)}</strong>
        </div>
        <div>
          <span>Selected snapshot</span>
          <strong>
            {selectedInput?.snapshot_id ??
              "Unknown — no selected snapshot supplied"}
          </strong>
        </div>
        <div>
          <span>Selected snapshot records</span>
          <strong>{countLabel(selectedInput?.records)}</strong>
        </div>
      </div>
      <details>
        <summary>Data and metric limits</summary>
        <LimitRows
          rows={[
            ["Source file limit", byteLabel(source?.file_bytes)],
            ["Expanded capture limit", byteLabel(source?.expanded_bytes)],
            ["Record limit per capture", countLabel(source?.records)],
            ["Files per capture", countLabel(source?.files)],
            ["JSON nesting depth", countLabel(source?.json_depth)],
            ["CSV field limit", byteLabel(source?.csv_field_bytes)],
            ["Groups per metric", countLabel(metric?.cohorts)],
            ["Days per metric period", countLabel(metric?.period_days, "days")],
            [
              "Conversion observation horizon",
              countLabel(metric?.horizon_seconds, "seconds"),
            ],
          ]}
        />
        <p className="fine-print">
          File and decompressed-byte limits apply separately. Event-time windows
          and the full conversion observation tail still require coverage
          review.
        </p>
      </details>
      <details>
        <summary>Storage and usage</summary>
        <LimitRows
          rows={[
            ["Investigation storage limit", byteLabel(storage?.ceiling_bytes)],
            ["Storage used", byteLabel(storage?.used_bytes)],
            ["Storage reserved", byteLabel(storage?.reserved_bytes)],
            ["Storage remaining", byteLabel(storage?.remaining_bytes)],
            [
              "Run limit for this version",
              countLabel(usage?.work_units?.ceiling),
            ],
            ["Runs used", countLabel(usage?.work_units?.spent)],
            ["Runs reserved", countLabel(usage?.work_units?.reserved)],
            ["Runs remaining", countLabel(usage?.work_units?.remaining)],
          ]}
        />
        {!usage?.work_units && (
          <p className="fine-print">
            Work-unit usage was not returned for this view. Missing usage is
            unknown, rather than zero or unused capacity.
          </p>
        )}
        <p className="fine-print">
          Storage values come from the current ledger. Work units and model
          calls are separate allowances; neither is a currency estimate.
        </p>
      </details>
      <details>
        <summary>agent limits and usage</summary>
        <LimitRows
          rows={[
            [
              "Total model wire attempts per revision",
              countLabel(model?.automatic_calls),
            ],
            ["Model input-token ceiling", countLabel(model?.input_tokens)],
            ["Model output-token ceiling", countLabel(model?.output_tokens)],
            [
              "Model call timeout",
              countLabel(model?.call_timeout_seconds, "seconds"),
            ],
            ["Model calls spent", countLabel(usage?.model?.calls_spent)],
            ["Model calls reserved", countLabel(usage?.model?.calls_reserved)],
            [
              "Input-token budget charged",
              countLabel(usage?.model?.input_spent),
            ],
            [
              "Input-token budget reserved",
              countLabel(usage?.model?.input_reserved),
            ],
            [
              "Output-token budget charged",
              countLabel(usage?.model?.output_spent),
            ],
            [
              "Output-token budget reserved",
              countLabel(usage?.model?.output_reserved),
            ],
          ]}
        />
        {!usage?.model && (
          <p className="fine-print">
            Model budget accounting was not returned for this view. Missing
            charges and reservations remain unknown.
          </p>
        )}
        <p className="fine-print">
          Input and output amounts are conservative budget charges and
          reservations. Provider-reported token usage is unavailable in this
          panel. Wire retries and schema repair share the revision allowance.
          These caps do not trigger a provider call or establish a configured
          provider's availability. Explicit profile and evidence review remain
          required.
        </p>
      </details>
      <details>
        <summary>Run and browser test limits</summary>
        <LimitRows
          rows={[
            [
              "Source-capture deadline",
              countLabel(jobs?.source_capture_deadline_seconds, "seconds"),
            ],
            ["General run deadline", "Unknown — no general timeout supplied"],
            [
              "Active runs per workspace",
              countLabel(jobs?.workspace_concurrency),
            ],
            [
              "Active runs per installation",
              countLabel(jobs?.installation_concurrency),
            ],
            [
              "Cancellation check interval",
              countLabel(jobs?.cancel_poll_seconds, "seconds"),
            ],
            [
              "Browser tests",
              browser?.enabled === true
                ? "Enabled — runner setup and approval still required"
                : browser?.enabled === false
                  ? "Disabled"
                  : "Unknown",
            ],
            [
              "Browser test timeout",
              countLabel(browser?.task_timeout_seconds, "seconds"),
            ],
            ["Browser test combinations", countLabel(browser?.matrix_cells)],
            ["Repeats per combination", countLabel(browser?.repeats_per_cell)],
            ["Steps per combination", countLabel(browser?.actions_per_cell)],
            ["Browser artifact limit", byteLabel(browser?.artifact_bytes)],
          ]}
        />
        <p className="fine-print">
          The source-capture deadline applies to that operation. A generic job
          deadline is unavailable: renewable worker leases do not establish a
          general timeout. Deadlines and polling intervals are configuration
          values, not measured latency or a successful cancellation. Browser
          limits do not activate a runner, approve a target or reduce required
          controls.
        </p>
      </details>
    </section>
  );
}
export function PreflightResult({ value }: { value: Preflight }) {
  return (
    <>
      <div className="claim-grid">
        {[
          ["Metric", value.metric],
          ["Data snapshot", value.snapshot],
          [
            "Active work",
            value.active_work === true
              ? "Runs in progress"
              : value.active_work === false
                ? "None"
                : "Unknown",
          ],
          [
            "Manual analysis",
            value.manual === true
              ? "Available"
              : value.manual === false
                ? "Unavailable"
                : "Unknown",
          ],
          ["Agent model", value.model],
          ["Browser runner", value.runner],
        ].map(([label, detail]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{detail ?? "Unknown"}</strong>
          </div>
        ))}
      </div>
      <p className="notice">{value.quality ?? "Data quality is unknown."}</p>
      <p className="fine-print">
        Ready settings do not mean a test has passed.
      </p>
      <details>
        <summary>Version details</summary>
        <p>{value.revision_id ?? "Unknown"}</p>
      </details>
      <OperationLimits
        limits={value.limits}
        usage={value.usage}
        selectedInput={value.selected_input}
      />
    </>
  );
}
export function CasePreflight({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: Investigation;
}) {
  const [value, setValue] = useState<Preflight | null>(null),
    [error, setError] = useState<Error | null>(null),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0),
    path = casePath(workspaceId, item.id);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setValue(null);
    setError(null);
    resource<Preflight>(`${path}/preflight`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, item.revision, reload]);
  return (
    <section className="panel preflight-panel">
      <details>
        <summary>Checks and limits</summary>
        <div className="section-heading">
          <h2>Requirements</h2>
          <button
            className="text-button"
            disabled={loading}
            onClick={() => setReload((previous) => previous + 1)}
          >
            Refresh
          </button>
        </div>
        <ErrorNotice error={error} />
        {loading ? (
          <Loading label="Checking requirements…" />
        ) : value ? (
          <PreflightResult value={value} />
        ) : (
          <p className="muted">
            Requirements are unknown. Fix the error and refresh before
            continuing.
          </p>
        )}
        <SelectedOperationPreflight base={path} item={item} />
      </details>
    </section>
  );
}

export function CaseDisposition({
  workspaceId,
  csrf,
  item,
  onUpdated,
}: {
  workspaceId: string;
  csrf: string;
  item: Investigation;
  onUpdated: (value: Investigation) => void;
}) {
  const send = useCommand(csrf),
    [review, setReview] = useState<Investigation | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<Error | null>(null),
    path = casePath(workspaceId, item.id);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review) return;
    const form = new FormData(event.currentTarget),
      reopen = review.lifecycle === "closed";
    setPending(true);
    setError(null);
    try {
      const body = {
        note: String(form.get("note")).trim(),
        ...(reopen ? {} : { disposition: String(form.get("disposition")) }),
      };
      const value = await send<Investigation>(
        `${path}/${reopen ? "reopen" : "close"}`,
        body,
        "POST",
        review.revision,
      );
      onUpdated(value);
      setReview(null);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  async function refresh() {
    setPending(true);
    try {
      const value = await resource<Investigation>(path);
      onUpdated(value);
      setReview(value);
      setError(null);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button
        className="secondary"
        disabled={pending || item.archived}
        onClick={() => {
          setError(null);
          setReview(item);
        }}
      >
        {item.lifecycle === "closed" ? "Reopen" : "Close"}
      </button>
      {review && (
        <Modal
          title={
            review.lifecycle === "closed"
              ? "Reopen investigation"
              : "Close investigation"
          }
          onClose={() => {
            if (!pending) setReview(null);
          }}
        >
          <form onSubmit={submit}>
            <ErrorNotice error={error} />
            {error && (
              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => void refresh()}
              >
                Refresh and try again
              </button>
            )}
            <p>
              {review.lifecycle === "closed"
                ? "Reopening allows new work. Existing results stay available."
                : "Closing stops new changes. Existing evidence and results stay available."}
            </p>
            {review.lifecycle !== "closed" && (
              <Field label="Outcome">
                <select name="disposition" defaultValue="unresolved">
                  <option value="unresolved">Unresolved</option>
                  <option value="resolved">Resolved</option>
                  <option value="no_issue">No issue found</option>
                </select>
              </Field>
            )}
            <Field
              label={
                review.lifecycle === "closed"
                  ? "Why are you reopening it?"
                  : "Note"
              }
            >
              <textarea name="note" required maxLength={2000} rows={4} />
            </Field>
            <p className="notice">
              Closing an investigation does not change its test results. Unknown
              and untested results stay visible.
            </p>
            <label className="review-checkbox" key={review.revision}>
              <input type="checkbox" required />I checked this change.
            </label>
            <button className="primary" disabled={pending || review.archived}>
              {pending
                ? "Saving…"
                : review.lifecycle === "closed"
                  ? "Reopen investigation"
                  : "Close investigation"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
