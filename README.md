# Faultline

Faultline investigates web conversion regressions using frozen metrics, source evidence, competing hypotheses, controlled tests and cited reports. Its agent proposes investigation steps and drafts findings; deterministic services own counts, permissions, verification and evidence freshness.

## Requirements

- Node.js 24 and pnpm 9.15.1.
- PostgreSQL 17, or the bundled development database launcher.
- Optional model and source credentials configured privately.

## Run locally

Install the pinned dependencies:

```sh
pnpm install --frozen-lockfile
```

In one terminal, start the private development database. This generates ignored local configuration and a local owner identity:

```sh
pnpm db:local
```

Keep it running. In another terminal, initialize the installation:

```sh
pnpm db:migrate
pnpm db:roles
pnpm keys:init
pnpm bootstrap --prepare
pnpm bootstrap
pnpm dev
```

Open http://localhost:3000. Read the generated owner credentials privately from `.runtime/development-config.json`. Keep environment files, keys and that file out of source control. Existing configuration and keys are preserved by the setup tools.

For an existing PostgreSQL installation, use `config/runtime.env.example` and `config/operator.env.example` to configure separate runtime and operator roles before migration and bootstrap. Public signup defaults to disabled. Model access and external runner capabilities require separate configuration.

## Development

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:hosting
```

Reusable database integration tests use `pnpm test:integration` with an isolated PostgreSQL installation and private configuration. Browser and live integration tests require their configured services and approved targets.

## Source layout

- `apps/web`: React application.
- `apps/api`: Fastify API and authentication.
- `apps/worker`: durable investigation jobs.
- `apps/runner`: bounded browser execution.
- `packages/core`: investigation, agent, metrics, evidence and reporting services.
- `packages/database`: PostgreSQL schema and versioned migrations.
- `packages/contracts` and `contracts`: shared types and validation schemas.
- `fixtures` and `tests`: synthetic data and behavior tests.
- `tools/ops` and `ops`: operator tools and hosting configurations.

## Hosting

The repository includes Vercel/Supabase configuration and container recipes. Configure database roles, private storage, stable encryption/signing keys, origin allowlists and your hosting target before deployment. Configure `FAULTLINE_VERCEL_PROJECT_ID`, `FAULTLINE_VERCEL_TEAM_ID` and `FAULTLINE_VERCEL_ORIGIN` for the Vercel deployment helper. Its defaults are placeholders.

Synthetic fixture execution is separate from external staging verification. Local builds and unit tests do not establish production readiness or external runner isolation.

Vendored third-party code retains its accompanying licenses and attribution notices.
