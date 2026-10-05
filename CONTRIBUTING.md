# Contributing

## Setup

You need Node 24, pnpm 11 (Corepack picks the version in `package.json`) and Docker.

```bash
pnpm install
pnpm dev        # Postgres and DynamoDB Local in Docker, migrations, seed data, every app
```

The seed signs you in as `owner@example.com` with the password `galena-local-owner`, locally
only. Background tasks need a trigger.dev project: put its ref in `apps/workers/.env` as
`GLN_TRIGGER_PROJECT_REF` and run `pnpm trigger:dev` in another terminal.

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm check` | Biome, oxlint, TypeScript, unit tests and dependency rules. Run it before every commit. |
| `pnpm test:int` | Integration tests against Postgres and DynamoDB Local in Testcontainers |
| `pnpm test:e2e` | Playwright and axe against local dev, in light and dark |
| `pnpm check:page` | The status page's JavaScript and HTML budgets, Lighthouse and axe |
| `pnpm replay` | The detection rules against recorded check results |
| `pnpm infra:synth` | CDK synth with cdk-nag |

## Ground rules

- **The status page is static.** Visitors only ever load files from S3; the subscribe form is the
  one request that reaches the API, and it fails gracefully.
- **The hot path stays isolated.** `apps/probe` and `apps/evaluator` never touch Postgres and
  call trigger.dev only when a monitor changes state.
- **Everything retryable is idempotent.** Every trigger, send and write that can repeat carries
  a deterministic key.
- **`packages/core` is pure.** No I/O, no clock, no environment; pass ports in. Write its tests
  first, with fast-check for state machines.
- **No NAT gateway and no Lambda in a VPC.** Aurora is reached through the RDS Data API.
- **Secrets never appear** in code, logs or error messages, and every outbound URL passes the
  SSRF guard in `packages/integrations/src/net/ssrf.ts`.

## Commits and pull requests

- Conventional Commits with the package as scope: `feat(evaluator): add flap damping`.
- Small commits; a body only when the reason isn't clear from the subject.
- One pull request per area of change, saying what changed and how you checked it.
