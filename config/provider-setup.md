# Model and source providers

OpenRouter and Meterless Nightshift are separate model providers. Select either profile for a case. The selected profile handles planning, proposals and report drafts. Faultline does not silently switch providers.

## Meterless Nightshift

Nightshift supplies an OpenAI-compatible HTTP interface. Faultline uses its documented provider contract directly; no extra SDK is required.

1. Start an authorized Nightshift runtime.
2. Copy its real runtime token from its connection settings or private `proxy-token` file.
3. Add the exact runtime origin to the operator model allowlist.
4. Add a **Meterless Nightshift** model profile in the workspace.
5. Enter the base URL, runtime token and advertised routing mode.
6. Run **Check connection**.
7. Select the passing profile for the investigation.

The default base URL is `http://127.0.0.1:8088/v1`. The default routing mode is `meterless/auto`. Unknown advertised `meterless/*` modes remain valid choices. A connection link can supply the token; Faultline removes its fragment before storing the endpoint.

Local HTTP requires an explicit loopback origin in `MODEL_LOCAL_ORIGINS`. A hosted Faultline service cannot reach a runtime on your laptop through `127.0.0.1`. Hosted use requires an authorized reachable HTTPS runtime origin in `MODEL_ALLOWED_ORIGINS`.

Faultline sends the real Bearer token and `meterless-app: faultline` on every Nightshift request. Chat requests also send `meterless-scope: user`. It discovers modes through `/v1/models` before the strict structured-output probe. A process health response does not make the profile ready. Wrong credentials remain unauthorized; unsupported structured output remains a failed capability check.

Nightshift can route a mode to a specific underlying model. Faultline records that actual model identity separately from the requested routing mode. The existing schema, response-size, usage, cancellation and approval checks still apply. Cold model requests have a finite 180-second allowance.

For server-managed profiles, configure these values privately:

```dotenv
METERLESS_RUNTIME_TOKEN=REPLACE_WITH_REAL_PRIVATE_RUNTIME_TOKEN
METERLESS_BASE_URL=http://127.0.0.1:8088/v1
METERLESS_MODEL=meterless/auto
METERLESS_WORKSPACE_ID=REPLACE_WITH_WORKSPACE_UUID
```

Keep `AUTH_SECRET` stable. The optional workspace binding limits a server profile to one workspace. Existing OpenRouter settings remain separate: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and `OPENROUTER_WORKSPACE_ID`. Changing a token or model creates a new immutable server profile generation. Registration does not run a model or grant a passing capability record.

Configure NVIDIA credentials in Nightshift. Do not put those upstream credentials in the browser or substitute them for the runtime token. The illustrative token `rt-local` is not accepted.

## Zetaris REST

Faultline includes a real transport for the current Zetaris REST API. AWS is one hosting option for the Zetaris instance. Faultline does not provision AWS or infer a running instance from a Cloud Gateway account.

1. Start or select an authorized Zetaris instance.
2. Obtain its HTTPS API origin and numeric organisation ID.
3. Create an API key with the required read permissions.
4. Inspect the instance contract and compute its SHA-256 hash.
5. Add its exact origin to `CONNECTOR_ALLOWED_ORIGINS`.
6. Configure the same adapter binding for the API and worker.
7. Create a workspace Zetaris source with matching bindings and approved view mappings.
8. Enter its API key through the private source credential field.
9. Run the source connection check.
10. Approve a finite case evidence query before execution.

The nonsecret runtime binding has this shape:

```json
[
  {
    "adapter_id": "zetaris-rest-v1",
    "approved_origin": "https://YOUR_AUTHORIZED_INSTANCE",
    "contract_hash": "REPLACE_WITH_THE_REVIEWED_CONTRACT_SHA256",
    "organisation_id": 123
  }
]
```

Store this array in `ZETARIS_REST_ADAPTERS`. The organisation ID above is illustrative. The source's account scope must be `zetaris:org:<your actual numeric ID>`. Its adapter ID, origin and contract hash must match the configured binding. Approved relation and column mappings come from the actual instance. No API key belongs in this array.

The transport uses `GET /api/v1.0/datasource/datasources` and `POST /api/v1.0/sql-editor/sqls/run`. Requests include Bearer authorization, `X-Org-ID` and a fresh `X-Request-ID`. SQL comes from Faultline's fixed read-only templates. The query body includes `queryId`, `sql`, `source: "SqlEditor"` and a finite `limit`.

The current adapter captures one bounded result. It validates the documented row-array shape and the fixed projection. Response extensions or different scalar formats require an inspected compatibility update. An over-limit, malformed, cancelled or failed response cannot become admissible evidence.

The current REST contract does not establish remote query pagination, remote close, remote cancellation or a stable provider snapshot. The response does not attest the organisation scope. These limitations remain visible. Local cancellation aborts the request; it does not prove that remote computation stopped.

## Installation and acceptance

Apply migration `0038-meterless-model-provider` with the normal operator migration command before starting this version. It adds the Meterless provider and a restricted model-identity ledger column. API and worker startup require the matching migration manifest.

The source code and local tests establish implementation behavior. Actual Nightshift and Zetaris acceptance requires configured services and successful real calls. Unconfigured or untested profiles remain unverified.

Primary references: [Meterless provider contract](https://github.com/Meterless/Meterless/blob/main/docs/agent-ready/add-meterless-provider.md), [Meterless integration prompts](https://meterless.ai/engines.html), [Zetaris REST client](https://github.com/zetaris/getting-started/blob/main/scripts/zetaris_sql.py).
