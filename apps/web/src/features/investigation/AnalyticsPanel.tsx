import {displayLabel, evidenceSummary, plainSummary} from '../../plain-language';
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  formError,
} from "../../ui";
import { SourceRows } from "../data/Presentation";
import { pointsLabel, rateLabel, type AcceptedJob } from "../data/types";
import { BindingSummary, EvidencePicker, useCommand } from "./Shared";
import {
  selected,
  testLabels,
  type AnalyticKind,
  type AnalyticPlan,
  type AnalyticRecord,
  type AnalysisContext,
  type Evidence,
  type Hypothesis,
  type PlanRecord,
} from "./types";

const analyticKinds: AnalyticKind[] = [
  "data_quality",
  "cohort_change",
  "mix_shift",
  "temporal_alignment",
  "negative_control",
];
export function AnalyticsPanel({
  base,
  csrf,
  context,
  hypotheses,
  evidence,
  canMutate,
  plan,
  result,
  resultPending,
  onPlan,
  onJob,
}: {
  base: string;
  csrf: string;
  context: AnalysisContext | null;
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  canMutate: boolean;
  plan: PlanRecord | null;
  result: AnalyticRecord | null;
  resultPending: boolean;
  onPlan: (plan: PlanRecord) => void;
  onJob: (job: AcceptedJob) => void;
}) {
  const send = useCommand(csrf),
    temporary = useRef<{ body: string; id: string } | null>(null),
    [hypothesisId, setHypothesisId] = useState(""),
    [kind, setKind] = useState<AnalyticKind>("data_quality"),
    [pending, setPending] = useState(""),
    [error, setError] = useState<Error | null>(null),
    [reviewed, setReviewed] = useState(false),
    [message, setMessage] = useState(""),
    [reviewOpen, setReviewOpen] = useState(false);
  const currentHypotheses = hypotheses.filter(
      (item) => item.revision_id === context?.binding.revision_id,
    ),
    hypothesis = currentHypotheses.find((item) => item.id === hypothesisId),
    allowedKinds = analyticKinds.filter((value) =>
      hypothesis?.proposed_test_kinds.includes(value),
    );
  useEffect(() => {
    if (!currentHypotheses.some((item) => item.id === hypothesisId))
      setHypothesisId(currentHypotheses[0]?.id ?? "");
  }, [hypotheses, context?.binding.revision_id, hypothesisId]);
  useEffect(() => {
    if (!allowedKinds.includes(kind))
      setKind(allowedKinds[0] ?? "data_quality");
  }, [hypothesisId, hypotheses, kind]);
  useEffect(() => {
    setReviewed(false);
    setReviewOpen(false);
  }, [plan?.id, plan?.plan_hash, context?.binding.revision_id]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context || !hypothesis) return;
    const form = new FormData(event.currentTarget);
    setPending("Saving finite analytic plan…");
    setError(null);
    setMessage("");
    try {
      const evidence_ids = selected(form, "analytic_evidence"),
        cohorts = selected(form, "cohorts");
      if (!evidence_ids.length)
        throw new Error(
          "Select at least one accessible sanitized evidence record.",
        );
      if (kind === "negative_control" && !cohorts.length)
        throw new Error(
          "A negative control must explicitly name its expected unaffected group.",
        );
      const fields = {
        ...context.binding,
        schema_version: 1 as const,
        hypothesis_id: hypothesis.id,
        kind,
        evidence_ids,
        cohorts,
        expected_direction:
          kind === "negative_control"
            ? ("unchanged" as const)
            : (String(
                form.get("direction"),
              ) as AnalyticPlan["expected_direction"]),
        minimum_denominator: Number(form.get("minimum")),
        purpose: String(form.get("purpose")).trim(),
      };
      const canonical = JSON.stringify(fields);
      if (!temporary.current || temporary.current.body !== canonical)
        temporary.current = { body: canonical, id: crypto.randomUUID() };
      const record = await send<PlanRecord>(`${base}/analytic-plans`, {
        plan: { ...fields, id: temporary.current.id },
      });
      temporary.current = null;
      onPlan(record);
      setMessage(
        "Analytic plan saved. Review its exact inputs before running.",
      );
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  async function run() {
    if (!plan || !reviewed) return;
    setPending("Accepting reviewed analytic computation…");
    setError(null);
    setMessage("");
    try {
      const accepted = await send<AcceptedJob>(
        `${base}/analytic-plans/${encodeURIComponent(plan.id)}/runs`,
        { plan_hash: plan.plan_hash },
      );
      onJob(accepted);
      setMessage(
        "Reviewed analytic computation accepted. No test outcome is inferred.",
      );
      setReviewOpen(false);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  const stalePlan =
    !!plan &&
    (!context ||
      plan.value.revision_id !== context.binding.revision_id ||
      plan.value.metric_hash !== context.binding.metric_hash ||
      plan.value.snapshot_hash !== context.binding.snapshot_hash);
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Saved data</p>
            <h2>Data checks</h2>
          </div>
          <Status tone="muted">Uses saved data</Status>
        </div>
        <p>
          Test a clear prediction using the selected data. A passing check shows
          a pattern; it does not prove the cause or confirm a fix.
        </p>
        <ErrorNotice error={reviewOpen ? null : error} />
        <p
          className={message ? "notice" : "sr-only"}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {message}
        </p>
        {context ? (
          <BindingSummary binding={context.binding} />
        ) : (
          <div className="notice warning">
            Lock a metric and choose data before planning a check.
          </div>
        )}
        {!context?.comparison && (
          <p className="notice warning">
            A current completed comparison is required to run a saved plan.
          </p>
        )}
        {canMutate && context && (
          <form className="analytic-form" onSubmit={save}>
            <Field label="Current possible reason">
              <select
                value={hypothesisId}
                onChange={(event) => setHypothesisId(event.target.value)}
                required
              >
                <option value="">Choose a current possible reason</option>
                {currentHypotheses.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Check type">
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as AnalyticKind)
                }
                disabled={!allowedKinds.length}
              >
                {allowedKinds.map((value) => (
                  <option value={value} key={value}>
                    {testLabels[value]}
                  </option>
                ))}
              </select>
            </Field>
            {!allowedKinds.length && (
              <p className="notice warning">
                This possible reason has no declared local analytic kind. Review its
                proposed tests, or select another current possible reason.
              </p>
            )}
            <EvidencePicker
              key={hypothesisId}
              evidence={evidence}
              name="analytic_evidence"
              label="Evidence to use"
              required
            />
            <fieldset className="finite-picker">
              <legend>
                {kind === "negative_control"
                  ? "Expected unaffected group — explicit selection required"
                  : "Selected groups — leave empty to use all metric groups"}
              </legend>
              {context.metric.cohorts.map((cohort) => (
                <label key={cohort} className="picker-choice">
                  <input type="checkbox" name="cohorts" value={cohort} />
                  <span>{cohort}</span>
                </label>
              ))}
            </fieldset>
            <div className="date-pair">
              <Field label="Predicted direction">
                <select
                  name="direction"
                  key={kind}
                  defaultValue={
                    kind === "negative_control" ? "unchanged" : "unknown"
                  }
                  disabled={kind === "negative_control"}
                >
                  <option value="unknown">
                    Unknown — no directional prediction
                  </option>
                  <option value="decrease">Decrease</option>
                  <option value="increase">Increase</option>
                  <option value="unchanged">Unchanged</option>
                </select>
              </Field>
              <Field
                label="Minimum sessions per group"
                hint="Groups with fewer sessions return an inconclusive result."
              >
                <input
                  name="minimum"
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  defaultValue={100}
                  required
                />
              </Field>
            </div>
            <Field label="What do you expect to see?">
              <textarea name="purpose" required maxLength={2000} rows={4} />
            </Field>
            <button
              className="primary"
              disabled={!!pending || !hypothesis || !allowedKinds.length}
            >
              {pending || "Save test plan"}
            </button>
          </form>
        )}
      </section>
      {plan && (
        <section className="panel">
          <div className="section-heading">
            <h2>Test plan</h2>
            <Status tone={stalePlan ? "warning" : "muted"}>
              {stalePlan ? "Earlier data" : "Ready to review"}
            </Status>
          </div>
          <p>
            {testLabels[plan.value.kind]} · Expected{" "}
            {plan.value.expected_direction} · Minimum{" "}
            {plan.value.minimum_denominator.toLocaleString()} sessions per
            selected group and period.
          </p>
          <p>{plan.value.purpose}</p>
          <p>
            Groups:{" "}
            {plan.value.cohorts.length
              ? plan.value.cohorts.join(", ")
              : "All metric groups"}
          </p>
          <BindingSummary binding={plan.value} />
          <details>
            <summary>Inspect exact finite plan</summary>
            <pre>{JSON.stringify(plan.value, null, 2)}</pre>
            <p className="hash-line">Plan hash {plan.plan_hash}</p>
          </details>
          {canMutate && (
            <>
              <button
                type="button"
                className="primary"
                disabled={!!pending || stalePlan || !context?.comparison}
                onClick={() => {
                  setError(null);
                  setReviewed(false);
                  setReviewOpen(true);
                }}
              >
                Review test plan
              </button>
            </>
          )}
          {stalePlan && (
            <p className="notice warning">
              Inputs changed. This saved plan cannot establish a current result;
              review a new plan against the current frozen inputs.
            </p>
          )}
        </section>
      )}
      {reviewOpen && plan && (
        <Modal
          title="Review test plan"
          onClose={() => {
            if (!pending) setReviewOpen(false);
          }}
        >
          <ErrorNotice error={error} />
          <p>
            {testLabels[plan.value.kind]} · Expected{" "}
            {plan.value.expected_direction} · Minimum{" "}
            {plan.value.minimum_denominator} sessions per selected group and
            period.
          </p>
          <p>{plan.value.purpose}</p>
          <p className="notice">
            This runs the saved check. The result can pass, fail, be blocked, or
            be inconclusive. It does not prove the cause or confirm a fix.
          </p>
          <p className="hash-line">
            Plan {plan.id}
            <br />
            Plan hash {plan.plan_hash}
            <br />
            Metric hash {plan.value.metric_hash}
            <br />
            Snapshot hash {plan.value.snapshot_hash}
            <br />
            Input revision {plan.value.revision_id}
          </p>
          <p>Sanitized evidence: {plan.value.evidence_ids.join(", ")}</p>
          <details>
            <summary>Inspect exact reviewed plan</summary>
            <pre>{JSON.stringify(plan.value, null, 2)}</pre>
          </details>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <label className="review-checkbox">
              <input
                type="checkbox"
                checked={reviewed}
                required
                onChange={(event) => setReviewed(event.target.checked)}
                disabled={stalePlan || !!pending}
              />
              I reviewed this plan, its evidence, expected direction, and sample size.
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={!!pending}
                onClick={() => setReviewOpen(false)}
              >
                Cancel plan review
              </button>
              <button
                className="primary"
                disabled={
                  !!pending || !reviewed || stalePlan || !context?.comparison
                }
              >
                {pending || "Run approved check"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {resultPending ? (
        <Loading label="Loading recorded analytic outcome…" />
      ) : result ? (
        <AnalyticResultView result={result} />
      ) : (
        <section className="panel">
          <h2>No result selected</h2>
          <p>
            Run a reviewed finite plan or reopen its persisted job/result URL. A
            missing or unrun result is not a passing check.
          </p>
        </section>
      )}
    </>
  );
}

export function AnalyticResultView({ result }: { result: AnalyticRecord }) {
  const value = result.value,
    details = value.details,
    rows = Array.isArray(details.cohorts)
      ? details.cohorts
      : Array.isArray(details.entries)
        ? details.entries
        : null;
  return (
    <section className="panel analytic-result">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Recorded result</p>
          <h2>{testLabels[value.kind]}</h2>
        </div>
        <div className="status-group">
          <Status
            tone={
              value.freshness === "stale" || value.outcome !== "passed"
                ? "warning"
                : "neutral"
            }
          >
            {value.outcome}
          </Status>
          <Status tone={value.freshness === "stale" ? "warning" : "muted"}>
            {value.freshness}
          </Status>
        </div>
      </div>
      <p
        className="fine-print"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Recorded check result: {value.outcome}. Freshness: {value.freshness}
        .
      </p>
      <p className="notice">
        This pattern does not prove the cause or the fix.
      </p>
      {value.reasons.length > 0 && (
        <ul>
          {value.reasons.map((reason) => (
            <li key={reason}>{displayLabel(reason)}</li>
          ))}
        </ul>
      )}
      {rows ? (
        <SourceRows
          title="Recorded observations"
          rows={
            rows.filter((row) => row && typeof row === "object") as Record<
              string,
              unknown
            >[]
          }
        />
      ) : value.kind === "mix_shift" ? (
        <dl className="mix-result">
          <div>
            <dt>Later rate with the earlier group mix</dt>
            <dd>
              {rateLabel(
                typeof details.standardized_rate === "number"
                  ? details.standardized_rate
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt>Change within groups</dt>
            <dd>
              {pointsLabel(
                typeof details.within_component_pp === "number"
                  ? details.within_component_pp
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt>Change from group mix</dt>
            <dd>
              {pointsLabel(
                typeof details.composition_component_pp === "number"
                  ? details.composition_component_pp
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt>Adjustment state</dt>
            <dd>{String(details.status ?? "Unknown")}</dd>
          </div>
        </dl>
      ) : (
        <dl className="diagnostic-values">
          {Object.entries(details)
            .filter(
              ([, detail]) =>
                detail === null ||
                ["string", "number", "boolean"].includes(typeof detail),
            )
            .map(([name, detail]) => (
              <div key={name}>
                <dt>{displayLabel(name)}</dt>
                <dd>{detail === null ? "Unknown" : String(detail)}</dd>
              </div>
            ))}
        </dl>
      )}
      <h3>Limitations</h3>
      <ul>
        {value.limitations.map((limitation, index) => (
          <li key={index}>{plainSummary(limitation)}</li>
        ))}
      </ul>
      <details>
        <summary>Result details</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
      <p className="fine-print">Result {result.id}</p>
    </section>
  );
}
