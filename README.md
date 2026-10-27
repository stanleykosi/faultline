# Faultline

Faultline is an AI case agent to guide investigations into changes in a web conversion metric. Teams can run Faultline on their own servers.

Faultline combines analytics, support records, and release evidence within a defined scope. It compares possible explanations for a metric change. Repeatable staging tests can reproduce a mechanism. Further tests can validate a proposed correction. The investigation report shows the evidence and the limits of each conclusion.

## Deploy to Vercel

1. Install the official Vercel CLI.
2. Sign in through the Vercel CLI.
3. Make sure that the deployment target is configured and authorized.
4. Run this command:

   ```powershell
   pnpm deploy:vercel
   ```

The command selects permitted source files for a remote deployment. One deployment contains these components:

- The React frontend.
- The Fastify API function.
- The persistent pg-boss worker Daemon.

The command does not build Docker locally. It does not use Git deployment or send API requests through Railway. During acceptance tests, it keeps the previous live domain assignment.

To examine the same deployment inputs without an upload, run this command:

```powershell
pnpm deploy:vercel --dry
```

Supabase supplies PostgreSQL and private file storage. Configure the [runtime settings](ops/hosting/vercel-supabase/runtime.env.example) and [operator settings](ops/hosting/vercel-supabase/operator.env.example) privately. Set `FAULTLINE_VERCEL_PROJECT_ID`, `FAULTLINE_VERCEL_TEAM_ID`, and `FAULTLINE_VERCEL_ORIGIN` before deployment.

Application workflows that use the database require the Supabase installation. A successful remote build does not show that the application is ready. A successful `/health/live` response does not show this either.

`ops/hosting/railway/` contains the historical Railway deployment settings.

## Investigation rules

Faultline serves small product, growth, and engineering teams with event analytics and a staging site. A case is one investigation. A case has these frozen inputs:

- The investigation question.
- The session-conversion definition.
- The time windows.
- The source snapshot.
- The cohort mapping.
- The evidence.

The AI case agent reads case evidence, proposes hypotheses, suggests permitted tests, and drafts reports. Deterministic services calculate metrics and test alternative explanations through defined analysis operations. The agent cannot set metric values or verification results.

Faultline records separate answers to these questions:

- Does the evidence show an association?
- Did the controlled test reproduce the mechanism?
- Did the controlled test validate the candidate correction?
- Are the inputs still current?

A controlled test can establish a mechanism within its test scope. It does not establish how much of the total conversion decrease that mechanism caused. The causal effect across the business remains not established.

## V1 investigation procedure

1. Set up the owner account.
2. Set up the team.
3. Create a case.
4. Import CSV, JSON, or JSONL files, or collect authorized existing PostHog exports or GitHub changes.
5. Review the source mappings.
6. Review the data coverage.
7. Review the privacy requirements.
8. Freeze the metric definition.
9. Compare the cohorts and the traffic mix.
10. Examine the evidence and the competing hypotheses.
11. Run analysis tests that can disprove the hypotheses.
12. Authorize the staging scope and deployment provenance.
13. Approve the immutable test plan.
14. Run the mechanism test with the known-good and incident arms.
15. Register a candidate correction.
16. Run the correction test with all three arms and all controls.
17. Review the report.
18. Publish the report.
19. Export the report.
20. Measure the follow-up results.
21. Close or reopen the case.

An arm is one implementation in a controlled comparison. The mechanism test compares the known-good and incident implementations. The correction test adds the candidate implementation. Each test requires its own approval.

## Other V1 functions

V1 includes these functions:

- Persistent jobs and reconnection.
- Job cancellation, continuation, and retries.
- Limits on investigation work and resource use.
- Member roles.
- Evidence correction and withdrawal.
- Indicators for stale reports.
- Comments and activity records within the authorized scope.
- Data retention controls and private artifacts.
- Backup, restore, and operator recovery.

V1 does not include these functions:

- Billing or a marketplace.
- A general application or coding agent.
- Unrestricted shell access.
- Autonomous changes to production systems.

## System components

The system uses these components:

- Node 24, TypeScript, and pnpm.
- React and Vite.
- Fastify.
- PostgreSQL 17, Drizzle, and pg-boss.
- Better Auth.
- An AI case agent connected to Ollama or a compatible model endpoint.
- Private filesystem storage for evidence by default.

The AI case agent uses the configured model endpoint to propose the next investigation steps. Each proposed action follows the system's approval and resource limits.

Browser tests use a separate, isolated runner with a limited set of actions. The native local fixture profile has different isolation requirements from the production profile for external sites.

The system does not require Redis, Kafka, Kubernetes, a vector database, a Python service, or a large agent framework.

## Example investigations

The regression dataset has a conversion rate decrease from 20% to 11%. The decrease occurs mainly in the mobile cohort.

The counterexample dataset has an overall conversion rate decrease from 34% to 16%. The conversion rate for each device stays the same. Adjustment to the baseline traffic mix gives 34%.

These fixed expectations test whether Faultline examines alternative explanations. A release alone does not prove the cause of a conversion decrease.

## Development

```sh
pnpm typecheck
pnpm build
```

## Tests

```sh
pnpm test
```

The default suite covers the agent, metrics, imports, evidence, permissions, reports, recovery and UI behavior. Related checks share feature-level suites and fixtures. It uses synthetic data and requires no database, browser or external account.

```sh
pnpm test:integration
```

Database checks run sequentially against an initialized, disposable local PostgreSQL installation. Configure its restricted roles and private `.env.local`/`.env.ops` files first. Missing configuration fails before tests run.

Use `pnpm run test --suite=browser` for the controlled browser fixtures, or `pnpm run test --suite=hosting` for deployment packaging and private runtime checks. Browser fixtures use Microsoft Edge on Windows and Chromium elsewhere, through Playwright. Signup, Supabase and recovery rehearsals are separate opt-in profiles in the same runner; they require their specific setup.
