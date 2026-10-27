import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import { resource, type Investigation, type Workspace } from "../../api";
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Status,
  formError,
} from "../../ui";
import { EvidencePicker, useCommand } from "./Shared";
import { selected, type Evidence, type Hypothesis } from "./types";
import type {
  ExternalBrowserAction,
  ExternalBrowserApproval,
  ExternalBrowserAttempt,
  ExternalBrowserInventory,
  ExternalBrowserObservation,
  ExternalBrowserPlan,
  ExternalBrowserPlanInput,
  ExternalBrowserResult,
  ExternalBrowserResultDetail,
  ExternalBrowserRun,
} from "./external-verification-types";

const INDEPENDENT_OBSERVATION_REQUIRED =
  "INDEPENDENT_DEPLOYMENT_OBSERVATION_REQUIRED";
export const defaultExternalActions: ExternalBrowserAction[] = [
  { op: "navigate", path: "/" },
  { op: "click", locator: { kind: "test_id", value: "pay" } },
];
const locatorRoles = [
  "button",
  "textbox",
  "checkbox",
  "link",
  "combobox",
] as const;
const finiteId = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const localDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function plain(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function locator(
  value: unknown,
): value is Extract<ExternalBrowserAction, { op: "click" }>["locator"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>,
    kind = item.kind;
  if (
    !["test_id", "role", "label"].includes(String(kind)) ||
    !plain(item.value, 200)
  )
    return false;
  if (Object.keys(item).some((key) => !["kind", "value", "role"].includes(key)))
    return false;
  return (
    kind !== "role" ||
    ["button", "textbox", "checkbox", "link", "combobox"].includes(
      String(item.role),
    )
  );
}

/** Parse only the finite, declarative runner DSL. This never evaluates supplied text. */
export function parseExternalActions(raw: string): ExternalBrowserAction[] {
  requireCondition(
    raw.length > 0 && raw.length <= 20_000,
    "Supply a bounded finite browser action list.",
  );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Browser actions must be valid JSON.");
  }
  requireCondition(
    Array.isArray(value) && value.length >= 1 && value.length <= 30,
    "Use one to thirty finite browser actions.",
  );
  requireCondition(
    (value[0] as { op?: unknown })?.op === "navigate",
    "The finite browser plan must begin with same-origin navigation.",
  );
  for (const action of value) {
    requireCondition(
      action && typeof action === "object" && !Array.isArray(action),
      "Each browser action must be a finite object.",
    );
    const item = action as Record<string, unknown>;
    if (item.op === "navigate") {
      requireCondition(
        Object.keys(item).sort().join(",") === "op,path" &&
          plain(item.path, 1000) &&
          /^\/(?!\/)[A-Za-z0-9/_.?=&%-]*$/.test(item.path),
        "Navigation must use a bounded same-origin path.",
      );
    } else if (item.op === "click") {
      requireCondition(
        Object.keys(item).sort().join(",") === "locator,op" &&
          locator(item.locator),
        "Click requires one finite accessible locator.",
      );
    } else if (item.op === "fill") {
      requireCondition(
        Object.keys(item).sort().join(",") === "locator,op,value_ref" &&
          locator(item.locator) &&
          plain(item.value_ref, 128) &&
          finiteId.test(item.value_ref),
        "Fill requires a finite locator and fixture value reference.",
      );
    } else if (item.op === "wait_for") {
      requireCondition(
        Object.keys(item).sort().join(",") === "locator,op,timeout_ms" &&
          locator(item.locator) &&
          Number.isSafeInteger(item.timeout_ms) &&
          Number(item.timeout_ms) >= 1 &&
          Number(item.timeout_ms) <= 10_000,
        "Wait requires a finite locator and timeout from 1 to 10000 milliseconds.",
      );
    } else
      throw new Error(
        "Only navigate, click, fill and wait_for actions are supported.",
      );
  }
  return structuredClone(value) as ExternalBrowserAction[];
}

function two(value: number) {
  return String(value).padStart(2, "0");
}
/** Format an instant for datetime-local without relabelling UTC clock fields as local time. */
export function localDateTimeInputValue(value: Date): string {
  requireCondition(
    Number.isFinite(value.getTime()),
    "Approval expiry must be a valid instant.",
  );
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}:${two(value.getSeconds())}`;
}
/** Convert the wall-clock value emitted by datetime-local into its exact UTC instant. */
export function localDateTimeInputToIso(value: string): string {
  const fields = localDateTime.exec(value);
  requireCondition(
    fields,
    "Approval expiry must include a valid local date and time.",
  );
  const numbers = fields.slice(1).map(Number),
    [year, month, day, hour, minute, second] = numbers;
  const instant = new Date(year!, month! - 1, day!, hour!, minute!, second!, 0);
  requireCondition(
    Number.isFinite(instant.getTime()) &&
      instant.getFullYear() === year &&
      instant.getMonth() === month! - 1 &&
      instant.getDate() === day &&
      instant.getHours() === hour &&
      instant.getMinutes() === minute &&
      instant.getSeconds() === second,
    "Approval expiry must be a valid local date and time.",
  );
  return instant.toISOString();
}

export function externalPlanInput(
  form: FormData,
  evidence: Evidence[],
): ExternalBrowserPlanInput {
  const text = (name: string, label: string) => {
    const value = String(form.get(name) ?? "");
    requireCondition(finiteId.test(value), `Select a recorded ${label}.`);
    return value;
  };
  const objective = String(form.get("objective"));
  requireCondition(
    objective === "mechanism" || objective === "correction",
    "Select a finite browser objective.",
  );
  const evidenceIds = selected(form, "external_evidence");
  requireCondition(
    evidenceIds.length <= 20 &&
      evidenceIds.every((id) =>
        evidence.some(
          (item) => item.id === id && item.redaction_status === "sanitized",
        ),
      ),
    "Select only accessible sanitized evidence.",
  );
  const candidate = String(form.get("candidate_build_id") ?? "");
  if (objective === "correction")
    requireCondition(
      finiteId.test(candidate),
      "Select a recorded candidate build for correction testing.",
    );
  return {
    hypothesis_id: text("hypothesis_id", "current possible reason"),
    objective,
    runner_id: text("runner_id", "runner"),
    environment_id: text("environment_id", "environment"),
    fixture_profile_id: text("fixture_profile_id", "fixture profile"),
    observation_profile_id: text(
      "observation_profile_id",
      "observation profile",
    ),
    grant_id: text("grant_id", "target grant"),
    build_ids: {
      known_good: text("known_good_build_id", "known-good build"),
      incident: text("incident_build_id", "incident build"),
      ...(candidate ? { candidate } : {}),
    },
    actions: parseExternalActions(String(form.get("actions") ?? "")),
    evidence_ids: evidenceIds,
  };
}

export function externalApprovalInput(
  plan: ExternalBrowserPlan,
  grantId: string,
  expiresAt: string,
) {
  requireCondition(
    finiteId.test(plan.id) && /^[a-f0-9]{64}$/i.test(plan.plan_hash),
    "Refresh the exact immutable plan before approval.",
  );
  const oracleHash = String(planValue(plan).oracle_hash ?? "");
  requireCondition(
    /^[a-f0-9]{64}$/i.test(oracleHash),
    "The immutable server-owned oracle binding is unavailable. Refresh this plan before approval.",
  );
  requireCondition(
    finiteId.test(grantId),
    "Select the recorded target grant bound to this plan.",
  );
  const instant = localDateTimeInputToIso(expiresAt);
  requireCondition(
    Date.parse(instant) > Date.now(),
    "Approval expiry must be a future instant.",
  );
  return {
    plan_hash: plan.plan_hash,
    oracle_hash: oracleHash,
    grant_id: grantId,
    expires_at: instant,
  };
}
export function externalRunInput(
  plan: ExternalBrowserPlan,
  approval: ExternalBrowserApproval,
) {
  requireCondition(
    approval.plan_id === plan.id &&
      approval.plan_hash === plan.plan_hash &&
      !approval.revoked,
    "Approval does not bind the selected immutable plan.",
  );
  requireCondition(
    Date.parse(approval.expires_at) > Date.now(),
    "The selected exact-plan approval has expired.",
  );
  return { approval_id: approval.id };
}

type ExternalCommand = <T>(
  path: string,
  body: unknown,
  method?: string,
  revision?: number,
) => Promise<T>;
export async function revokeExternalApproval(
  send: ExternalCommand,
  base: string,
  plan: ExternalBrowserPlan,
  approval: ExternalBrowserApproval,
  reason: string,
) {
  requireCondition(
    approval.plan_id === plan.id &&
      approval.plan_hash === plan.plan_hash &&
      !approval.revoked,
    "The selected approval is not current for this exact plan.",
  );
  requireCondition(
    Date.parse(approval.expires_at) > Date.now(),
    "The selected approval has expired and cannot authorize or revoke a run.",
  );
  requireCondition(
    Number.isSafeInteger(approval.revision) && Number(approval.revision) > 0,
    "Refresh the selected approval before revoking it.",
  );
  const bounded = reason.trim();
  requireCondition(
    bounded.length >= 1 && bounded.length <= 2000 && !bounded.includes("\0"),
    "Supply a revocation reason from 1 to 2000 characters.",
  );
  const result = await send<{
    id?: string;
    revoked?: boolean;
    value?: { revoked?: boolean };
  }>(
    `${base}/browser-plans/${encodeURIComponent(plan.id)}/approval-revocations`,
    { approval_id: approval.id, reason: bounded },
    "POST",
    approval.revision,
  );
  requireCondition(
    result?.id === approval.id &&
      (result.revoked === true || result.value?.revoked === true),
    "The service did not confirm revocation of the reviewed approval. Refresh before relying on its state.",
  );
  return result;
}

function planValue(plan: ExternalBrowserPlan) {
  return { ...plan.value, ...plan };
}
function label(record: { id: string; name?: string | null }, fallback: string) {
  return record.name
    ? `${record.name} · ${record.id}`
    : `${fallback} · ${record.id}`;
}
function currentPlan(
  plan: ExternalBrowserPlan | undefined,
  inventory: ExternalBrowserInventory,
) {
  return (
    !!plan &&
    plan.revision_id === inventory.revision_id &&
    plan.freshness !== "stale"
  );
}
function availableRunner(
  inventory: ExternalBrowserInventory,
  runnerId: string,
) {
  return (
    inventory.runner?.status === "available" &&
    ((!inventory.runner.runner_id && !inventory.runner.id) ||
      [inventory.runner.runner_id, inventory.runner.id].includes(runnerId)) &&
    inventory.catalog.runners.some(
      (item) => item.id === runnerId && item.status === "available",
    )
  );
}
function runTone(status: string): "neutral" | "muted" | "warning" {
  return [
    "failed",
    "blocked",
    "cancelled",
    "cancel_requested",
    "unknown",
  ].includes(status)
    ? "warning"
    : status === "queued" || status === "running"
      ? "neutral"
      : "muted";
}

const observationStatuses = [
  "observed",
  "blocked",
  "failed",
  "cancelled",
] as const;
const observationArms = ["known_good", "incident", "candidate"] as const;
const observationCohorts = ["mobile", "desktop"] as const;
const deniedRequestCodes = [
  "ORIGIN_DENIED",
  "PATH_DENIED",
  "WEBSOCKET_DENIED",
  "POPUP_DENIED",
  "DOWNLOAD_DENIED",
] as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function boundedText(value: unknown, maximum = 2000): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}
function optionalText(value: unknown, maximum = 2000): value is string | null {
  return value === null || boundedText(value, maximum);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function isoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function oneOf<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
function finiteCount(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}
function booleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function observation(value: unknown): ExternalBrowserObservation {
  requireCondition(
    record(value) &&
      oneOf(observationArms, value.arm) &&
      oneOf(observationCohorts, value.cohort) &&
      finiteCount(value.repeat, 3) &&
      Number(value.repeat) >= 1 &&
      oneOf(observationStatuses, value.status),
    "External result contains an invalid observation matrix row.",
  );
  for (const name of [
    "plan_hash",
    "oracle_hash",
    "build_digest",
    "build_digest_after",
    "deployment_evidence_hash",
    "fixture_hash",
    "environment_hash",
  ] as const)
    requireCondition(
      digest(value[name]),
      "External result contains an invalid observation binding.",
    );
  requireCondition(
    boundedText(value.runner_id, 128),
    "External result contains an invalid runner binding.",
  );
  let actual: ExternalBrowserObservation["actual"] = null;
  if (value.actual !== null) {
    requireCondition(
      record(value.actual) &&
        typeof value.actual.checkout_completed === "boolean" &&
        finiteCount(value.actual.order_created_count) &&
        optionalText(value.actual.error_code, 200),
      "External result contains invalid typed observation values.",
    );
    actual = {
      checkout_completed: value.actual.checkout_completed,
      order_created_count: value.actual.order_created_count,
      error_code: value.actual.error_code,
    };
  }
  return {
    arm: value.arm as ExternalBrowserObservation["arm"],
    cohort: value.cohort as ExternalBrowserObservation["cohort"],
    repeat: Number(value.repeat),
    status: value.status as ExternalBrowserObservation["status"],
    plan_hash: String(value.plan_hash),
    oracle_hash: String(value.oracle_hash),
    build_digest: String(value.build_digest),
    build_digest_after: String(value.build_digest_after),
    deployment_evidence_hash: String(value.deployment_evidence_hash),
    fixture_hash: String(value.fixture_hash),
    environment_hash: String(value.environment_hash),
    runner_id: String(value.runner_id),
    actual,
  };
}

function attempt(value: unknown): ExternalBrowserAttempt {
  requireCondition(
    record(value) &&
      typeof value.attempt_id === "string" &&
      /^[A-Za-z0-9_-]{16,128}$/.test(value.attempt_id) &&
      oneOf(observationArms, value.arm) &&
      oneOf(observationCohorts, value.cohort) &&
      finiteCount(value.repeat, 3) &&
      Number(value.repeat) >= 1 &&
      oneOf(observationStatuses, value.status) &&
      isoInstant(value.started_at) &&
      isoInstant(value.finished_at) &&
      Date.parse(value.finished_at) >= Date.parse(value.started_at),
    "External result contains invalid attempt identity or timing.",
  );
  requireCondition(
    digest(value.observation_hash) &&
      booleanOrNull(value.ui_completed) &&
      booleanOrNull(value.receipt_completed) &&
      finiteCount(value.network_request_count, 100_000),
    "External result contains invalid bounded attempt evidence.",
  );
  requireCondition(
    Array.isArray(value.errors) &&
      value.errors.length <= 30 &&
      value.errors.every(
        (item) =>
          typeof item === "string" &&
          /^(?:[A-Z][A-Z0-9_]{0,127}|BROWSER_(?:TIMEOUT|EXECUTION_FAILED):(?:context|navigate|click|fill|wait_for|receipt))$/.test(
            item,
          ),
      ),
    "External result contains invalid attempt error codes.",
  );
  requireCondition(
    Array.isArray(value.denied_requests) &&
      value.denied_requests.length <= 30 &&
      value.denied_requests.every(
        (item) =>
          record(item) &&
          oneOf(deniedRequestCodes, item.code) &&
          item.origin === null &&
          item.path === null,
      ),
    "External result contains invalid denied-request evidence.",
  );
  requireCondition(
    record(value.deployment) &&
      value.deployment.arm === value.arm &&
      boundedText(value.deployment.deployment_id, 128) &&
      boundedText(value.deployment.attester_id, 128) &&
      boundedText(value.deployment.origin, 1000) &&
      digest(value.deployment.build_digest) &&
      digest(value.deployment.deployment_evidence_hash),
    "External result contains invalid deployment evidence.",
  );
  const deployment = value.deployment as Record<string, unknown>;
  return {
    attempt_id: String(value.attempt_id),
    arm: value.arm as ExternalBrowserAttempt["arm"],
    cohort: value.cohort as ExternalBrowserAttempt["cohort"],
    repeat: Number(value.repeat),
    status: value.status as ExternalBrowserAttempt["status"],
    started_at: String(value.started_at),
    finished_at: String(value.finished_at),
    observation_hash: String(value.observation_hash),
    ui_completed: value.ui_completed as boolean | null,
    receipt_completed: value.receipt_completed as boolean | null,
    network_request_count: Number(value.network_request_count),
    denied_requests: value.denied_requests.map((item) => ({
      code: (item as Record<string, unknown>)
        .code as ExternalBrowserAttempt["denied_requests"][number]["code"],
      origin: null,
      path: null,
    })),
    errors: value.errors.map(String),
    deployment: {
      arm: deployment.arm as ExternalBrowserAttempt["arm"],
      deployment_id: String(deployment.deployment_id),
      attester_id: String(deployment.attester_id),
      origin: String(deployment.origin),
      build_digest: String(deployment.build_digest),
      deployment_evidence_hash: String(deployment.deployment_evidence_hash),
    },
  };
}

/** Admit only the documented safe external-result projection before rendering it. */
export function externalResultDetail(
  value: unknown,
  resultId: string,
): ExternalBrowserResultDetail {
  requireCondition(
    record(value) &&
      value.id === resultId &&
      boundedText(value.run_id, 128) &&
      boundedText(value.plan_id, 128) &&
      value.production_claim_eligible === false &&
      (value.freshness === "fresh" || value.freshness === "stale") &&
      boundedText(value.verification_limit_reason, 200),
    "The external result evidence response was incomplete. No outcome is inferred.",
  );
  requireCondition(
    Array.isArray(value.observations) &&
      (value.observations.length === 12 || value.observations.length === 18) &&
      Array.isArray(value.attempts) &&
      value.attempts.length === value.observations.length &&
      Array.isArray(value.artifacts) &&
      value.artifacts.length === 0,
    "The external result evidence matrix was incomplete or unbounded. No outcome is inferred.",
  );
  const observations = value.observations.map(observation),
    attempts = value.attempts.map(attempt);
  const keys = new Set(
      observations.map((item) => `${item.arm}:${item.cohort}:${item.repeat}`),
    ),
    attemptKeys = new Set(
      attempts.map((item) => `${item.arm}:${item.cohort}:${item.repeat}`),
    ),
    attemptIds = new Set(attempts.map((item) => item.attempt_id));
  requireCondition(
    keys.size === observations.length &&
      attemptKeys.size === attempts.length &&
      attemptIds.size === attempts.length &&
      attempts.every((item) =>
        keys.has(`${item.arm}:${item.cohort}:${item.repeat}`),
      ),
    "The external result attempt matrix does not match its observations. No outcome is inferred.",
  );
  const text = (name: string, maximum = 2000) =>
    boundedText(value[name], maximum) ? value[name] : undefined;
  const nullableText = (name: string, maximum = 2000) =>
    optionalText(value[name], maximum) ? value[name] : undefined;
  return {
    id: resultId,
    run_id: String(value.run_id),
    plan_id: String(value.plan_id),
    status: text("status", 100),
    outcome: text("outcome", 100),
    mode: text("mode", 100),
    freshness: value.freshness,
    reason_code: nullableText("reason_code", 200),
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((item) => boundedText(item, 200)).slice(0, 30)
      : undefined,
    verification_limit_reason: value.verification_limit_reason,
    observed_runs: finiteCount(value.observed_runs, 18)
      ? value.observed_runs
      : observations.length,
    result_hash: digest(value.result_hash) ? value.result_hash : undefined,
    created_at: isoInstant(value.created_at) ? value.created_at : undefined,
    production_claim_eligible: false,
    observations,
    attempts,
    artifacts: [],
  };
}

function stateLabel(value: boolean | null) {
  return value === null ? "Unknown" : value ? "Yes" : "No";
}
function resultLimit(value: string | null | undefined) {
  return value === INDEPENDENT_OBSERVATION_REQUIRED
    ? "The deployment has not been independently confirmed."
    : value
      ? value.replaceAll("_", " ").toLowerCase()
      : "Independent deployment confirmation is still required.";
}
export function ExternalResultInspection({
  result,
}: {
  result: ExternalBrowserResultDetail;
}) {
  const byAttempt = new Map(
    result.attempts.map((item) => [
      `${item.arm}:${item.cohort}:${item.repeat}`,
      item,
    ]),
  );
  return (
    <section aria-label={`External result evidence ${result.id}`}>
      <div className="section-heading">
        <h4>Test results</h4>
        <Status tone="warning">{result.freshness}</Status>
      </div>
      <p className="notice warning">Exploratory only. {resultLimit(result.verification_limit_reason)}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Device</th>
              <th>Run</th>
              <th>Status</th>
              <th>Page</th>
              <th>Receipt</th>
              <th>Checkout</th>
              <th>Orders</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {result.observations.map((item) => {
              const evidence = byAttempt.get(
                `${item.arm}:${item.cohort}:${item.repeat}`,
              );
              return (
                <tr key={`${item.arm}:${item.cohort}:${item.repeat}`}>
                  <td>{item.arm.replaceAll("_", " ")}</td>
                  <td>{item.cohort}</td>
                  <td>{item.repeat}</td>
                  <td>
                    <Status
                      tone={item.status === "observed" ? "muted" : "warning"}
                    >
                      {item.status}
                    </Status>
                  </td>
                  <td>{stateLabel(evidence?.ui_completed ?? null)}</td>
                  <td>{stateLabel(evidence?.receipt_completed ?? null)}</td>
                  <td>{stateLabel(item.actual?.checkout_completed ?? null)}</td>
                  <td>{item.actual?.order_created_count ?? "Unknown"}</td>
                  <td>{item.actual?.error_code ?? "None"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Run details</summary>
        <div className="record-list">
          {result.attempts.map((item) => (
            <article key={item.attempt_id}>
              <div className="section-heading">
                <h5>
                  {item.arm.replaceAll("_", " ")} · {item.cohort} · run{" "}
                  {item.repeat}
                </h5>
                <Status tone={item.status === "observed" ? "muted" : "warning"}>
                  {item.status}
                </Status>
              </div>
              <dl className="diagnostic-values">
                <div>
                  <dt>Attempt</dt>
                  <dd>{item.attempt_id}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{item.started_at}</dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>{item.finished_at}</dd>
                </div>
                <div>
                  <dt>Network requests</dt>
                  <dd>{item.network_request_count}</dd>
                </div>
                <div>
                  <dt>Page completed</dt>
                  <dd>{stateLabel(item.ui_completed)}</dd>
                </div>
                <div>
                  <dt>Receipt completed</dt>
                  <dd>{stateLabel(item.receipt_completed)}</dd>
                </div>
                <div>
                  <dt>Deployment</dt>
                  <dd>{item.deployment.deployment_id}</dd>
                </div>
                <div>
                  <dt>Origin</dt>
                  <dd>{item.deployment.origin}</dd>
                </div>
              </dl>
              {item.denied_requests.length > 0 && (
                <div className="notice warning">
                  <strong>Denied requests</strong>
                  <ul>
                    {item.denied_requests.map((entry, index) => (
                      <li key={`${entry.code}:${index}`}>{entry.code}</li>
                    ))}
                  </ul>
                </div>
              )}
              {item.errors.length > 0 && (
                <p className="notice warning">
                  Errors: {item.errors.join(", ")}
                </p>
              )}
              <details>
                <summary>Evidence bindings</summary>
                <p className="hash-line">
                  Observation {item.observation_hash}
                  <br />
                  Build {item.deployment.build_digest}
                  <br />
                  Deployment evidence {item.deployment.deployment_evidence_hash}
                </p>
              </details>
            </article>
          ))}
        </div>
        <details>
          <summary>Observation data</summary>
          <pre>{JSON.stringify(result.observations, null, 2)}</pre>
        </details>
      </details>
    </section>
  );
}

function ExternalRunRecord({
  run,
  result,
  base,
}: {
  run: ExternalBrowserRun;
  result?: ExternalBrowserResult;
  base?: string;
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<ExternalBrowserResultDetail | null>(null),
    [detailError, setDetailError] = useState<Error | null>(null),
    [reading, setReading] = useState(false);
  const reason =
    result?.verification_limit_reason ??
    result?.reason_code ??
    (result?.reasons?.includes(INDEPENDENT_OBSERVATION_REQUIRED)
      ? INDEPENDENT_OBSERVATION_REQUIRED
      : null);
  async function inspect() {
    if (!result || !base) return;
    if (open) {
      setOpen(false);
      return;
    }
    if (detail) {
      setOpen(true);
      return;
    }
    setReading(true);
    setDetailError(null);
    try {
      const value = await resource<unknown>(
        `${base}/test-results/${encodeURIComponent(result.id)}`,
      );
      setDetail(externalResultDetail(value, result.id));
      setOpen(true);
    } catch (cause) {
      setDetailError(formError(cause));
    } finally {
      setReading(false);
    }
  }
  return (
    <article>
      <div className="section-heading">
        <h3>Browser test</h3>
        <Status tone={runTone(run.status)}>
          {run.status.replaceAll("_", " ")}
        </Status>
      </div>
      <p>
        Plan {run.plan_id} · Approval {run.approval_id}
      </p>
      {run.job_id && <p>Queued job {run.job_id}</p>}
      {run.execution_id && <p>Runner execution {run.execution_id}</p>}
      {run.error_code && <p className="notice warning">{run.error_code}</p>}
      {result ? (
        <>
          <p>
            <strong>Result:</strong>{" "}
            {result.outcome ?? result.status ?? "unknown"} ·{" "}
            {result.mode ?? "exploratory"}
          </p>
          <Status tone="warning">Exploratory evidence only</Status>
        <p className="notice warning">{resultLimit(reason)} This run does not prove the cause or confirm a fix.</p>
        {reason && <details><summary>Result limit details</summary><p>{reason}</p></details>}
          {result.result_hash && (
            <p className="hash-line">Result hash {result.result_hash}</p>
          )}
          {base && (
            <button
              type="button"
              className="secondary"
              disabled={reading}
              aria-expanded={open}
              onClick={() => void inspect()}
            >
              {reading
                ? "Loading results…"
                : open
                  ? "Close results"
                  : "View results"}
            </button>
          )}
          <ErrorNotice error={detailError} />
          {open && detail && <ExternalResultInspection result={detail} />}
        </>
      ) : (
        <p className="notice warning">
          No external result is recorded. Accepted or completed work is not a
          passing verification result.
        </p>
      )}
    </article>
  );
}

export function ExternalRunHistory({
  runs,
  results,
  base,
}: {
  runs: ExternalBrowserRun[];
  results: ExternalBrowserResult[];
  base?: string;
}) {
  if (!runs.length && !results.length)
    return (
      <Empty title="No browser tests yet">
        No external browser test has run for this investigation.
      </Empty>
    );
  return (
    <div className="record-list">
      {runs.map((run) => (
        <ExternalRunRecord
          key={run.id}
          run={run}
          result={results.find((item) => item.run_id === run.id)}
          base={base}
        />
      ))}
      {results
        .filter((result) => !runs.some((run) => run.id === result.run_id))
        .map((result) => (
          <article key={result.id}>
            <h3>Unlinked recorded result {result.id}</h3>
            <p className="notice warning">
              Its run binding is unavailable. Outcome remains unknown; no
              passing claim is inferred.
            </p>
          </article>
        ))}
    </div>
  );
}

function newAction(op: ExternalBrowserAction["op"]): ExternalBrowserAction {
  if (op === "navigate") return { op, path: "/" };
  if (op === "fill")
    return { op, locator: { kind: "label", value: "" }, value_ref: "" };
  if (op === "wait_for")
    return { op, locator: { kind: "label", value: "" }, timeout_ms: 5000 };
  return { op, locator: { kind: "label", value: "" } };
}

function ActionLocator({
  action,
  onChange,
}: {
  action: Exclude<ExternalBrowserAction, { op: "navigate" }>;
  onChange: (next: ExternalBrowserAction) => void;
}) {
  const setLocator = (change: Partial<typeof action.locator>) =>
    onChange({
      ...action,
      locator: { ...action.locator, ...change },
    } as ExternalBrowserAction);
  return (
    <div className="browser-step-fields">
      <Field label="Find by">
        <select
          value={action.locator.kind}
          onChange={(event) => {
            const kind = event.target.value as typeof action.locator.kind;
            setLocator({
              kind,
              ...(kind === "role"
                ? { role: action.locator.role ?? "button" }
                : { role: undefined }),
            });
          }}
        >
          <option value="label">Label</option>
          <option value="test_id">Test ID</option>
          <option value="role">Role</option>
        </select>
      </Field>
      {action.locator.kind === "role" && (
        <Field label="Element">
          <select
            value={action.locator.role ?? "button"}
            onChange={(event) =>
              setLocator({
                role: event.target.value as (typeof locatorRoles)[number],
              })
            }
          >
            {locatorRoles.map((role) => (
              <option value={role} key={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label={action.locator.kind === "test_id" ? "Test ID" : "Visible name"}
      >
        <input
          value={action.locator.value}
          maxLength={200}
          required
          onChange={(event) => setLocator({ value: event.target.value })}
        />
      </Field>
      {action.op === "fill" && (
        <Field label="Test data field">
          <input
            value={action.value_ref}
            maxLength={128}
            required
            onChange={(event) =>
              onChange({ ...action, value_ref: event.target.value })
            }
          />
        </Field>
      )}
      {action.op === "wait_for" && (
        <Field label="Wait up to (ms)">
          <input
            type="number"
            min={1}
            max={10000}
            value={action.timeout_ms}
            required
            onChange={(event) =>
              onChange({ ...action, timeout_ms: Number(event.target.value) })
            }
          />
        </Field>
      )}
    </div>
  );
}

export function BrowserActionEditor({
  actions,
  onChange,
}: {
  actions: ExternalBrowserAction[];
  onChange: (actions: ExternalBrowserAction[]) => void;
}) {
  function replace(index: number, action: ExternalBrowserAction) {
    onChange(
      actions.map((item, itemIndex) => (itemIndex === index ? action : item)),
    );
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 1 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }
  return (
    <fieldset className="browser-steps">
      <legend>Browser steps</legend>
      <input type="hidden" name="actions" value={JSON.stringify(actions)} />
      {actions.map((action, index) => (
        <section className="browser-step" key={index}>
          <div className="section-heading">
            <strong>Step {index + 1}</strong>
            <div className="button-row">
              {index > 1 && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move step ${index + 1} up`}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
              )}
              {index > 0 && index < actions.length - 1 && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Move step ${index + 1} down`}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              )}
              {index > 0 && (
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() =>
                    onChange(
                      actions.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <Field label="Action">
            <select
              value={action.op}
              disabled={index === 0}
              onChange={(event) =>
                replace(
                  index,
                  newAction(event.target.value as ExternalBrowserAction["op"]),
                )
              }
            >
              <option value="navigate">Open page</option>
              <option value="click">Click</option>
              <option value="fill">Enter test data</option>
              <option value="wait_for">Wait for element</option>
            </select>
          </Field>
          {action.op === "navigate" ? (
            <Field label="Page path">
              <input
                value={action.path}
                required
                maxLength={1000}
                placeholder="/checkout"
                onChange={(event) =>
                  replace(index, { ...action, path: event.target.value })
                }
              />
            </Field>
          ) : (
            <ActionLocator
              action={action}
              onChange={(next) => replace(index, next)}
            />
          )}
        </section>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={actions.length >= 30}
        onClick={() => onChange([...actions, newAction("click")])}
      >
        Add step
      </button>
      <p className="fine-print">
        The first step opens a page on the approved site. Test data comes from
        the selected test-data profile.
      </p>
    </fieldset>
  );
}

export function ExternalPlanReview({ plan }: { plan: ExternalBrowserPlan }) {
  return (
    <details>
      <summary>Plan details</summary>
      <pre>{JSON.stringify(planValue(plan), null, 2)}</pre>
      <p className="hash-line">Plan hash {plan.plan_hash}</p>
    </details>
  );
}
export function ExternalRunButton({
  disabled,
  pending,
  onRun,
}: {
  disabled: boolean;
  pending: string;
  onRun: () => void;
}) {
  return (
    <button className="primary" disabled={disabled} onClick={onRun}>
      {pending || "Run approved browser test"}
    </button>
  );
}
export function ExternalApprovalRevocation({
  approval,
  current,
  reviewing,
  reason,
  acknowledged,
  pending,
  onBegin,
  onCancel,
  onReason,
  onAcknowledged,
  onSubmit,
}: {
  approval: ExternalBrowserApproval;
  current: boolean;
  reviewing: boolean;
  reason: string;
  acknowledged: boolean;
  pending: string;
  onBegin: () => void;
  onCancel: () => void;
  onReason: (value: string) => void;
  onAcknowledged: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (approval.revoked)
    return (
      <p className="notice warning">
        This exact-plan approval is revoked and cannot authorize a run.
      </p>
    );
  if (Date.parse(approval.expires_at) <= Date.now())
    return (
      <p className="notice warning">
        This exact-plan approval expired and cannot authorize a run.
      </p>
    );
  if (!reviewing)
    return (
      <button
        type="button"
        className="secondary"
        disabled={!current || !!pending}
        onClick={onBegin}
      >
        Revoke approval
      </button>
    );
  return (
    <form
      onSubmit={onSubmit}
      className="notice warning"
      aria-label="Review external approval revocation"
    >
      <h4>Withdraw this exact approval</h4>
      <p>
        Approval {approval.id} · Revision {approval.revision ?? "unknown"} ·
        Expires {approval.expires_at}
      </p>
      <details>
        <summary>Approval details</summary>
        <p className="hash-line">Plan hash {approval.plan_hash}</p>
      </details>
      <Field label="Reason">
        <textarea
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          required
          minLength={1}
          maxLength={2000}
          rows={4}
          disabled={!!pending}
        />
      </Field>
      <label className="review-checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledged(event.target.checked)}
          required
          disabled={!!pending}
        />
        I reviewed this exact approval and intend to withdraw its authority for
        future external runs.
      </label>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={!!pending}
          onClick={onCancel}
        >
          Keep approval
        </button>
        <button
          className="primary"
          disabled={
            !current ||
            !acknowledged ||
            !reason.trim() ||
            reason.trim().length > 2000 ||
            !!pending
          }
        >
          {pending || "Revoke approval"}
        </button>
      </div>
    </form>
  );
}

export function ExternalVerificationPanel({
  base,
  workspace,
  csrf,
  investigation,
  hypotheses,
  evidence,
  refreshToken,
  onChanged,
  onJob,
}: {
  base: string;
  workspace: Workspace;
  csrf: string;
  investigation: Investigation;
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  refreshToken: number;
  onChanged: () => Promise<void>;
  onJob?: (value: { job_id: string; status: string }) => void;
}) {
  const send = useCommand(csrf),
    [inventory, setInventory] = useState<ExternalBrowserInventory | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<Error | null>(null),
    [pending, setPending] = useState(""),
    [reload, setReload] = useState(0);
  const [planId, setPlanId] = useState(""),
    [approvalId, setApprovalId] = useState(""),
    [objective, setObjective] =
      useState<ExternalBrowserPlanInput["objective"]>("mechanism"),
    [actions, setActions] = useState<ExternalBrowserAction[]>(() =>
      structuredClone(defaultExternalActions),
    );
  const [approvalExpiry, setApprovalExpiry] = useState(() =>
      localDateTimeInputValue(new Date(Date.now() + 30 * 60_000)),
    ),
    [reviewed, setReviewed] = useState("");
  const [revokeApprovalId, setRevokeApprovalId] = useState(""),
    [revokeReason, setRevokeReason] = useState(""),
    [revokeAcknowledged, setRevokeAcknowledged] = useState(false);
  const writable =
    workspace.role !== "viewer" &&
    investigation.lifecycle === "open" &&
    !investigation.archived;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const value = await resource<ExternalBrowserInventory>(
          `${base}/external-browser`,
          { signal },
        );
        requireCondition(
          value &&
            Number.isSafeInteger(value.case_revision) &&
            typeof value.revision_id === "string" &&
            ["plans", "approvals", "runs", "results"].every((name) =>
              Array.isArray(value[name as keyof ExternalBrowserInventory]),
            ) &&
            value.catalog &&
            [
              "runners",
              "environments",
              "grants",
              "fixtures",
              "observations",
              "builds",
            ].every((name) =>
              Array.isArray(
                value.catalog[
                  name as keyof ExternalBrowserInventory["catalog"]
                ],
              ),
            ),
          "The external browser inventory was incomplete. Its current status is unknown.",
        );
        if (!signal?.aborted) setInventory(value);
      } catch (cause) {
        if (!signal?.aborted) {
          setInventory(null);
          setError(formError(cause));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reload, refreshToken]);
  useEffect(() => {
    if (!inventory) return;
    if (!inventory.plans.some((item) => item.id === planId))
      setPlanId(
        inventory.plans.find((item) => currentPlan(item, inventory))?.id ??
          inventory.plans[0]?.id ??
          "",
      );
  }, [inventory, planId]);
  const plan = inventory?.plans.find((item) => item.id === planId),
    approvals =
      inventory?.approvals.filter((item) => item.plan_id === planId) ?? [],
    approval = approvals.find((item) => item.id === approvalId),
    value = plan ? planValue(plan) : null;
  const runnerReady =
      !!inventory &&
      !!value?.runner_id &&
      availableRunner(inventory, String(value.runner_id)),
    planReady = !!inventory && currentPlan(plan, inventory),
    approvalReady =
      !!plan &&
      !!approval &&
      approval.plan_hash === plan.plan_hash &&
      !approval.revoked &&
      Date.parse(approval.expires_at) > Date.now();
  const reviewBinding = plan
    ? `${plan.id}:${plan.plan_hash}:${inventory?.case_revision}:${approvalExpiry}`
    : "";
  useEffect(() => setReviewed(""), [reviewBinding]);
  async function command(labelText: string, action: () => Promise<void>) {
    setPending(labelText);
    setError(null);
    try {
      await action();
      setReload((value) => value + 1);
      await onChanged();
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = externalPlanInput(new FormData(event.currentTarget), evidence);
    await command("Saving test plan…", async () => {
      const created = await send<{ id: string }>(
        `${base}/browser-plans`,
        { external_request: body },
        "POST",
        inventory?.case_revision,
      );
      requireCondition(created?.id, "The service did not return a test plan.");
      setPlanId(created.id);
      setApprovalId("");
    });
  }
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan) return;
    await command("Recording exact plan approval…", async () => {
      requireCondition(
        reviewed === reviewBinding,
        "Review and acknowledge this exact immutable plan and current case revision.",
      );
      const created = await send<{ id: string }>(
        `${base}/browser-plans/${encodeURIComponent(plan.id)}/approvals`,
        externalApprovalInput(
          plan,
          String(value?.grant_id ?? ""),
          approvalExpiry,
        ),
        "POST",
        inventory?.case_revision,
      );
      requireCondition(
        created?.id,
        "The service did not return an approval identity.",
      );
      setApprovalId(created.id);
    });
  }
  async function run() {
    if (!plan || !approval) return;
    await command("Queuing approved external run…", async () => {
      requireCondition(
        runnerReady && planReady,
        "The bound hardened runner and plan must be current and available.",
      );
      const created = await send<{
        id?: string;
        run_id?: string;
        job_id?: string;
        status?: string;
      }>(
        `${base}/browser-plans/${encodeURIComponent(plan.id)}/runs`,
        externalRunInput(plan, approval),
        "POST",
        inventory?.case_revision,
      );
      requireCondition(
        created?.id || created?.run_id || created?.job_id,
        "The service did not return a persisted run or job identity.",
      );
      if (created.job_id)
        onJob?.({ job_id: created.job_id, status: created.status ?? "queued" });
    });
  }
  async function revokeApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || !approval) return;
    await command("Recording exact approval revocation…", async () => {
      requireCondition(
        revokeApprovalId === approval.id && revokeAcknowledged,
        "Review and acknowledge this exact approval revocation.",
      );
      await revokeExternalApproval(send, base, plan, approval, revokeReason);
      setRevokeApprovalId("");
      setRevokeReason("");
      setRevokeAcknowledged(false);
    });
  }
  if (workspace.role === "viewer")
    return (
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Browser tests</p>
            <h2>Browser test history</h2>
          </div>
          <Status tone="muted">Read only</Status>
        </div>
        <p>
          You can view saved browser tests and their limits. You cannot create,
          approve, or run tests.
        </p>
        <ErrorNotice error={error} />
        {loading ? (
          <Loading label="Loading browser tests…" />
        ) : inventory ? (
          <ExternalRunHistory
            runs={inventory.runs}
            results={inventory.results}
            base={base}
          />
        ) : (
          <p className="notice warning">
            External browser state is unknown. No passing outcome is inferred.
          </p>
        )}
      </section>
    );
  return (
    <section className="panel external-verification-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Automated browser</p>
          <h2>Browser tests</h2>
        </div>
        <Status
          tone={inventory?.runner?.status === "available" ? "muted" : "warning"}
        >
          {inventory?.runner?.status ?? "unknown"}
        </Status>
      </div>
      <p>Test a staging flow in an isolated browser. Approve each plan before it runs.</p>
      <ErrorNotice error={error} />
      {loading && !inventory ? (
        <Loading label="Loading browser test setup…" />
      ) : inventory ? (
        <>
          <div
            className={
              inventory.runner?.status === "available"
                ? "notice"
                : "notice warning"
            }
          >
            <strong>
              Browser runner {inventory.runner?.status ?? "unknown"}
            </strong>
            <p>
              {inventory.runner?.reason_code ??
                (inventory.runner?.status === "available"
                  ? "Ready for an approved test."
                  : "The runner is unavailable, so tests cannot run.")}
            </p>
            <details><summary>Runner details</summary><p className="fine-print">Input revision {inventory.revision_id} · Investigation revision {inventory.case_revision}</p></details>
          </div>
          <button
            className="secondary"
            disabled={loading || !!pending}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh
          </button>
          {writable ? (
            <details
              className="browser-plan-composer"
              open={inventory.runner?.status === "available"}
            >
              <summary>
                {inventory.runner?.status === "available"
                  ? "Create test plan"
                  : "Prepare a test plan"}
              </summary>
              <form onSubmit={createPlan}>
              <Field label="Possible reason">
                <select name="hypothesis_id" required>
                  <option value="">Choose a possible reason</option>
                  {hypotheses
                    .filter(
                      (item) => item.revision_id === inventory.revision_id,
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Goal">
                <select
                  name="objective"
                  value={objective}
                  onChange={(event) =>
                    setObjective(
                      event.target
                        .value as ExternalBrowserPlanInput["objective"],
                    )
                  }
                >
                  <option value="mechanism">Reproduce the issue</option>
                  <option value="correction">Check a correction</option>
                </select>
              </Field>
              <CatalogSelect
                name="runner_id"
                label="Browser runner"
                records={inventory.catalog.runners.filter(
                  (item) => item.status === "available",
                )}
                empty="No available runner"
              />
              <CatalogSelect
                name="environment_id"
                label="Browser setup"
                records={inventory.catalog.environments.filter(
                  (item) => !item.revoked,
                )}
                empty="No current environment"
              />
              <CatalogSelect
                name="fixture_profile_id"
                label="Test data"
                records={inventory.catalog.fixtures.filter(
                  (item) => item.freshness !== "stale",
                )}
                empty="No current test data"
              />
              <CatalogSelect
                name="observation_profile_id"
                label="Success check"
                records={inventory.catalog.observations.filter(
                  (item) => item.freshness !== "stale",
                )}
                empty="No current success check"
              />
              <CatalogSelect
                name="grant_id"
                label="Approved site"
                records={inventory.catalog.grants.filter(
                  (item) => !item.revoked && item.freshness !== "stale",
                )}
                empty="No current target grant"
              />
              <CatalogSelect
                name="known_good_build_id"
                label="Working version"
                records={inventory.catalog.builds.filter(
                  (item) => item.freshness !== "stale",
                )}
                empty="No current build"
              />
              <CatalogSelect
                name="incident_build_id"
                label="Problem version"
                records={inventory.catalog.builds.filter(
                  (item) => item.freshness !== "stale",
                )}
                empty="No current build"
              />
              {objective === "correction" && (
                <CatalogSelect
                  name="candidate_build_id"
                  label="Candidate version"
                  records={inventory.catalog.builds.filter(
                    (item) => item.freshness !== "stale",
                  )}
                  empty="No current candidate build"
                />
              )}
              <BrowserActionEditor actions={actions} onChange={setActions} />
              <EvidencePicker
                evidence={evidence}
                name="external_evidence"
                label="Evidence for this plan"
              />
              <button
                className="primary"
                disabled={!!pending || inventory.runner?.status !== "available"}
              >
                {pending || "Save test plan"}
              </button>
              {inventory.runner?.status !== "available" && (
                <p className="notice warning">
                  The browser runner is unavailable. Save the setup after it is restored.
                </p>
              )}
              </form>
            </details>
          ) : (
            <p className="notice warning">
              Reopen this investigation before creating a browser test.
            </p>
          )}
          {inventory.plans.length > 0 && <section>
            <div className="section-heading">
              <h3>Review test plan</h3>
              <Status tone={planReady ? "muted" : "warning"}>
                {plan
                  ? planReady
                    ? "Current plan"
                    : "Stale plan"
                  : "No plan selected"}
              </Status>
            </div>
            <Field label="Saved test plan">
              <select
                value={planId}
                onChange={(event) => {
                  setPlanId(event.target.value);
                  setApprovalId("");
                  setRevokeApprovalId("");
                  setRevokeReason("");
                  setRevokeAcknowledged(false);
                }}
              >
                <option value="">Choose a plan</option>
                {inventory.plans.map((item) => (
                  <option key={item.id} value={item.id}>
                    {planValue(item).objective ?? "unknown"} ·{" "}
                    {item.freshness ?? "unknown"} · {item.id}
                  </option>
                ))}
              </select>
            </Field>
            {plan && (
              <>
                <ExternalPlanReview plan={plan} />
                {writable && (
                  <form onSubmit={approve}>
                    <Field label="Approval ends">
                      <input
                        type="datetime-local"
                        step="1"
                        value={approvalExpiry}
                        onChange={(event) =>
                          setApprovalExpiry(event.target.value)
                        }
                        required
                      />
                    </Field>
                    <label className="review-checkbox">
                      <input
                        type="checkbox"
                        checked={reviewed === reviewBinding}
                        onChange={(event) =>
                          setReviewed(event.target.checked ? reviewBinding : "")
                        }
                        required
                        disabled={!planReady || !!pending}
                      />
                      I reviewed this plan, approved site, versions, steps, and
                      current investigation. I approve this plan only. A queued
                      run is not a passing result.
                    </label>
                    <button
                      className="secondary"
                      disabled={
                        !planReady || reviewed !== reviewBinding || !!pending
                      }
                    >
                      {pending || `Approve this plan`}
                    </button>
                  </form>
                )}
                <Field label="Approval">
                  <select
                    value={approvalId}
                    onChange={(event) => {
                      setApprovalId(event.target.value);
                      setRevokeApprovalId("");
                      setRevokeReason("");
                      setRevokeAcknowledged(false);
                    }}
                  >
                    <option value="">Choose an approval</option>
                    {approvals.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} ·{" "}
                        {item.revoked
                          ? "revoked"
                          : Date.parse(item.expires_at) <= Date.now()
                            ? "expired"
                            : "current"}{" "}
                        · expires {item.expires_at}
                      </option>
                    ))}
                  </select>
                </Field>
                {approval && (
                  <>
                    <details>
                      <summary>Approval details</summary>
                      <p className="hash-line">
                        Plan hash {approval.plan_hash}
                      </p>
                    </details>
                    <ExternalRunButton
                      disabled={
                        !!pending ||
                        !runnerReady ||
                        !planReady ||
                        !approvalReady
                      }
                      pending={pending}
                      onRun={() => void run()}
                    />
                    {!runnerReady && (
                      <p className="notice warning">
                        The browser runner is unavailable. This test is blocked.
                      </p>
                    )}
                    {!approvalReady && (
                      <p className="notice warning">
                        Choose a current approval for this plan.
                      </p>
                    )}
                    <ExternalApprovalRevocation
                      approval={approval}
                      current={
                        approvalReady &&
                        Number.isSafeInteger(approval.revision) &&
                        Number(approval.revision) > 0
                      }
                      reviewing={revokeApprovalId === approval.id}
                      reason={revokeReason}
                      acknowledged={revokeAcknowledged}
                      pending={pending}
                      onBegin={() => {
                        setRevokeApprovalId(approval.id);
                        setRevokeReason("");
                        setRevokeAcknowledged(false);
                      }}
                      onCancel={() => {
                        setRevokeApprovalId("");
                        setRevokeReason("");
                        setRevokeAcknowledged(false);
                      }}
                      onReason={setRevokeReason}
                      onAcknowledged={setRevokeAcknowledged}
                      onSubmit={(event) => void revokeApproval(event)}
                    />
                  </>
                )}
              </>
            )}
          </section>}
          <section>
            <div className="section-heading">
              <h3>Test history</h3>
              <Status tone="warning">Exploratory only</Status>
            </div>
            <ExternalRunHistory
              runs={inventory.runs}
              results={inventory.results}
              base={base}
            />
          </section>
        </>
      ) : (
        <p className="notice warning">
          External browser state is unknown. Resolve the read failure and
          refresh; no plan or outcome is inferred.
        </p>
      )}
    </section>
  );
}

function CatalogSelect({
  name,
  label: fieldLabel,
  records,
  empty,
}: {
  name: string;
  label: string;
  records: { id: string; name?: string | null }[];
  empty: string;
}) {
  return (
    <Field label={fieldLabel}>
      <select name={name} required defaultValue="">
        <option value="">{empty}</option>
        {records.map((record) => (
          <option key={record.id} value={record.id}>
            {label(record, fieldLabel)}
          </option>
        ))}
      </select>
    </Field>
  );
}
