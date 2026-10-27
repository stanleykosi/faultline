import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, resource, workspacePath, type Workspace } from "../../api";
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Status,
  formError,
} from "../../ui";
import { safeId } from "../data/types";
import { useCommand } from "../investigation/Shared";
import { OperationPanel } from "./OperationPanel";
import { CredentialReplacement } from "./CredentialReplacement";
import { rememberProvider, type ModelProfile } from "./types";
import {METERLESS_BASE_URL,normalizeMeterlessProfile,validMeterlessToken} from '../../../../../packages/core/src/models/meterless-profile';

export type ModelProviderChoice = "ollama" | "openai_compatible" | "openrouter" | "meterless";

export const openRouterBaseUrl = "https://openrouter.ai/api/v1";

export function modelProviderBaseUrl(
  provider: ModelProviderChoice,
  current: string,
): string {
  if (provider === "openrouter") return openRouterBaseUrl;
  if (provider === "meterless") return METERLESS_BASE_URL;
  return current === openRouterBaseUrl || current === METERLESS_BASE_URL ? "" : current;
}
export function modelConnectionInput(form:FormData,provider:ModelProviderChoice){
 const secret=String(form.get('secret_value')??''),base=String(form.get('base_url')??'').trim();
 const parsed=provider==='meterless'?normalizeMeterlessProfile(base,secret||undefined):{base_url:base,token:secret||undefined};
 if(provider==='meterless'&&!validMeterlessToken(parsed.token))throw new Error('Paste the real Meterless Runtime token or a connect link containing its key.');
 return {name:String(form.get('name')??'').trim(),provider,base_url:parsed.base_url,model_name:String(form.get('model_name')??'').trim(),...(parsed.token?{secret_value:parsed.token}:{})};
}
export function modelProviderLabel(provider:ModelProviderChoice){return provider==='meterless'?'Meterless Nightshift':provider==='openrouter'?'OpenRouter':provider==='ollama'?'Local Ollama':'Compatible endpoint';}

export function ModelProfileRemovalReview({
  profile,
}: {
  profile: ModelProfile;
}) {
  return (
    <>
      <dl className="policy-values">
        <div>
          <dt>Connection name</dt>
          <dd>{profile.name}</dd>
        </div>
        <div>
          <dt>Exact profile</dt>
          <dd>{profile.id}</dd>
        </div>
        <div>
          <dt>Resource revision</dt>
          <dd>{profile.revision}</dd>
        </div>
        <div>
          <dt>Endpoint</dt>
          <dd>{profile.base_url}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{profile.model_name}</dd>
        </div>
      </dl>
      <p className="notice warning">
        Removing this profile makes it unavailable for new proposals and
        invalidates its capability record. Queued or running profile probes and
        dependent work are cancelled or receive cancellation requests. Existing
        investigation evidence is retained. This does not revoke a separately
        stored credential or delete provider-side data.
      </p>
    </>
  );
}

export function ModelProfiles({
  workspace,
  csrf,
}: {
  workspace: Workspace;
  csrf: string;
}) {
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);
  const send = useCommand(csrf),
    [profiles, setProfiles] = useState<ModelProfile[]>([]),
    [known, setKnown] = useState(false),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(""),
    [error, setError] = useState<Error | null>(null),
    [creating, setCreating] = useState(false),
    [provider, setProvider] = useState<ModelProviderChoice>("openrouter"),
    [baseUrl, setBaseUrl] = useState(openRouterBaseUrl),
    [operationId, setOperationId] = useState(
      safeId(new URLSearchParams(location.search).get("model_operation")),
    );
  const path = `${workspacePath(workspace.id)}/model-profiles`,
    allowed = workspace.role !== "viewer",
    isOwner = workspace.role === "owner";
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!allowed) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const value = await resource<ModelProfile[]>(path, { signal });
        if (!Array.isArray(value))
          throw new Error("The model profile inventory was unavailable.");
        if (!signal?.aborted) {
          setProfiles(value);
          setKnown(true);
        }
      } catch (cause) {
        if (!signal?.aborted) {
          setKnown(false);
          setError(formError(cause));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [path, allowed],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget,
      form = new FormData(element);
    setPending("create");
    setError(null);
    try {
      // Strip connect fragments before sending so a URL never carries the token to API logging.
      await send(path, modelConnectionInput(form,provider));
      element.reset();
      setProvider("openrouter");
      setBaseUrl(openRouterBaseUrl);
      setCreating(false);
      await load();
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  async function probe(event: FormEvent, profile: ModelProfile) {
    event.preventDefault();
    setPending(profile.id);
    setError(null);
    try {
      const value = await send<{ operation_id: string; status: string }>(
        `${path}/${encodeURIComponent(profile.id)}/probe`,
        {},
      );
      if (!value?.operation_id)
        throw new Error(
          "No recorded model capability operation identity was returned.",
        );
      setOperationId(value.operation_id);
      rememberProvider("model_operation", value.operation_id);
    } catch (cause) {
      setError(formError(cause));
    } finally {
      setPending("");
    }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!deleting || !isOwner) return;
    setPending("delete");
    setError(null);
    try {
      const value = await send<{
        id: string;
        deleted: boolean;
        revision: number;
      }>(
        `${path}/${encodeURIComponent(deleting.id)}`,
        undefined,
        "DELETE",
        deleting.revision,
      );
      if (value?.id !== deleting.id || value.deleted !== true)
        throw Error(
          "Profile removal was not confirmed. Refresh the inventory before retrying.",
        );
      setDeleting(null);
      await load();
    } catch (cause) {
      setError(formError(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        setDeleting(null);
        await load();
      }
    } finally {
      setPending("");
    }
  }
  if (!allowed)
    return (
      <section className="notice">
        <strong>Owner or analyst access required</strong>
        <p>
          Agent model settings are unavailable with viewer access. You can still
          read the investigation.
        </p>
      </section>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            Agent models<span className="heading-dot">.</span>
          </h1>
        </div>
        {isOwner && (
          <button
            className="primary"
            disabled={!!pending}
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
          >
            Connect model
          </button>
        )}
      </div>
      <ErrorNotice error={creating ? null : error} />
      <button
        className="secondary"
        disabled={loading || !!pending}
        onClick={() => {
          setError(null);
          void load();
        }}
      >
        Refresh
      </button>
      {loading && !known ? (
        <Loading label="Loading Agent models…" />
      ) : profiles.length ? (
        <div className="provider-list">
          {profiles.map((profile) => (
            <section className="panel provider-card" key={profile.id}>
              <div className="section-heading">
                <div>
                  <h2>{profile.name}</h2>
                </div>
                <Status
                  tone={
                    profile.capabilities?.status === "available" &&
                    profile.status === "available"
                      ? "muted"
                      : "warning"
                  }
                >
                  {profile.status ?? "Unknown"}
                </Status>
              </div>
              {profile.reason_code && <p className="notice warning">{profile.reason_code}</p>}
              <p>{modelProviderLabel(profile.provider)} · {profile.model_name}</p>
              {profile.provider==='meterless'&&profile.status==='unauthorized'&&<p className="notice warning">Meterless rejected this token. Replace it with the runtime token and check the connection again.</p>}
              <details><summary>Manage connection</summary>
              <dl className="policy-values">
                <div>
                  <dt>Endpoint</dt>
                  <dd>{profile.base_url}</dd>
                </div>
              </dl>
              <details>
                <summary>Profile details</summary>
                <p className="hash-line">Profile hash {profile.profile_hash}</p>
                <p>
                  Profile {profile.id} · Revision {profile.revision} ·
                  Credential{" "}
                  {profile.credential_source === 'server' ? 'Managed in hosting settings' : profile.credential
                    ? `${profile.credential.hint}, version ${profile.credential.active_version}, ${profile.credential.revoked ? "revoked" : "configured"}`
                    : "None"}
                  .
                </p>
              </details>
              {profile.capabilities ? (
                <details>
                  <summary>Connection check details</summary>
                  <pre>{JSON.stringify(profile.capabilities, null, 2)}</pre>
                </details>
              ) : (
                <p className="notice warning">
                  This connection has not passed its latest check.
                </p>
              )}
              {isOwner && profile.credential && (
                <CredentialReplacement
                  workspaceId={workspace.id}
                  csrf={csrf}
                  credential={profile.credential}
                  resourceName={profile.name}
                  onChanged={() => load()}
                />
              )}
              {isOwner && profile.credential_source !== 'server' && (
                <button
                  className="text-button danger"
                  disabled={!!pending}
                  onClick={() => {
                    setDeleting(profile);
                    setError(null);
                  }}
                >
                  Remove {profile.name}
                </button>
              )}
              {isOwner && (
                <form onSubmit={(event) => void probe(event, profile)}>
                  <p>
                    This sends one small test request without investigation data.
                    It may use your provider allowance.
                  </p>
                  <label className="review-checkbox">
                    <input type="checkbox" required disabled={!!pending} />I
                    approve one connection check for this URL, model, and credential.
                  </label>
                  <button
                    className="secondary"
                    disabled={!!pending || profile.credential?.revoked}
                  >
                    {pending === profile.id
                      ? "Checking connection…"
                      : "Check model connection"}
                  </button>
                </form>
              )}
              </details>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          title={
            known
              ? "No Agent model connected"
              : "Agent model status unavailable"
          }
        >
          {known
            ? "An owner can connect a model to start the investigation agent."
            : "Fix the error and refresh."}
        </Empty>
      )}
      <OperationPanel
        workspaceId={workspace.id}
        operationId={operationId}
        onSettled={() => load()}
      />
      {deleting && (
        <Modal
          title="Remove Agent model"
          onClose={() => {
            if (!pending) setDeleting(null);
          }}
        >
          <form onSubmit={remove}>
            <ErrorNotice error={error} />
            <ModelProfileRemovalReview profile={deleting} />
            <label className="review-checkbox">
              <input type="checkbox" required disabled={!!pending} />I reviewed
              this exact profile, endpoint, model and dependent-work
              cancellation.
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={!!pending}
                onClick={() => setDeleting(null)}
              >
                Cancel profile removal
              </button>
              <button className="primary" disabled={!!pending}>
                {pending === "delete"
                  ? "Removing reviewed profile…"
                  : "Remove Agent model"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {creating && (
        <Modal
          title="Connect Agent model"
          onClose={() => {
            if (!pending) setCreating(false);
          }}
        >
          <form onSubmit={create}>
            <ErrorNotice error={error} />
            <Field label="Connection name">
              <input name="name" required maxLength={200} />
            </Field>
            <Field label="Provider">
              <select
                value={provider}
                onChange={(event) => {
                  const next = event.target.value as ModelProviderChoice;
                  setProvider(next);
                  setBaseUrl((current) => modelProviderBaseUrl(next, current));
                }}
                disabled={!!pending}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="meterless">Meterless Nightshift</option>
                <option value="ollama">Local Ollama structured chat</option>
                <option value="openai_compatible">
                  Configured compatible JSON-schema endpoint
                </option>
              </select>
            </Field>
            <Field
              label="Provider URL"
              hint={
                provider === "openrouter"
                  ? "OpenRouter uses its standard API base."
                  : provider === "meterless"
                  ? "Paste the runtime URL or connect link. The server operator must approve this exact origin; localhost refers to the server hosting Faultline."
                  : provider === "ollama"
                  ? "The exact local origin must be explicitly registered by the operator."
                  : "The exact approved origin and supported /v1 base are required by the server."
              }
            >
              <input name="base_url" type={provider==='meterless'?'text':'url'} required value={baseUrl} autoComplete="off" spellCheck={false} onChange={event => setBaseUrl(event.target.value)} />
            </Field>
            <Field label={provider==='meterless'?'Routing mode':'Model name'} hint={provider==='meterless'?'Use meterless/auto or another mode from your runtime. Connection checks discover routing modes and independently verify strict structured output.':undefined}>
              <input key={provider} name="model_name" required maxLength={200} defaultValue={provider==='meterless'?'meterless/auto':''} />
            </Field>
            <Field label={provider === "openrouter" ? "OpenRouter API key" : provider==='meterless'?'Meterless Runtime token':'API key — optional'} hint={provider==='meterless'?'Copy proxy-token from the runtime state directory, or paste a connect link above. rt-local is rejected.':undefined}>
              <input
                name="secret_value"
                type="password"
                maxLength={2000}
                required={provider === "openrouter"}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <p className="notice">
              The key is encrypted. Saving does not contact the model.
            </p>
            <label className="review-checkbox">
              <input type="checkbox" required disabled={!!pending} />I reviewed
              this URL, model, and key. agent can draft text only.
            </label>
            <button className="primary" disabled={!!pending}>
              {pending ? "Saving model…" : "Save model"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
