# CRE Transaction Portal

A neutral, per-deal workspace for executing a commercial property purchase. Every
party — buyer, seller, both agents, both attorneys, lender, title, and
third-party contributors (`OTHER`) — is a first-class member of **one shared
workspace**, with:

- **scoped communication** — threads at deal-wide / side-private / agent-channel
  / attorney-channel visibility, with @mentions and per-recipient read receipts;
- **a versioned, permissioned document room** — role→category visibility matrix,
  short-lived presigned URLs, one-way promotion of side-private docs to
  deal-wide, and a document-request workflow;
- **an append-only audit trail** — who disclosed / saw / changed what, and when,
  with **no god view** (not even the admin sees the other side's private
  entries), CSV / JSON export;
- **a 6-stage milestone backbone** with a **dual-approval "handshake"** for the
  irreversible actions (advance a stage, edit the price, delete a document,
  close/cancel once the deal is firm);
- **an in-app notification centre** (bell + unread count), with action-required
  email wired but flag-gated off (see [Known gaps](#known-gaps)).

## Architecture

**Six microservices** — Accounts, Deals, Chat, Documents, Notifications, Audit —
behind **one** API Gateway HTTP API, communicating asynchronously over a single
EventBridge bus (`cre-portal-bus`) with an **SQS queue + DLQ per consumer**. One
DynamoDB table per service; no service reads another's table — cross-domain data
arrives as events and is kept in small local projections. A React + Vite SPA on
S3 + CloudFront, Cognito for auth. Everything regional in **`us-east-2`**; IaC is
**AWS CDK v2 (TypeScript)**, one stack per service plus a `SharedStack`.

Full design, data model, and the "alternatives considered" for each decision:
[`docs/02-design.md`](docs/02-design.md) (see **§17 As-built notes** for where
the implementation diverged from the design).

- [`docs/01-problem-exploration.md`](docs/01-problem-exploration.md) — the problems considered, why this one
- [`docs/02-design.md`](docs/02-design.md) — architecture, data model, permission model, API surface, flows, cost
- [`docs/03-prompt-log.md`](docs/03-prompt-log.md) — the prompts that built it, with context + outcome per module
- [`docs/architecture.drawio`](docs/architecture.drawio) — editable diagram

## Live environment

Deployed to AWS project `581759697181` / `us-east-2`:

| | URL |
|---|---|
| SPA | https://d2nvvjs357ot5x.cloudfront.net |
| API | https://d1016hsgh5.execute-api.us-east-2.amazonaws.com |
| Hosted UI (sign-in) | https://cre-portal-581759697181.auth.us-east-2.amazoncognito.com |

`node scripts/seed.mjs` provisions a fully-populated sample deal and prints a
login for every role (shared password) plus the deep link to the deal.

## Repository layout

| Path | What |
|---|---|
| `packages/authz` | `@cre/authz` — pure capability matrix + scope model + the role→document-category matrix (tested in isolation) |
| `packages/events` | `@cre/events` — `zod` schemas + types for every domain event (the cross-service contract) |
| `packages/platform` | `@cre/platform` — shared runtime helpers: DynamoDB client, EventBridge publisher, HTTP-adapter/router, structured logging, the `MEMBERVIEW#` projection helper |
| `services/{accounts,deals,chat,documents,notifications,audit}` | the six service Lambdas — each an API handler + (from Chat on) an SQS-triggered event consumer |
| `web/` | React + Vite single-page app |
| `infra/` | AWS CDK v2 app — `SharedStack` + `AccountsStack` + one stack per service |
| `scripts/` | `sync-config.mjs` (SPA config from stack outputs), `seed.mjs`, `verify.mjs`, `lib/portal.mjs` |
| `docs/` | problem exploration, design doc, prompt log, diagram |

## Prerequisites

- **Node 22+**, **pnpm 9** (`corepack enable pnpm`)
- **AWS CLI v2**, authenticated for the target project (`aws login`), region `us-east-2`
- For `cdk deploy`: a bootstrapped environment (`pnpm --filter infra exec cdk bootstrap aws://<account>/us-east-2`)

## Develop

```sh
pnpm install
pnpm -r typecheck                       # every workspace package
pnpm -r test                            # unit + contract + CDK-assertion tests
pnpm lint
pnpm --filter infra exec cdk synth --strict -q
pnpm --filter web dev                   # SPA against the deployed API
```

## Deploy

```sh
# 1. all stacks (order is enforced by stack dependencies)
pnpm --filter infra exec cdk deploy --all --require-approval never \
  --outputs-file infra/cdk-outputs.json

# 2. point the SPA at the freshly-deployed identifiers, build, upload, invalidate
node scripts/sync-config.mjs
pnpm --filter web build
aws s3 sync web/dist "s3://$(aws ssm get-parameter --region us-east-2 \
  --name /cre-portal/shared/web-bucket-name --query Parameter.Value --output text)" --delete
aws cloudfront create-invalidation --distribution-id "$(aws ssm get-parameter \
  --region us-east-2 --name /cre-portal/shared/distribution-id --query Parameter.Value --output text)" \
  --paths '/*'
```

Individual stacks: `pnpm --filter infra exec cdk deploy CrePortalDocuments`.

## Seed & verify (against the deployed stack)

```sh
node scripts/seed.mjs      # one populated sample deal; prints logins + the deal URL
node scripts/verify.mjs    # the design §14 acceptance checklist, end-to-end; self-cleaning
```

Both resolve the stack's identifiers from SSM Parameter Store, drive Cognito
(sign-up → confirm → password auth) and the edge API, and (seed) upload document
bytes straight to S3 via presigned `PUT`. `seed.mjs` is idempotent — it deletes
and recreates its fixed-address users each run. Its output is also written to
`scripts/seed-output.json` (git-ignored — it contains the demo logins).

## Known gaps

Deliberate scope cuts for the prototype — the full list with rationale is in
[`docs/02-design.md` §16 (Future work)](docs/02-design.md) and §17 (As-built):

- **Email is disabled.** The Notifications service has the SESv2 dispatch path
  (invitations + action-required), unit-tested behind a mock and IAM-granted, but
  it is a no-op unless `NOTIFY_EMAIL_FROM` is set — no SES sender identity is
  verified in the demo project, and the SES sandbox only delivers to verified
  addresses. Invitations therefore travel as the link the API returns
  (`acceptUrl`), which the SPA shows for the inviter to share.
- **Auth is minimal for a prototype:** `react-oidc-context` + `oidc-client-ts`
  (auth-code + PKCE), no MFA, tokens in `localStorage`. The design doc argues
  AWS Amplify Auth is the right production choice; `USER_PASSWORD_AUTH` is
  enabled on the app client only so the seed/verify scripts can authenticate.
- **Short polling** (3–30 s) instead of WebSockets/AppSync.
- **No in-app bidding / pre-contract stages** — a deal starts at an accepted
  offer.
- **Payments are recorded, not processed.** Module 11 (stretch) adds a
  confirmation-handshake-gated payment ledger on each deal (earnest money,
  deposits, closing funds); the portal never moves money and does no payer
  identity verification. Wire-fraud prevention and deadline/contingency
  automation remain named as the next problems to tackle, not built.

## Build history

Built in reviewable modules, one commit each — ten core modules plus Module 11
(payments, stretch) — see [`docs/03-prompt-log.md`](docs/03-prompt-log.md) for
the prompt, context, and outcome of each. Every module ends green
(`pnpm -r test`, `pnpm lint`, `cdk synth --strict`) and was deployed +
E2E-verified against the live stack.
