# Galena

An open-source status page that you deploy into your own AWS account. Probes in three AWS
regions check your HTTP endpoints every minute, an evaluator decides when something is really
down, and a static status page keeps serving when everything else is not.

> **Early development.** Nothing is released yet. See [What works today](#what-works-today).

## How it works

- **Probes.** A Lambda in each of three regions checks every monitor once a minute and reports
  to an SQS FIFO queue. Every request passes an SSRF guard, and each result carries DNS, connect,
  TLS and time-to-first-byte timings.
- **Evaluator.** A Lambda reads results in order per monitor and runs the detection rules. A
  monitor goes down only when enough regions agree, and single failed checks don't count. Silent
  or broken probe regions leave the vote, and a monitor that keeps flipping is marked flapping.
  State lives in DynamoDB, and each state change is handed to trigger.dev exactly once.
- **Dashboard and API.** A Next.js static export on S3 and CloudFront, and a Hono API on Lambda.
  The API uses Aurora Serverless v2, which scales to zero, through the RDS Data API. The API
  enforces access; the dashboard holds no secrets.
- **Workflows** *(planned)*. trigger.dev tasks draft incidents from monitor changes and publish
  them, either automatically, after a person approves, or never, depending on the monitor's
  policy. They also notify subscribers.
- **Status page** *(planned)*. Static files on S3 and CloudFront. Visitors never reach the API or
  the database, so the page stays up when they are down.

## What works today

- Sign-in with email, password and TOTP two-factor, or GitHub when an OAuth app is configured.
  First-run owner setup and roles (owner, admin, editor, viewer).
- Components and groups: create, reorder and delete.
- HTTP monitors: create, edit, pause and delete, each with its own publish policy.
- The probe and evaluator Lambdas, tested locally and against DynamoDB Local.
- AWS CDK stacks for the deploy role, the stateful core (VPC, Aurora, DynamoDB, SQS), the API
  and the dashboard.

Not built yet: deploying the probes, publishing `monitors.json`, incidents, maintenance
windows, the public status page, notifications and the deploy pipeline.

## Requirements

- Node.js 24
- pnpm 11 (`corepack enable` picks up the version from `package.json`)
- Docker, for the local databases and the integration tests
- Google Chrome, for the end-to-end tests

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres 16 and DynamoDB Local in Docker, applies the migrations, seeds a local
workspace and runs:

- the dashboard on <http://localhost:3000>
- the API on <http://localhost:8787>

Sign in with `owner@example.com` and `galena-local-owner`. This seed account exists only in
local databases.

To allow sign-in with GitHub locally, set `GLN_GITHUB_CLIENT_ID` and `GLN_GITHUB_CLIENT_SECRET`
in `apps/api/.env`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Lint, typecheck, unit tests and import-boundary rules. Run it before every commit. |
| `pnpm test` | Unit tests only |
| `pnpm test:int` | Integration tests against throwaway Postgres and DynamoDB Local containers |
| `pnpm test:e2e` | Playwright and axe against the local app, in light and dark mode |
| `pnpm replay` | Replays recorded outage scenarios through the detection rules |
| `pnpm db:generate` | Generates a migration after a schema change |
| `pnpm db:migrate` | Applies migrations to the local database |
| `pnpm api:generate` | Regenerates `openapi.json` and the dashboard's typed client after a route change |
| `pnpm infra:synth` | Synthesizes the CDK app and runs cdk-nag |

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/api` | Hono API: auth, components, monitors, OpenAPI document |
| `apps/web` | Next.js dashboard, exported as static files |
| `apps/probe` | Probe Lambda: runs the checks in each region |
| `apps/evaluator` | Evaluator Lambda: turns check results into monitor state |
| `apps/workers` | trigger.dev tasks |
| `packages/contracts` | Zod schemas and types shared by every app |
| `packages/core` | Domain logic without I/O: detection, status roll-up, roles |
| `packages/db` | Drizzle schema, migrations, repositories |
| `packages/integrations` | SSRF guard, HTTP checker, config loading |
| `packages/ui` | Design tokens |
| `infra` | AWS CDK app |

## Tests

- **Unit tests** sit next to the code (`*.test.ts`) and need no network or Docker. Detection is
  covered by example scenarios, fast-check property tests (10,000 random runs each) and
  hand-worked replay scenarios in `test/fixtures/replay`.
- **Integration tests** (`*.int.test.ts`) run against Postgres 16 in Testcontainers and against
  DynamoDB Local.
- **End-to-end tests** (`apps/web/e2e`) drive the dashboard in Chrome and check accessibility
  (WCAG 2.2 AA) in light and dark mode.

## License

[MIT](LICENSE)
