# CRE Transaction Portal

A neutral, per-deal workspace for executing a commercial property purchase — every
party (buyer, seller, both agents, both attorneys, lender, title, third-party
contributors) is a first-class member of one shared workspace, with scoped
communication, a versioned + permissioned document room, and an append-only
audit trail, over a fixed milestone backbone.

Built as **six microservices** (Accounts, Deals, Chat, Documents, Notifications,
Audit) behind one API gateway, async over an EventBridge bus. See
[`docs/`](docs/):

- [`01-problem-exploration.md`](docs/01-problem-exploration.md) — why this problem
- [`02-design.md`](docs/02-design.md) — architecture, data model, decisions
- [`03-prompt-log.md`](docs/03-prompt-log.md) — how it was built
- [`architecture.drawio`](docs/architecture.drawio) — editable diagram

## Repository layout

| Path | What |
|---|---|
| `packages/authz` | `@cre/authz` — pure capability + scope library, bundled into every service |
| `packages/events` | `@cre/events` — `zod` schemas + types for every domain event (the cross-service contract) |
| `packages/platform` | `@cre/platform` — shared runtime helpers (DynamoDB, EventBridge, HTTP adapter, logging) |
| `services/*` | the six service Lambdas *(added per module)* |
| `web/` | React + Vite single-page app |
| `infra/` | AWS CDK v2 app — `SharedStack` + one stack per service |

## Prerequisites

- Node 22+ (`.node-version` pins 24)
- pnpm 9 (`corepack enable pnpm`)
- For deploy: AWS credentials for the target project (`aws login`), region `us-east-2`

## Commands

```sh
pnpm install
pnpm -r test        # unit + contract tests across the workspace
pnpm -r typecheck
pnpm lint
pnpm --filter infra synth      # synthesize CloudFormation
pnpm --filter web dev          # run the SPA locally
```

## Status

Under construction, one module per commit — see `docs/03-prompt-log.md` and the
project plan. Current: **Module 1 — scaffold** (monorepo, shared-package
skeletons, web shell, empty CDK `SharedStack`).
