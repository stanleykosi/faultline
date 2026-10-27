import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  request,
  workspacePath,
  type Envelope,
  type Workspace,
} from "../../api";
import { ErrorNotice, Field, Loading, Status, formError } from "../../ui";
import { useCommand } from "../investigation/Shared";

export interface ActivityItem {
  id: string;
  case_id?: string | null;
  type?: string;
  operation?: string;
  actor_id?: string;
  user_id?: string;
  details?: Record<string, unknown>;
  read_at?: string | null;
  created_at: string;
}
export type ActivityReviewFilters = Readonly<{
  case_id: string;
  actor_id: string;
  action: string;
  from: string;
  to: string;
}>;
export const emptyActivityFilters: ActivityReviewFilters = Object.freeze({
  case_id: "",
  actor_id: "",
  action: "",
  from: "",
  to: "",
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const principalId = /^[A-Za-z0-9_-]{1,128}$/;

/** An applied review is a new immutable value; editing the draft cannot change pagination. */
export function reviewActivityFilters(
  draft: ActivityReviewFilters,
  audit: boolean,
): ActivityReviewFilters {
  const value = {
    case_id: draft.case_id.trim().toLowerCase(),
    actor_id: draft.actor_id.trim(),
    action: draft.action.trim(),
    from: draft.from.trim(),
    to: draft.to.trim(),
  };
  if (!audit && (value.actor_id || value.action || value.from || value.to))
    throw new Error(
      "Personal activity can only filter your own notifications by case UUID.",
    );
  if (value.case_id && !uuid.test(value.case_id))
    throw new Error("Choose an exact case UUID.");
  if (value.actor_id && !principalId.test(value.actor_id))
    throw new Error("Choose an exact actor identity.");
  if (value.action.length > 200 || /[\u0000-\u001f\u007f]/.test(value.action))
    throw new Error("Choose an exact finite audit action.");
  function utc(instant: string): string {
    if (!instant) return "";
    const match =
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(instant);
    if (!match || match[1].startsWith("0000-"))
      throw new Error("Enter UTC boundaries as YYYY-MM-DDTHH:mm:ss[.ffffff]Z.");
    const time = new Date(match[1] + ".000Z");
    if (
      !Number.isFinite(time.getTime()) ||
      time.toISOString().slice(0, 19) !== match[1]
    )
      throw new Error("Choose valid UTC calendar dates and times.");
    return match[1] + "." + (match[2] ?? "").padEnd(6, "0") + "Z";
  }
  value.from = utc(value.from);
  value.to = utc(value.to);
  if (value.from && value.to && value.from >= value.to)
    throw new Error(
      "The inclusive From boundary must precede the exclusive To boundary.",
    );
  return Object.freeze(value);
}

export function activityReadPath(
  workspaceId: string,
  audit: boolean,
  applied: ActivityReviewFilters,
  cursor?: string | null,
): string {
  const reviewed = reviewActivityFilters(applied, audit),
    params = new URLSearchParams();
  for (const key of ["case_id", "actor_id", "action", "from", "to"] as const)
    if (reviewed[key]) params.set(key, reviewed[key]);
  if (cursor) params.set("cursor", cursor);
  return `${workspacePath(workspaceId)}/${audit ? "audit" : "activity"}${params.size ? "?" + params : ""}`;
}

export async function readActivityPage(
  workspaceId: string,
  audit: boolean,
  applied: ActivityReviewFilters,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<Envelope<ActivityItem[]>> {
  const value = await request<Envelope<ActivityItem[]>>(
    activityReadPath(workspaceId, audit, applied, cursor),
    { signal },
  );
  if (
    !Array.isArray(value?.data) ||
    (value.page?.next_cursor !== undefined &&
      value.page.next_cursor !== null &&
      typeof value.page.next_cursor !== "string")
  )
    throw new Error("History is unavailable.");
  return value;
}

export function ActivityFilterForm({
  audit,
  draft,
  applied,
  disabled,
  onDraft,
  onApply,
  onReset,
}: {
  audit: boolean;
  draft: ActivityReviewFilters;
  applied: ActivityReviewFilters;
  disabled: boolean;
  onDraft: (key: keyof ActivityReviewFilters, value: string) => void;
  onApply: (event: FormEvent) => void;
  onReset: () => void;
}) {
  const summary = Object.entries(applied).filter(([, value]) => !!value);
  return (
    <section className="panel">
      <h2>Filters</h2>
      <form onSubmit={onApply}>
        <Field label="Investigation ID">
          <input
            id="activity-case-filter"
            value={draft.case_id}
            onChange={(event) => onDraft("case_id", event.target.value)}
            placeholder="All investigations"
            maxLength={36}
            disabled={disabled}
          />
        </Field>
        {audit && (
          <>
            <Field label="User ID">
              <input
                id="audit-actor-filter"
                value={draft.actor_id}
                onChange={(event) => onDraft("actor_id", event.target.value)}
                placeholder="All users"
                maxLength={128}
                disabled={disabled}
              />
            </Field>
            <Field label="Action">
              <input
                id="audit-action-filter"
                value={draft.action}
                onChange={(event) => onDraft("action", event.target.value)}
                placeholder="All actions"
                maxLength={200}
                disabled={disabled}
              />
            </Field>
            <Field label="From (UTC)" hint="Example: 2026-10-13T00:00:00Z">
              <input
                id="audit-from-filter"
                value={draft.from}
                onChange={(event) => onDraft("from", event.target.value)}
                placeholder="2026-10-13T00:00:00Z"
                maxLength={27}
                disabled={disabled}
              />
            </Field>
            <Field label="To (UTC)" hint="The end time is not included.">
              <input
                id="audit-to-filter"
                value={draft.to}
                onChange={(event) => onDraft("to", event.target.value)}
                placeholder="2026-10-14T00:00:00Z"
                maxLength={27}
                disabled={disabled}
              />
            </Field>
          </>
        )}
        <div className="form-actions">
          <button
            className="secondary"
            type="button"
            disabled={disabled}
            onClick={onReset}
          >
            Reset filters
          </button>
          <button className="secondary" type="submit" disabled={disabled}>
            Apply filters
          </button>
        </div>
      </form>
      {summary.length > 0 && (
        <details aria-label="Applied activity filters">
          <summary>Active filters ({summary.length})</summary>
          <dl className="scope-details">
            {summary.map(([key, value]) => (
              <div key={key}>
                <dt>
                  {
                    (
                      {
                        case_id: "Investigation ID",
                        actor_id: "User ID",
                        action: "Action",
                        from: "From",
                        to: "To",
                      } as Record<string, string>
                    )[key]
                  }
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

export function ActivityResults({
  workspace,
  audit,
  currentUserId,
  items,
  known,
  loading,
  pending,
  error,
  navigate,
  onRead,
}: {
  workspace: Workspace;
  audit: boolean;
  currentUserId: string;
  items: ActivityItem[];
  known: boolean;
  loading: boolean;
  pending: string;
  error: Error | null;
  navigate: (path: string) => void;
  onRead: (item: ActivityItem) => void;
}) {
  return (
    <>
      <div className="list-tools">
        <Status tone="muted">
          {known ? `${items.length} shown` : "Status unknown"}
        </Status>
      </div>
      <ErrorNotice error={error} />
      {loading ? (
        <Loading
          label={audit ? "Loading activity…" : "Loading notifications…"}
        />
      ) : items.length ? (
        <section className="panel activity-list">
          {items.map((item) => {
            const referencedCase = item.case_id ?? item.details?.case_id;
            return (
              <article className="activity-card" key={item.id}>
                <div className="section-heading">
                  <h2>
                    {(item.operation ?? item.type ?? "Activity")
                      .replaceAll(".", " / ")
                      .replaceAll("_", " ")}
                  </h2>
                  {!audit && (
                    <Status tone={item.read_at ? "muted" : "neutral"}>
                      {item.read_at ? "Read" : "Unread"}
                    </Status>
                  )}
                </div>
                <p className="fine-print">
                  {item.created_at}
                  {audit && item.actor_id ? ` · User ${item.actor_id}` : ""}
                </p>
                {typeof referencedCase === "string" &&
                  uuid.test(referencedCase) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        navigate(
                          `/w/${workspace.id}/cases/${referencedCase}/overview`,
                        )
                      }
                    >
                      Open investigation
                    </button>
                  )}
                {item.details && (
                  <details>
                    <summary>Details</summary>
                    <pre>{JSON.stringify(item.details, null, 2)}</pre>
                  </details>
                )}
                {!audit && !item.read_at && item.user_id === currentUserId && (
                  <button
                    className="secondary"
                    disabled={!!pending}
                    onClick={() => onRead(item)}
                  >
                    {pending === item.id ? "Updating…" : "Mark as read"}
                  </button>
                )}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="panel">
          <h2>
            {known && !error
              ? audit
                ? "No matching activity"
                : "No notifications"
              : audit
                ? "Activity log unavailable"
                : "History unavailable"}
          </h2>
          <p>
            {known && !error
              ? "Try changing the filters."
              : "Try refreshing the page."}
          </p>
        </section>
      )}
    </>
  );
}

export function Activity({
  workspace,
  csrf,
  currentUserId,
  audit = false,
  navigate,
}: {
  workspace: Workspace;
  csrf: string;
  currentUserId: string;
  audit?: boolean;
  navigate: (path: string) => void;
}) {
  const send = useCommand(csrf),
    path = `${workspacePath(workspace.id)}/${audit ? "audit" : "activity"}`;
  const [selection, setSelection] = useState({
    context: path,
    draft: emptyActivityFilters,
    applied: emptyActivityFilters,
  });
  const draft =
      selection.context === path ? selection.draft : emptyActivityFilters,
    applied =
      selection.context === path ? selection.applied : emptyActivityFilters;
  const [items, setItems] = useState<ActivityItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [known, setKnown] = useState(false),
    [pending, setPending] = useState(""),
    [error, setError] = useState<Error | null>(null),
    [reload, setReload] = useState(0);
  const nextPage = useRef<AbortController | null>(null),
    allowed = !audit || workspace.role === "owner";
  useEffect(() => {
    nextPage.current?.abort();
    setPending("");
    setItems([]);
    setCursor(null);
    setKnown(false);
    setError(null);
    if (!allowed) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    readActivityPage(workspace.id, audit, applied, null, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value.data);
          setCursor(value.page?.next_cursor ?? null);
          setKnown(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      nextPage.current?.abort();
    };
  }, [workspace.id, audit, path, allowed, applied, reload]);
  async function more() {
    if (!cursor || loading || pending) return;
    const controller = new AbortController();
    nextPage.current = controller;
    setPending("more");
    setError(null);
    try {
      const value = await readActivityPage(
        workspace.id,
        audit,
        applied,
        cursor,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setItems((previous) => [...previous, ...value.data]);
        setCursor(value.page?.next_cursor ?? null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(formError(cause));
    } finally {
      if (!controller.signal.aborted) setPending("");
    }
  }
  async function read(item: ActivityItem) {
    setPending(item.id);
    setError(null);
    try {
      const value = await send<{ id: string; read_at: string }>(
        `${workspacePath(workspace.id)}/notifications/${encodeURIComponent(item.id)}/read`,
        {},
      );
      setItems((previous) =>
        previous.map((row) =>
          row.id === value.id ? { ...row, read_at: value.read_at } : row,
        ),
      );
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  function filter(event: FormEvent) {
    event.preventDefault();
    try {
      const reviewed = reviewActivityFilters(draft, audit);
      setSelection({ context: path, draft: { ...draft }, applied: reviewed });
    } catch (cause) {
      setError(formError(cause));
    }
  }
  function reset() {
    setSelection({
      context: path,
      draft: emptyActivityFilters,
      applied: emptyActivityFilters,
    });
    setReload((value) => value + 1);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            {audit ? "Activity log" : "History"}
            <span className="heading-dot">.</span>
          </h1>
        </div>
        {allowed && (
          <button
            className="secondary"
            disabled={loading || !!pending}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh
          </button>
        )}
      </div>
      {!allowed ? (
        <section className="notice">
          <strong>Owner access required</strong>
          <p>Only workspace owners can view the full activity log.</p>
        </section>
      ) : (
        <>
          <ActivityFilterForm
            audit={audit}
            draft={draft}
            applied={applied}
            disabled={loading || !!pending}
            onDraft={(key, value) =>
              setSelection({
                context: path,
                draft: { ...draft, [key]: value },
                applied,
              })
            }
            onApply={filter}
            onReset={reset}
          />
          <ActivityResults
            workspace={workspace}
            audit={audit}
            currentUserId={currentUserId}
            items={items}
            known={known}
            loading={loading}
            pending={pending}
            error={error}
            navigate={navigate}
            onRead={(item) => void read(item)}
          />
          {cursor && (
            <div className="load-more">
              <button
                className="secondary"
                disabled={loading || !!pending}
                onClick={() => void more()}
              >
                {pending === "more" ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
