import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  casePath,
  request,
  resource,
  workspacePath,
  type Envelope,
  type Investigation,
  type Workspace,
} from "../../api";
import { commandKey, type CommandIdentity } from "../../command-key";
import {
  Modal,
  Field,
  ErrorNotice,
  Loading,
  Status,
  Empty,
  dateLabel,
  formError,
} from "../../ui";
import { CaseNavigation } from "../data/Presentation";
import type { Snapshot } from "../data/types";
import { CaseDisposition, CasePreflight } from "./Controls";
import { DeletionControl } from "../settings/Deletion";
import {
  clearCaseDraft,
  prepareCaseDraftSubmission,
  readCaseDraft,
  saveCaseDraft,
  type CaseDraftFields,
} from "./case-drafts";

function caseFields(form: HTMLFormElement): CaseDraftFields {
  const values = new FormData(form);
  return {
    title: String(values.get("title") ?? ""),
    question: String(values.get("question") ?? ""),
    affected_flow: String(values.get("affected_flow") ?? ""),
  };
}

export function CreateCase({
  workspace,
  csrf,
  currentUserId,
  onClose,
  onCreated,
}: {
  workspace: Workspace;
  csrf: string;
  currentUserId?: string;
  onClose: () => void;
  onCreated: (item: Investigation) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [recovered] = useState(() => readCaseDraft(currentUserId, workspace.id));
  const [titleLength, setTitleLength] = useState(recovered.draft.title.length);
  const [draftStatus, setDraftStatus] = useState(recovered.status);
  const command = useRef<CommandIdentity>(recovered.draft.command);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  function close() {
    active.current = false;
    if (!pending) {
      clearCaseDraft(currentUserId, workspace.id);
      command.current = null;
    }
    onClose();
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active.current) return;
    const fields = caseFields(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const { path, body, idempotencyKey, status } = prepareCaseDraftSubmission(
        currentUserId, workspace.id, fields, command,
      );
      setDraftStatus(status);
      const item = await resource<Investigation>(path, {
        method: "POST",
        csrf,
        body,
        idempotencyKey,
      });
      if (!active.current) return;
      clearCaseDraft(currentUserId, workspace.id);
      command.current = null;
      onCreated(item);
    } catch (cause) {
      if (active.current) setError(formError(cause));
    } finally {
      if (active.current) setPending(false);
    }
  }
  return (
    <Modal title="New investigation" onClose={close}>
      <form onSubmit={submit} onInput={(event) => {
        if (!active.current) return;
        const fields = caseFields(event.currentTarget);
        setTitleLength(fields.title.length);
        setDraftStatus(saveCaseDraft(currentUserId, workspace.id, fields, command.current));
      }}>
        <ErrorNotice error={error} />
        {draftStatus === "unavailable" && (
          <p className="notice warning" role="status">
            Draft recovery is unavailable in this tab. Keep this form open until creation is confirmed.
          </p>
        )}
        <Field label="Name" hint={titleLength >= 180 ? `${titleLength}/200 characters` : undefined}>
          <input
            name="title"
            required
            maxLength={200}
            disabled={pending}
            defaultValue={recovered.draft.title}
            autoFocus
            placeholder="Mobile checkout drop"
          />
        </Field>
        <Field label="Your question">
          <textarea
            name="question"
            required
            maxLength={2000}
            disabled={pending}
            defaultValue={recovered.draft.question}
            rows={3}
            placeholder="Why are fewer people finishing checkout?"
          />
        </Field>
        <Field label="Product area">
          <input
            name="affected_flow"
            required
            maxLength={2000}
            disabled={pending}
            defaultValue={recovered.draft.affected_flow}
            placeholder="Checkout"
          />
        </Field>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            onClick={close}
          >
            {pending ? "Close" : "Cancel"}
          </button>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create investigation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CaseListResults({
  workspace,
  items,
  known,
  loading,
  error,
  search,
  archived,
  navigate,
  onCreate,
}: {
  workspace: Workspace;
  items: Investigation[];
  known: boolean;
  loading: boolean;
  error: Error | null;
  search: string;
  archived: boolean;
  navigate: (path: string) => void;
  onCreate: () => void;
}) {
  return (
    <>
      <ErrorNotice error={error} />
      {loading ? (
        <Loading label="Loading investigations…" />
      ) : !known || (!!error && items.length === 0) ? (
        <section className="panel">
          <h2>Investigations unavailable</h2>
          <p>Try refreshing the page.</p>
        </section>
      ) : items.length === 0 ? (
        <Empty
          title={
            search
              ? "No matches"
              : archived
                ? "No archived investigations"
                : "No investigations yet"
          }
          action={
            workspace.role !== "viewer" && !search && !archived ? (
              <button className="primary" onClick={onCreate}>
                Start an investigation
              </button>
            ) : undefined
          }
        >
          {search
            ? "Try another search."
            : archived
              ? "Archived investigations will appear here."
              : workspace.role === "viewer"
                ? "Ask an owner or analyst to start one."
                : "Start with a question about what changed."}
        </Empty>
      ) : (
        <div className="case-list">
          {items.map((item) => (
            <a
              className="case-row"
              key={item.id}
              href={`/w/${workspace.id}/cases/${item.id}/agent`}
              onClick={(event) => {
                if (!event.metaKey && !event.ctrlKey) {
                  event.preventDefault();
                  navigate(`/w/${workspace.id}/cases/${item.id}/agent`);
                }
              }}
            >
              <div className="case-avatar" aria-hidden="true">
                ⌁
              </div>
              <div className="case-row-main">
                <div className="case-row-title">
                  <h2>{item.title}</h2>
                  <Status>
                    {item.archived
                      ? "Archived"
                      : item.lifecycle.replaceAll("_", " ")}
                  </Status>
                </div>
                <p>{item.question}</p>
                <div className="case-row-meta">
                  
                  <span>Updated {dateLabel(item.updated_at)}</span>
                </div>
              </div>
              <span className="row-arrow" aria-hidden="true">
                ↗
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

export function CaseList({
  workspace,
  csrf,
  currentUserId,
  navigate,
}: {
  workspace: Workspace;
  csrf: string;
  currentUserId?: string;
  navigate: (path: string) => void;
}) {
  const [items, setItems] = useState<Investigation[]>([]);
  const [known, setKnown] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setKnown(false);
    setNextCursor(null);
    setLoading(true);
    setError(null);
    request<Envelope<Investigation[]>>(
      `${workspacePath(workspace.id)}/cases?q=${encodeURIComponent(search)}&archived=${archived}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!Array.isArray(result?.data))
          throw new Error("Investigations are unavailable.");
        if (!controller.signal.aborted) {
          setItems(result.data);
          setNextCursor(result.page?.next_cursor ?? null);
          setKnown(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspace.id, search, archived, refresh]);
  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const result = await request<Envelope<Investigation[]>>(
        `${workspacePath(workspace.id)}/cases?q=${encodeURIComponent(search)}&archived=${archived}&cursor=${encodeURIComponent(nextCursor ?? "")}`,
      );
      if (!Array.isArray(result?.data))
        throw new Error("The next investigation page was unavailable.");
      setItems((previous) => [...previous, ...result.data]);
      setNextCursor(result.page?.next_cursor ?? null);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            Investigations<span className="heading-dot">.</span>
          </h1>
        </div>
        {workspace.role !== "viewer" && (
          <button className="primary" onClick={() => setCreating(true)}>
            <span aria-hidden="true">＋</span>New investigation
          </button>
        )}
      </div>
      <div className="list-tools">
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(query.trim());
          }}
        >
          <label className="sr-only" htmlFor="case-search">
            Search investigations
          </label>
          <input
            id="case-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search investigations…"
            type="search"
          />
          <button className="secondary" type="submit">
            Search
          </button>
        </form>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Show archived
        </label>
        <button
          className="text-button"
          onClick={() => setRefresh((previous) => previous + 1)}
        >
          Refresh
        </button>
      </div>
      <CaseListResults
        workspace={workspace}
        items={items}
        known={known}
        loading={loading}
        error={error}
        search={search}
        archived={archived}
        navigate={navigate}
        onCreate={() => setCreating(true)}
      />
      {nextCursor && (
        <div className="load-more">
          <button
            className="secondary"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {creating && (
        <CreateCase
          key={`${currentUserId ?? ""}:${workspace.id}`}
          workspace={workspace}
          csrf={csrf}
          currentUserId={currentUserId}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            navigate(`/w/${workspace.id}/cases/${item.id}/agent`);
          }}
        />
      )}
    </>
  );
}

export function CaseOverview({
  workspace,
  csrf,
  caseId,
  navigate,
}: {
  workspace: Workspace;
  csrf: string;
  caseId: string;
  navigate: (path: string) => void;
}) {
  const [item, setItem] = useState<Investigation | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const archiveCommand = useRef<CommandIdentity>(null),
    scopeCommand = useRef<CommandIdentity>(null);
  const [lastCapture, setLastCapture] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    const controller = new AbortController();
    setLastCapture(undefined);
    resource<Snapshot[]>(`${casePath(workspace.id, caseId)}/snapshots`, {
      signal: controller.signal,
    })
      .then((records) => {
        if (!Array.isArray(records)) return;
        const times = records
          .map((record) => record.captured_at ?? record.created_at)
          .filter((time): time is string => !!time)
          .sort();
        setLastCapture(records.length === 0 ? null : times.at(-1));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLastCapture(undefined);
      });
    return () => controller.abort();
  }, [workspace.id, caseId, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setItem(null);
    setError(null);
    resource<Investigation>(casePath(workspace.id, caseId), {
      signal: controller.signal,
    })
      .then(setItem)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspace.id, caseId, refresh]);
  async function archive() {
    if (!item) return;
    setPending(true);
    setError(null);
    const path = `${casePath(workspace.id, caseId)}/archive`,
      body = { archived: !item.archived };
    try {
      setItem(
        await resource<Investigation>(path, {
          method: "POST",
          csrf,
          revision: item.revision,
          body,
          idempotencyKey: commandKey(archiveCommand, {
            path,
            method: "POST",
            revision: item.revision,
            body,
          }),
        }),
      );
      archiveCommand.current = null;
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!item) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const path = casePath(workspace.id, caseId),
      body = {
        title: String(form.get("title")).trim(),
        question: String(form.get("question")).trim(),
        affected_flow: String(form.get("affected_flow")).trim(),
      };
    try {
      setItem(
        await resource<Investigation>(path, {
          method: "PATCH",
          csrf,
          revision: item.revision,
          body,
          idempotencyKey: commandKey(scopeCommand, {
            path,
            method: "PATCH",
            revision: item.revision,
            body,
          }),
        }),
      );
      scopeCommand.current = null;
      setEditing(false);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending(false);
    }
  }
  if (loading) return <Loading label="Loading investigation…" />;
  return (
    <>
      <button
        className="back-link"
        onClick={() => navigate(`/w/${workspace.id}/cases`)}
      >
        ← Investigations
      </button>
      <CaseNavigation
        workspaceId={workspace.id}
        caseId={caseId}
        current="overview"
        navigate={navigate}
      />
      <ErrorNotice error={error} />
      {!item ? (
        <Empty
          title="Investigation unavailable"
          action={
            <button
              className="secondary"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>
          }
        >
          Check your access, then try again.
        </Empty>
      ) : (
        <>
          <div className="page-heading case-heading">
            <div>
              <h1>{item.title}</h1>
              <p>{item.question}</p>
            </div>
            <Status tone={item.archived ? "muted" : "neutral"}>
              {item.archived ? "Archived" : item.lifecycle.replaceAll("_", " ")}
            </Status>
          </div>
          <div className="case-toolbar">
            <span>
              Version <strong>{item.revision}</strong>
            </span>
            <span>
              Latest data{" "}
              <strong>
                {lastCapture === null
                  ? "None"
                  : lastCapture
                    ? dateLabel(lastCapture)
                    : "Unknown"}
              </strong>
            </span>
            <div className="toolbar-actions">
              <button
                className="text-button"
                onClick={() => setRefresh((value) => value + 1)}
              >
                Refresh
              </button>
              {workspace.role !== "viewer" && (
                <>
                  <button
                    className="secondary"
                    onClick={() => setEditing(true)}
                    disabled={
                      pending || item.archived || item.lifecycle !== "open"
                    }
                  >
                    Edit
                  </button>
                  <CaseDisposition
                    workspaceId={workspace.id}
                    csrf={csrf}
                    item={item}
                    onUpdated={setItem}
                  />
                  <button
                    className="secondary"
                    onClick={archive}
                    disabled={pending}
                  >
                    {item.archived ? "Restore" : "Archive"}
                  </button>
                </>
              )}
            </div>
          </div>
          {item.lifecycle === "closed" && (
            <p className="notice warning">
              <strong>
                Closed ·{" "}
                {item.disposition?.replaceAll("_", " ") ?? "Status unavailable"}
              </strong>
              {item.disposition_note && <span> {item.disposition_note}</span>}{" "}
              Reopen it to make changes.
            </p>
          )}
          <CasePreflight workspaceId={workspace.id} item={item} />
          <section className="panel">
            <h2>Investigation details</h2>
            <h3>Question</h3>
            <p className="scope-question">{item.question}</p>
            <h3>Affected flow</h3>
            <p>{item.affected_flow || "Not specified"}</p>
            <dl className="scope-details">
              <div>
                <dt>Created</dt>
                <dd>{dateLabel(item.created_at)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{dateLabel(item.updated_at)}</dd>
              </div>
            </dl>
            <button
              className="primary"
              onClick={() =>
                navigate(`/w/${workspace.id}/cases/${caseId}/data`)
              }
            >
              Review data and results
            </button>
          </section>
          {workspace.role === "owner" && (
            <DeletionControl
              workspaceId={workspace.id}
              caseId={caseId}
              title={item.title}
              csrf={csrf}
              onAccepted={(wid, id) => navigate(`/retention/${wid}/${id}`)}
            />
          )}
          {editing && (
            <Modal
              title="Edit investigation"
              onClose={() => {
                if (!pending) setEditing(false);
              }}
            >
              <form onSubmit={save}>
                <ErrorNotice error={error} />
                <Field label="Name">
                  <input
                    name="title"
                    required
                    maxLength={200}
                    defaultValue={item.title}
                    autoFocus
                  />
                </Field>
                <Field label="Question">
                  <textarea
                    name="question"
                    required
                    maxLength={2000}
                    rows={3}
                    defaultValue={item.question}
                  />
                </Field>
                <Field label="Affected flow">
                  <textarea
                    name="affected_flow"
                    required
                    maxLength={2000}
                    rows={2}
                    defaultValue={item.affected_flow}
                  />
                </Field>
                <div className="form-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                  <button className="primary" type="submit" disabled={pending}>
                    {pending ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </form>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
