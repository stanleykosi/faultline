import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandIdentity } from "../../command-key";
import {
  clearCaseDraft,
  clearCaseDraftsForUser,
  prepareCaseDraftSubmission,
  readCaseDraft,
  saveCaseDraft,
  type CaseDraftFields,
} from "./case-drafts";

class TabStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { throw new Error("Drafts must never clear all tab storage."); }
}

function withStorage(target: Storage | (() => Storage), run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    ...(typeof target === "function" ? { get: target } : { value: target }),
  });
  try { run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

const actor = "user-one", workspace = "workspace-one";
const fields: CaseDraftFields = {
  title: "  Mobile checkout <draft>  ",
  question: " Why did checkout drop?\nKeep the original spacing. ",
  affected_flow: " Cart → checkout → completed order  ",
};
const empty = { title: "", question: "", affected_flow: "", command: null };
const commandRef = (): { current: CommandIdentity } => ({ current: null });

test("raw case fields recover from tab storage and remain isolated by actor, workspace and tab", () => {
  const tab = new TabStorage();
  withStorage(tab, () => {
    assert.equal(saveCaseDraft(actor, workspace, fields, null), "available");
    assert.deepEqual(readCaseDraft(actor, workspace), { draft: { ...fields, command: null }, status: "available" });
    assert.deepEqual(readCaseDraft("other-user", workspace).draft, empty);
    assert.deepEqual(readCaseDraft(actor, "other-workspace").draft, empty);
  });
  // A fresh consumer needs only the persisted tab storage, with no component state.
  withStorage(tab, () => assert.deepEqual(readCaseDraft(actor, workspace).draft, { ...fields, command: null }));
  withStorage(new TabStorage(), () => assert.deepEqual(readCaseDraft(actor, workspace).draft, empty));
});

test("discard and logout remove only the intended draft keys", () => {
  const tab = new TabStorage();
  withStorage(tab, () => {
    tab.setItem("unrelated-setting", "retained");
    for (const owner of [actor, `${actor}-other`, `${actor}:other`]) {
      for (const scope of [workspace, "another-workspace"]) saveCaseDraft(owner, scope, fields, null);
    }
    assert.equal(clearCaseDraft(actor, workspace), "available");
    assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
    assert.deepEqual(readCaseDraft(actor, "another-workspace").draft, { ...fields, command: null });
    saveCaseDraft(actor, workspace, fields, null);
    assert.equal(clearCaseDraftsForUser(actor), "available");
    for (const scope of [workspace, "another-workspace"]) {
      assert.deepEqual(readCaseDraft(actor, scope).draft, empty);
      for (const other of [`${actor}-other`, `${actor}:other`]) {
        assert.deepEqual(readCaseDraft(other, scope).draft, { ...fields, command: null });
      }
    }
    assert.equal(tab.getItem("unrelated-setting"), "retained");
    assert.equal(tab.length, 5);
  });
});

test("an uncertain create identity is persisted before POST, reused after reload and rotated for changed intent", () => {
  withStorage(new TabStorage(), () => {
    const initial = prepareCaseDraftSubmission(actor, workspace, fields, commandRef());
    assert.equal(initial.status, "available");
    assert.deepEqual(initial.body, {
      title: "Mobile checkout <draft>",
      question: "Why did checkout drop?\nKeep the original spacing.",
      affected_flow: "Cart → checkout → completed order",
    });
    const recovered = readCaseDraft(actor, workspace).draft;
    assert.equal(recovered.command?.key, initial.idempotencyKey);
    assert.deepEqual(JSON.parse(recovered.command!.bodyCanonical), { path: initial.path, method: "POST", body: initial.body });
    const reference = { current: recovered.command };
    const retry = prepareCaseDraftSubmission(actor, workspace, recovered, reference);
    assert.equal(retry.idempotencyKey, initial.idempotencyKey);
    assert.equal(prepareCaseDraftSubmission(actor, workspace, { ...recovered, title: initial.body.title }, reference).idempotencyKey, initial.idempotencyKey);

    const edited = { ...fields, question: "Which change affected checkout?" };
    // Input capture retains the uncertain identity until the reviewed intent is submitted.
    saveCaseDraft(actor, workspace, edited, reference.current);
    const editedRecovery = readCaseDraft(actor, workspace).draft;
    assert.equal(editedRecovery.command?.key, initial.idempotencyKey);
    const changed = prepareCaseDraftSubmission(actor, workspace, editedRecovery, { current: editedRecovery.command });
    assert.notEqual(changed.idempotencyKey, initial.idempotencyKey);
    assert.equal(readCaseDraft(actor, workspace).draft.command?.key, changed.idempotencyKey);
    assert.deepEqual(readCaseDraft(actor, workspace).draft.question, edited.question);
  });
});

test("storage retains only bounded form fields and the exact allowed command shape", () => {
  const tab = new TabStorage();
  withStorage(tab, () => {
    const extra = { ...fields, csrf: "secret-csrf", password: "secret-password", token: "secret-token" };
    assert.equal(saveCaseDraft(actor, workspace, extra, null), "available");
    const key = tab.key(0)!;
    assert.deepEqual(Object.keys(JSON.parse(tab.getItem(key)!)).sort(), ["affected_flow", "command", "question", "title", "version"]);
    assert.doesNotMatch(tab.getItem(key)!, /secret-|csrf|password|token/);

    // Even maximally escaped strings at the HTML limits fit the storage bounds.
    const bounded = { title: "\u0001".repeat(200), question: "\u0001".repeat(2000), affected_flow: "\u0001".repeat(2000) };
    const prepared = prepareCaseDraftSubmission(actor, workspace, bounded, commandRef());
    assert.equal(prepared.status, "available");
    const recovered = readCaseDraft(actor, workspace);
    assert.equal(recovered.status, "available");
    assert.equal(recovered.draft.title, bounded.title);
    assert.equal(recovered.draft.question, bounded.question);
    assert.equal(recovered.draft.affected_flow, bounded.affected_flow);
    assert.equal(recovered.draft.command?.key, prepared.idempotencyKey);
    assert.equal(saveCaseDraft(actor, workspace, { ...fields, title: "x".repeat(201) }, null), "unavailable");
    assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
  });
});

test("malformed, oversized and forged stored records cannot restore fields or unsafe identities", () => {
  const tab = new TabStorage();
  withStorage(tab, () => {
    prepareCaseDraftSubmission(actor, workspace, fields, commandRef());
    const key = tab.key(0)!, raw = tab.getItem(key)!;
    const baseline = JSON.parse(raw);
    const identityWithIntent = (intent: unknown) => ({ ...baseline.command, bodyCanonical: JSON.stringify(intent) });
    const intent = JSON.parse(baseline.command.bodyCanonical);
    const invalid = [
      "{", "null", "[]", "x".repeat(64001),
      JSON.stringify({ ...baseline, version: 2 }),
      JSON.stringify({ ...baseline, csrf: "must-not-restore" }),
      JSON.stringify({ ...baseline, title: "x".repeat(201) }),
      JSON.stringify({ ...baseline, question: 42 }),
      JSON.stringify({ ...baseline, command: { ...baseline.command, key: "untrusted-key" } }),
      JSON.stringify({ ...baseline, command: { ...baseline.command, token: "must-not-restore" } }),
      JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, path: "/api/v1/workspaces/other/cases" }) }),
      JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, method: "DELETE" }) }),
      JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, body: { ...intent.body, password: "must-not-restore" } }) }),
      JSON.stringify({ ...baseline, command: identityWithIntent({ ...intent, csrf: "must-not-restore" }) }),
    ];
    for (const value of invalid) {
      tab.setItem(key, value);
      assert.deepEqual(readCaseDraft(actor, workspace), { draft: empty, status: "unavailable" });
    }
    assert.equal(saveCaseDraft(actor, workspace, fields, null), "available");
    assert.deepEqual(readCaseDraft(actor, workspace).draft, { ...fields, command: null });
    assert.equal(saveCaseDraft(actor, workspace, fields, { ...baseline.command, bodyCanonical: JSON.stringify({ ...intent, csrf: "must-not-save" }) }), "unavailable");
    assert.equal(tab.getItem(key), null);
  });
});

test("unavailable storage never blocks preparing creation or falsely reports recovery available", () => {
  withStorage(() => { throw new Error("Storage access denied"); }, () => {
    assert.deepEqual(readCaseDraft(actor, workspace), { draft: empty, status: "unavailable" });
    assert.equal(saveCaseDraft(actor, workspace, fields, null), "unavailable");
    assert.equal(clearCaseDraft(actor, workspace), "unavailable");
    assert.equal(clearCaseDraftsForUser(actor), "unavailable");
    const command = commandRef();
    const first = prepareCaseDraftSubmission(actor, workspace, fields, command);
    assert.equal(first.status, "unavailable");
    assert.ok(first.idempotencyKey);
    assert.equal(prepareCaseDraftSubmission(actor, workspace, fields, command).idempotencyKey, first.idempotencyKey);
  });
  const tab = new TabStorage();
  withStorage(tab, () => {
    saveCaseDraft(actor, workspace, fields, null);
    tab.setItem = () => { throw new Error("Quota exceeded"); };
    assert.equal(prepareCaseDraftSubmission(actor, workspace, { ...fields, title: "Changed intent" }, commandRef()).status, "unavailable");
    assert.deepEqual(readCaseDraft(actor, workspace).draft, empty);
    tab.getItem = () => { throw new Error("Read denied"); };
    tab.removeItem = () => { throw new Error("Delete denied"); };
    assert.equal(readCaseDraft(actor, workspace).status, "unavailable");
    assert.equal(clearCaseDraft(actor, workspace), "unavailable");
    assert.equal(saveCaseDraft(actor, workspace, fields, null), "unavailable");
  });
});

test("omitting the authenticated actor disables persistence without touching storage", () => {
  let accesses = 0;
  withStorage(() => { accesses++; throw new Error("Must not access storage"); }, () => {
    assert.deepEqual(readCaseDraft(undefined, workspace), { draft: empty, status: "disabled" });
    assert.equal(saveCaseDraft(undefined, workspace, fields, null), "disabled");
    assert.equal(clearCaseDraft(undefined, workspace), "disabled");
    assert.equal(prepareCaseDraftSubmission(undefined, workspace, fields, commandRef()).status, "disabled");
    assert.equal(accesses, 0);
  });
});
