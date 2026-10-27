import { workspacePath } from "../../api";
import { commandKey, type CommandIdentity } from "../../command-key";

export type CaseDraftFields = {
  title: string;
  question: string;
  affected_flow: string;
};
export type CaseDraft = CaseDraftFields & { command: CommandIdentity };
export type DraftStorageStatus = "available" | "unavailable" | "disabled";

const prefix = "faultline.case-draft:v1:";
const emptyDraft = (): CaseDraft => ({
  title: "", question: "", affected_flow: "", command: null,
});
const limits = { title: 200, question: 2000, affected_flow: 2000 } as const;
const fieldNames = Object.keys(limits) as (keyof CaseDraftFields)[];

function scopePrefix(userId: string): string | null {
  if (!userId || userId.length > 200) return null;
  try { return `${prefix}${encodeURIComponent(userId)}:`; }
  catch { return null; }
}

function draftKey(userId: string, workspaceId: string): string | null {
  const userPrefix = scopePrefix(userId);
  if (!userPrefix || !workspaceId || workspaceId.length > 200) return null;
  try { return `${userPrefix}${encodeURIComponent(workspaceId)}`; }
  catch { return null; }
}

function storage(): Storage | null {
  try { return globalThis.sessionStorage ?? null; }
  catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validFields(value: unknown): value is Record<string, unknown> & CaseDraftFields {
  return record(value) && fieldNames.every((name) =>
    typeof value[name] === "string" && value[name].length <= limits[name],
  );
}

function bodyFromDraft(fields: CaseDraftFields): CaseDraftFields {
  return {
    title: fields.title.trim(),
    question: fields.question.trim(),
    affected_flow: fields.affected_flow.trim(),
  };
}

// A stored identity may describe an earlier submission before the fields were edited.
// Validate its own bounded intent; commandKey will rotate it if the next intent differs.
function validCommand(value: unknown, workspaceId: string): value is CommandIdentity {
  if (value === null) return true;
  if (!record(value) || !exactKeys(value, ["bodyCanonical", "key"]) ||
      typeof value.key !== "string" || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.key) ||
      typeof value.bodyCanonical !== "string" || value.bodyCanonical.length > 30000) return false;
  try {
    const intent: unknown = JSON.parse(value.bodyCanonical);
    if (!record(intent) || !exactKeys(intent, ["body", "method", "path"]) ||
        intent.method !== "POST" || intent.path !== `${workspacePath(workspaceId)}/cases` ||
        !validFields(intent.body) || !exactKeys(intent.body, fieldNames)) return false;
    const body = intent.body;
    if (fieldNames.some((name) => body[name] !== body[name].trim())) return false;
    // The existing command key canonicalizer sorts keys at each object level.
    return value.bodyCanonical === JSON.stringify({
      body: { affected_flow: intent.body.affected_flow, question: intent.body.question, title: intent.body.title },
      method: "POST", path: intent.path,
    });
  } catch { return false; }
}

export function readCaseDraft(userId: string | undefined, workspaceId: string): {
  draft: CaseDraft; status: DraftStorageStatus;
} {
  if (!userId) return { draft: emptyDraft(), status: "disabled" };
  const key = draftKey(userId, workspaceId), target = storage();
  if (!key || !target) return { draft: emptyDraft(), status: "unavailable" };
  try {
    const raw = target.getItem(key);
    if (raw === null) return { draft: emptyDraft(), status: "available" };
    const value: unknown = raw.length <= 64000 ? JSON.parse(raw) : null;
    if (!record(value) || value.version !== 1 ||
        !exactKeys(value, ["version", ...fieldNames, "command"]) ||
        !validFields(value) || !validCommand(value.command, workspaceId)) {
      target.removeItem(key);
      return { draft: emptyDraft(), status: "unavailable" };
    }
    return { draft: { title: value.title, question: value.question, affected_flow: value.affected_flow, command: value.command }, status: "available" };
  } catch {
    // Malformed or inaccessible storage must never prevent a new investigation.
    return { draft: emptyDraft(), status: "unavailable" };
  }
}

export function saveCaseDraft(
  userId: string | undefined, workspaceId: string, fields: CaseDraftFields, command: CommandIdentity,
): DraftStorageStatus {
  if (!userId) return "disabled";
  const key = draftKey(userId, workspaceId), target = storage();
  if (!key || !target) return "unavailable";
  try {
    if (!validFields(fields) || !validCommand(command, workspaceId)) throw new Error("Invalid case draft.");
    // Select only form fields and the validated command, never session credentials.
    target.setItem(key, JSON.stringify({ version: 1, title: fields.title, question: fields.question, affected_flow: fields.affected_flow, command }));
    return "available";
  } catch {
    // If a new intent cannot be saved, do not leave an older intent for recovery.
    try { target.removeItem(key); } catch { /* Storage may be entirely unavailable. */ }
    return "unavailable";
  }
}

export function clearCaseDraft(userId: string | undefined, workspaceId: string): DraftStorageStatus {
  if (!userId) return "disabled";
  const key = draftKey(userId, workspaceId), target = storage();
  if (!key || !target) return "unavailable";
  try { target.removeItem(key); return "available"; }
  catch { return "unavailable"; }
}

export function clearCaseDraftsForUser(userId: string): DraftStorageStatus {
  const userPrefix = scopePrefix(userId), target = storage();
  if (!userPrefix || !target) return "unavailable";
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (key?.startsWith(userPrefix)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
    return "available";
  } catch { return "unavailable"; }
}

/** Pin the exact command to this tab's draft before the caller sends the POST. */
export function prepareCaseDraftSubmission(
  userId: string | undefined, workspaceId: string, fields: CaseDraftFields,
  command: { current: CommandIdentity },
) {
  const path = `${workspacePath(workspaceId)}/cases`, body = bodyFromDraft(fields);
  const idempotencyKey = commandKey(command, { path, method: "POST", body });
  const status = saveCaseDraft(userId, workspaceId, fields, command.current);
  return { path, body, idempotencyKey, status };
}
