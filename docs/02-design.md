# CRE Transaction Portal — Design Document

## 1. Overview

A neutral, per-deal web portal for executing a commercial property purchase.
Every party to the transaction — buyer, seller, both agents, both attorneys,
lender, title/escrow, and third-party contributors like inspectors — is a
first-class member of one shared workspace, rather than a guest on somebody
else's brokerage or title system.

The portal provides three things over a fixed milestone backbone:

1. **A single source of truth** — scoped, threaded communication per deal.
2. **A document room** — versioned, permissioned, with document requests.
3. **An append-only audit trail** — who did / saw / changed what, and when.

It also adds a **dual-approval ("handshake") workflow** so that irreversible or
bilateral actions (advancing a stage, deleting a document, changing price) can't
be done unilaterally once the deal is firm.

The system is built as **six independently deployed microservices** — Accounts,
Deals, Chat, Documents, Notifications, Audit — behind a single API gateway,
communicating asynchronously over an EventBridge bus, each owning its own
DynamoDB table (see [§7](#7-architecture)).

See `docs/01-problem-exploration.md` for why this problem was chosen.

## 2. Goals and non-goals

### Goals (V1)

- One workspace per deal; all parties first-class; server-enforced role- and
  scope-based access.
- The standard commercial purchase pipeline as a guided, forward-only sequence
  of stages with per-stage checklists.
- Threaded messaging with four visibility scopes and delivery/read receipts.
- A document room with explicit versioning, scoped access, promotion of
  side-private documents to deal-wide, and a document-request workflow.
- A complete, scoped, exportable audit trail.
- An in-app notification centre; email only for invitations and
  "action-required" events.
- Real authentication; deployed to AWS; runs on seed data with no external
  integrations.

### Non-goals (V1)

- No wire/payment handling or identity verification (problem 1).
- No deadline/contingency automation or reminders (problem 5) — checklists are
  manual.
- No in-app bidding or pre-contract sourcing; a deal starts at an accepted offer.
- No e-signature, no MLS/title/lender integrations, no real-time push, no
  multi-tenant billing, no mobile app.
- Single region, US/English, USD only.

Full deferred list in [§13 Future work](#13-future-work).

## 3. Users and roles

| Role | Side | Notes |
|---|---|---|
| `SELLER_AGENT` | sell | Deal creator and **sole admin**. |
| `SELLER` | sell | Principal. |
| `SELLER_ATTORNEY` | sell | |
| `BUYER` | buy | Buy-side **handshake lead** — either the buyer or the buyer's agent can act. |
| `BUYER_AGENT` | buy | Buy-side **handshake lead**; can invite other buy-side members (within limits). |
| `BUYER_ATTORNEY` | buy | |
| `LENDER` | buy | Full buy-side member; not a handshake lead; cannot invite/remove. |
| `TITLE_AGENT` | neutral | Deal-wide only; never in side-private threads/docs or channels; not in handshakes; invited by admin only. |
| `OTHER` | assigned on invite | Third-party contributor (inspector, appraiser, consultant). Reads deal-wide; reads/posts/uploads **only** within its own side's private scope; no deal-wide posting, no cross-side channels. |

**Buy-side roster limits:** ≤ 2 agents, ≤ 2 attorneys, ≤ 7 buy-side members
total (all roles, including `LENDER` and `OTHER`, count toward 7).

**Registration:** the selling side self-registers through open sign-up. Everyone
else joins strictly by email invitation. The first self-registered user on a
deal is its admin.

## 4. Core concepts

- **Deal** — one accepted offer on one property. Has lifecycle `status`
  (`ACTIVE` → `CLOSED` | `CANCELLED`) which is orthogonal to milestone progress.
  On `CLOSED`/`CANCELLED` the workspace is read-only but fully viewable — it
  becomes the permanent record.
- **Milestone pipeline** (forward-only, one step at a time, no regression in V1):
  1. **Offer Accepted / PSA Negotiation** — attorneys draft & negotiate the
     binding PSA; signing + earnest-money deposit puts the property under
     contract.
  2. **Attorney Review** — counsel finalizes contract language; either side may
     still walk. **Completing this flips the deal's `firm` flag.**
  3. **Due Diligence** — PCA, Phase I/II environmental, zoning, leases &
     estoppels, service contracts, financials. Buyer can terminate and recover
     the deposit before the DD deadline.
  4. **Financing** — loan application, lender appraisal, underwriting,
     clear-to-close.
  5. **Title & Survey** — title commitment + ALTA survey; cure or insure over
     exceptions.
  6. **Closing** — settlement statements, funds + loan wired to escrow, deed
     executed & recorded; post-closing items.
- **`firm`** — true once Attorney Review is completed. Drives which actions
  require a handshake.
- **Membership** — `(user, deal, role, side, status)`; `status` ∈ `invited` /
  `active` / `removed`. Removal is soft; the member's past messages and uploads
  stay attributed.
- **Visibility scope** — the axis that controls who can see a thread, document,
  or audit entry:
  - `deal_wide` — all active members;
  - `side_private:buy` / `side_private:sell` — one side (includes that side's
    `OTHER`);
  - `channel:agent` — the two agents only;
  - `channel:attorney` — the two attorneys only.
- **Handshake** — a pending dual-approval request between the sell-side **admin**
  and a **buy-side lead** (`BUYER` or `BUYER_AGENT` — either may act, and one
  approval from the buy side suffices; `LENDER` is never an approver). Either
  side may initiate; the counterparty approves (the action then executes) or
  rejects with an optional reason (dropped; re-proposable). Every step is
  audited.

## 5. Feature specification

### 5.1 Accounts

Cognito-backed sign-up/login (hosted UI). Profile: name, email, company,
industry role, phone. A Cognito post-confirmation trigger writes the user's
profile record. On login the app looks up pending invitations by the user's
email and offers to accept them.

### 5.2 Deal workspace

Create a deal (address, property type ∈ {office, retail, industrial,
multifamily, land, residential}, optional label, accepted purchase price,
optional earnest-money amount, target closing date, description). Dashboard:
milestone progress, activity feed, member list, closing countdown. "My deals"
list.

**Field edits:** address/type/label/description → admin. **Purchase price** →
handshake, always. **Dates** (closing date, per-stage target dates) → admin
unilaterally while not firm; handshake once firm. **Status** `CLOSED`/`CANCELLED`
→ admin unilaterally while in or before Attorney Review; handshake once firm
(reason recorded to audit).

### 5.3 Parties & membership

Invite by email + role. Invitation → SES email → sign-up/login → join. Pending
invites are revoke-able. Sell-side roster + `TITLE_AGENT` are managed by the
admin. The **admin also bootstraps the buy side** — there is no buy-side lead
until a `BUYER` / `BUYER_AGENT` joins, so the admin sends that first
invitation; from then on `BUYER` / `BUYER_AGENT` manage the rest of the buy-side
roster, always within the §3 limits. `OTHER` is invited by the lead of the side
bringing them. Neither side can remove the other's people, and the deal creator
can be neither removed nor re-roled.

For the prototype (SES email lands in Module 9), `POST …/invites` returns the
`{ token, acceptUrl }` in its response so the inviter — or the seed script — can
share the link directly; in production the token would travel only by email.

### 5.4 Handshake (dual approval)

The two approvers are the sell-side **admin** (`SELLER_AGENT`) and a **buy-side
lead** — the `BUYER` *or* the `BUYER_AGENT`; one approval per side is enough, so
the agent can carry the process on the buyer's instruction. Gated actions:

| Action | Rule |
|---|---|
| Advance a milestone | Always handshake (either side initiates) |
| Delete / archive a document | Always handshake |
| Edit purchase price | Always handshake |
| Edit dates (closing, stage targets) | Admin unilaterally pre-firm; handshake once firm |
| Close / cancel the deal | Admin unilaterally in/before Attorney Review; handshake once firm |

Rejections carry an optional reason and drop the request; it can be re-proposed.
Milestone **regression is blocked entirely** in V1.

### 5.5 Communication

Threads scoped to a deal: subject, one of the four visibility scopes (set at
creation), optional stage tag, messages.

- **Create:** any active member for a scope they belong to; `OTHER` may create
  `side_private` only.
- **Channel → side-private conversion:** an `channel:agent` thread can be
  promoted to `side_private` by either agent — it moves to *that agent's* side,
  pulls in the whole side, and drops the other side's agent. Same for
  `channel:attorney` by either attorney. History retained; audited; the dropped
  party is notified. No other conversions in V1.
- **Messages:** text, @mentions of members, attach/reference a document. Edit and
  delete are **soft** — "edited" / "message removed" markers; original content
  retained in the audit log.
- **Unread counts:** per-user, per-thread last-read marker.
- **Delivery status** (shown to the sender, with a per-recipient detail view):
  - **sent** — persisted server-side;
  - **received** — every recipient's client has fetched it;
  - **read** — every recipient has opened the thread.
  Recipient set is frozen at send time. Stored as per-recipient receipt records;
  this is derived UI state, not audit content.
- **Activity feed:** per-deal, merges visible thread messages with system events
  (uploads, stage changes, joins, handshakes).

### 5.6 Document room

Upload: file + category ∈ {Purchase Agreement, Disclosure, Inspection, Title,
Financing, Appraisal, Closing, Other} + title + description + optional stage tag.

- **Visibility scope per document:** `deal_wide` or `side_private`. A
  side-private document can be **promoted to deal-wide** (one-way, by a non-`OTHER`
  member of that side, audited). `OTHER` uploads into its own side's private
  scope.
- **Versioning:** upload a new version; a "current version" pointer; full
  history (who/when); download any version.
- **Access** = visibility scope **+** a role→category matrix, enforced
  server-side. Downloads and in-app views/previews are served by short-lived
  presigned S3 URLs; each issue is logged.
- **Delete/archive:** soft and handshake-gated.
- No per-document custom sharing in V1.

**Document requests:** a member requests a document — category, note, target (a
specific member *or* a role; any holder of that role may fulfil), optional due
date, optional stage tag, scope. States: `open` → `fulfilled` (links the
uploaded document) / `declined` (with reason) / `cancelled` (by the requester).
Notifications on create and resolve; every transition audited.

### 5.7 Milestones & checklists

Each stage has a status (`not_started` / `in_progress` / `completed`), an
optional target date, notes, and a **checklist**. Checklist items are seeded from
a per-stage template and can be added/removed; fields: title, optional assignee,
optional due date, done flag, done-by/at. Any active non-`OTHER` member can
check/uncheck; audited. **Checklists are guidance, not a hard gate** on
advancing (advancing is the handshake). Advancing marks the current stage
`completed` and the next `in_progress`.

### 5.8 Audit trail

Append-only; no update/delete code paths. Each entry: id, deal, actor, action,
target (type + id), timestamp, scope, metadata (old→new values, reason text).

Logged actions: deal created / terms edited / status changed; member invited /
joined / role changed / removed; handshake requested / approved / rejected;
milestone advanced; checklist item added / checked / unchecked; thread created /
scope converted; message posted / edited / deleted; document uploaded / new
version / promoted / opened / previewed / downloaded / deleted; document request
created / fulfilled / declined / cancelled.

**Visibility:** each member sees only entries within their own scope (deal-wide
always; their side's private; channels they're in). **No god view — not even the
admin** sees the other side's private entries or private content. Filter by
actor / action / date / target; export CSV/JSON of what you can see.

### 5.9 Notifications

In-app centre (bell + unread count). Types: invited to a deal; a handshake needs
your approval; your handshake approved/rejected; @mention; a document request
assigned to you (by name or role); your document request fulfilled/declined;
milestone advanced; deal closed/cancelled; a private thread you were in was
converted (you were dropped). Each links to its target; mark one/all read.

Plain messages raise unread counts only — no notification. @mentions notify.

**Email (SESv2):** invitations always; plus "action required" — a handshake or a
document request assigned to you. Nothing else emails. The dispatch path is
implemented and unit-tested behind a mock, but **gated off** (`NOTIFY_EMAIL_FROM`
unset) — no SES sender identity is verified in the demo project, and the SES
sandbox only delivers to verified addresses. Enabling it in production is
verifying a domain and setting the env var; no code change. Per-user
notification preferences are V2.

## 6. Permission & visibility model

Two cooperating modules, both unit-tested, both enforced **server-side on every
endpoint** (the UI additionally hides disallowed actions):

- **`packages/authz` — `can(role, action, context) → boolean`** capability
  matrix. `context` carries `{ isAdmin, isFirm, currentStage, side, limits }`.
- **`packages/authz` — `visibleScopes(membership) → Set<Scope>`** and
  **`canSee(membership, resourceScope) → boolean`**, used to filter every list
  endpoint (threads, documents, audit) and to authorize every fetch.

`packages/authz` is a **pure-function library with no I/O**, bundled into every
service. Each service that enforces authorization keeps a **local `memberships`
projection** (its own table, updated from Deals' `member.*` events), so an authz
check is a local read + pure function — never a cross-service call. Trade-off: a
few-seconds eventual-consistency window after a membership change; see
[§11](#11-security-considerations).

### Capability matrix (V1)

| Action | Who |
|---|---|
| Create a deal | Any self-registered user → becomes `SELLER_AGENT` + admin |
| Edit deal fields (address/type/label/desc) | Admin |
| Edit purchase price | Handshake |
| Edit dates (closing, stage targets) | Admin pre-firm → handshake once firm |
| Close / cancel deal | Admin in/before Attorney Review → handshake once firm |
| Advance milestone | Handshake, either side initiates |
| Checklist items (add/check/uncheck) | Any active non-`OTHER` member |
| Invite sell-side + `TITLE_AGENT` | Admin |
| Invite buy-side | Admin (to bootstrap the side) or `BUYER` / `BUYER_AGENT`, within limits |
| Invite `OTHER` | Lead of the side bringing them |
| Remove a member | Managing side of that member only |
| Create deal-wide thread / upload deal-wide doc | Any active non-`OTHER` |
| Create side-private thread / upload side-private doc | Any active member of that side (incl. `OTHER`) |
| Agent / attorney channel thread | The two agents / the two attorneys |
| Convert channel → side-private | The agent/attorney of the receiving side |
| Post message | Any participant of the thread's scope (`OTHER` only in side-private it can see) |
| Promote side-private doc → deal-wide | Non-`OTHER` member of that side |
| Delete / archive a document | Handshake |
| Create doc request | Any active non-`OTHER` |
| Fulfil doc request | Named member, or any holder of the named role |
| Decline / cancel doc request | The member/role holder / the requester |
| View & export audit | Own scope only; no god view |

### Role → document-category visibility (starting matrix)

| Category | Buy-side | Sell-side | `TITLE_AGENT` | `LENDER` | `OTHER` |
|---|---|---|---|---|---|
| Purchase Agreement | ✓ | ✓ | ✓ | ✓ | scope-only |
| Disclosure | ✓ | ✓ | ✓ | ✓ | scope-only |
| Inspection | ✓ | ✓ (if deal-wide) | – | – | scope-only |
| Title | ✓ | ✓ | ✓ | ✓ | scope-only |
| Financing | ✓ | – | – | ✓ | scope-only |
| Appraisal | ✓ | – | – | ✓ | scope-only |
| Closing | ✓ | ✓ | ✓ | ✓ | scope-only |
| Other | ✓ | ✓ | ✓ | ✓ | scope-only |

"scope-only" = visible to `OTHER` only if the document is in that `OTHER`'s own
side-private scope. Effective visibility is always the **intersection** of
scope and category rules.

## 7. Architecture

### 7.1 Topology

Editable diagram: [`docs/architecture.drawio`](architecture.drawio) (open in
[diagrams.net](https://app.diagrams.net)). Rendered overview:

```mermaid
flowchart LR
  browser["React SPA (browser)"]
  cf["CloudFront"]
  s3web["S3 web bucket"]
  cognito["Cognito<br/>Hosted UI + User Pool"]
  apigw["API Gateway HTTP API<br/>JWT authorizer · path routing"]
  s3docs[("S3 documents bucket")]
  ses["Amazon SES"]
  bus{{"EventBridge bus: cre-portal-bus"}}
  sqs["SQS + DLQ<br/>per consumer"]

  subgraph svc["Microservices — Lambda (us-east-2)"]
    acc["Accounts"]
    deal["Deals<br/>deal · membership · milestones · handshake"]
    chat["Chat"]
    doc["Documents"]
    notif["Notifications"]
    aud["Audit"]
  end

  subgraph data["DynamoDB — one table per service"]
    t1[("accounts")]
    t2[("deals")]
    t3[("chat")]
    t4[("documents")]
    t5[("notifications")]
    t6[("audit — append-only")]
  end

  browser --> cf --> s3web
  browser -->|"/v1/* + JWT"| apigw
  browser -->|login| cognito
  apigw -.->|authorize| cognito
  cognito -.->|post-confirm trigger| acc
  apigw --> acc & deal & chat & doc & notif & aud
  acc --> t1
  deal --> t2
  chat --> t3
  doc --> t4
  doc -->|presigned| s3docs
  notif --> t5
  aud --> t6
  notif -->|email| ses
  acc & deal & chat & doc & notif & aud -.->|publish| bus
  bus -.-> sqs
  sqs -.-> chat & doc & notif & aud
  bus -.->|document.archived| deal
```

Path routing (most-specific first): `/v1/deals/{id}/threads/*` → Chat,
`/v1/deals/{id}/documents/*` and `/doc-requests/*` → Documents,
`/v1/deals/{id}/audit*` → Audit, `/v1/notifications/*` → Notifications,
`/v1/me` → Accounts, everything else under `/v1/deals/*` → Deals.

EventBridge rules: Audit matches every event (source prefix `cre.`);
Notifications matches a fixed detail-type list (`member.*`, `account.created`,
`handshake.*`, `message.posted`, `docrequest.*`, `stage.advanced`,
`deal.status_changed`, `thread.converted`) across sources; Chat and Documents
match `member.*` (projection upkeep); Documents also `handshake.approved`
(delete saga); Deals matches `document.delete_requested` (opens the delete
handshake) and `document.archived` (closes the saga). SESv2 sends invitation and
action-required email when enabled.

Everything regional is in **`us-east-2`**; CloudFront is global. IaC is **AWS
CDK v2 (TypeScript)** — one stack per service plus a `SharedStack`.

### 7.2 The six services

Each service = its own Lambda(s), its own DynamoDB table, its own IAM role
(least privilege), its own API routes, its own EventBridge rule + SQS queue +
DLQ. No service reads another's table; cross-domain data arrives as events.

| Service | Owns | Publishes | Consumes |
|---|---|---|---|
| **Accounts** | user profiles; **the Cognito user pool + app client + hosted-UI domain + post-confirmation trigger + the shared JWT authorizer** (exported via SSM) | `account.created` | — |
| **Deals** | deal record + status; membership + invitations; milestones (stages, checklists); handshake state machine | `deal.created`, `deal.updated`, `deal.status_changed`, `member.invited`, `member.joined`, `member.role_changed`, `member.removed`, `stage.advanced`, `handshake.requested`, `handshake.approved`, `handshake.rejected` | `document.delete_requested` (opens the delete handshake), `document.archived` (closes the saga) |
| **Chat** | threads, messages, receipts, read markers; local `memberships` projection | `message.posted`, `message.edited`, `message.deleted`, `thread.created`, `thread.converted` | `member.*` |
| **Documents** | documents + versions, document requests; S3 docs bucket; local `memberships` projection | `document.uploaded`, `document.versioned`, `document.promoted`, `document.archived`, `document.accessed`, `document.delete_requested`, `docrequest.created`, `docrequest.fulfilled`, `docrequest.declined`, `docrequest.cancelled` | `member.*`, `handshake.approved` |
| **Notifications** | per-user notification rows (bell + unread) + `MEMBERVIEW#` / `PROFILE#` projections; SESv2 dispatch for invitations + action-required (flag-gated on `NOTIFY_EMAIL_FROM`) | `notification.emailed` | `member.*`, `account.created`, `handshake.*`, `message.posted`, `docrequest.*`, `stage.advanced`, `deal.status_changed`, `thread.converted` (matched by detail-type across sources) |
| **Audit** | append-only `audit` log (`PutItem`-only IAM) + a mutable `audit-membership` projection; scoped read + CSV/JSON export | — | **all** `cre.*` events (source-prefix rule); `member.*` also feed the projection; dealId-less events (`account.created`) are skipped in v1 |

### 7.3 Communication

- **Async — one EventBridge custom bus.** Producers `PutEvents` with
  `{ source: "cre.<service>", "detail-type": "<event>", detail: {...} }`. Each
  consumer has a **rule** with a content-based filter pattern → an **SQS queue**
  (with a redrive DLQ) → its Lambda (event-source mapping, batch size tuned per
  consumer). SQS gives each consumer independent buffering, retry, and redrive;
  EventBridge gives infra-level routing so producers never change when a
  consumer is added.
- **Sync — one public API Gateway HTTP API** at the edge, path-routed to
  per-service Lambdas. The SPA only ever calls this endpoint. There are **no
  service-to-service synchronous calls** on the request path — authorization is
  answered from each service's local `memberships` projection.
- **Event envelope:** every event carries `eventId`, `occurredAt`, `dealId`,
  `actorId`, and a `correlationId` propagated from the originating HTTP request
  (`x-correlation-id` header) through to every downstream Lambda and log line.
- **Idempotency:** consumers are idempotent — Audit and Notifications key on
  `eventId`; projection updaters use conditional writes on a monotonic
  `version`/`occurredAt` so out-of-order `member.*` events converge correctly.

### 7.4 Cross-service consistency

- **Authorization** is eventually consistent: each enforcing service (Chat,
  Documents, Audit) rebuilds a `memberships` view from Deals' `member.*` events.
  Window is seconds. Sensitive one-shot actions (e.g. a just-removed member) are
  additionally guarded by the fact that Deals is the source of truth for the
  action that matters (advancing, deleting) and re-checks on its own data.
- **The handshake is a saga** — see [§10](#10-key-flows). Deal-local effects are
  applied atomically inside the `deals` table; the single cross-service effect
  (archiving a document on a delete-handshake) is choreographed entirely over
  the bus: `document.delete_requested` → Deals opens the handshake →
  `handshake.approved` → Documents archives → `document.archived` → Deals closes
  the saga. No two-phase commit, no synchronous service-to-service call.

### 7.5 Repo & infra

- **pnpm-workspaces monorepo:**
  `services/{accounts,deals,chat,documents,notifications,audit}`,
  `packages/{authz,events,platform}`, `web/`, `infra/`.
  - `packages/events` — TypeScript types + `zod` schemas for every event
    (the contract); producers and consumers both import it.
  - `packages/platform` — DynamoDB doc-client + key helpers, an EventBridge
    publisher, the HTTP handler adapter, structured logging with `correlationId`.
  - `packages/authz` — the pure permission/scope library.
- **CDK:** `SharedStack` (EventBridge bus, the edge API Gateway HTTP API, SES
  sender identity, the SPA's S3 + CloudFront) + one stack per service
  (`AccountsStack`, `DealsStack`, …) wiring that service's Lambda(s), table,
  queue + DLQ, rule, IAM role, and route integrations. **Cognito (user pool +
  app client + hosted-UI domain + post-confirmation trigger) and the shared JWT
  authorizer live in the Accounts stack**, not SharedStack — SharedStack has no
  Cognito dependency, which keeps the stack graph acyclic (SharedStack →
  Accounts → other services). All cross-stack references go through **SSM
  parameters** (`infra/lib/param-names.ts`) so each stack deploys independently.
- **Observability:** structured JSON logs keyed by `correlationId`, propagated
  from the `x-correlation-id` request header through every event's metadata.
  **AWS X-Ray** active tracing on every Lambda (HTTP APIs do not support X-Ray
  active tracing — only REST APIs do — so the API-Gateway hop is covered by
  access logs carrying the correlation id instead). 1-week CloudWatch log
  retention.
- **Local development:** unit tests run locally with no AWS. Integration is a
  **deploy-to-AWS loop** (`cdk deploy <service>` to a dev stack) — no LocalStack.
  Code always lives in the repo and is committed per module.

### 7.6 Alternatives considered

| Decision | Chosen | Alternatives & why not |
|---|---|---|
| **Overall shape** | **6 microservices** | A *modular monolith* (one Lambda + one table, module boundaries in code) is less operational overhead and keeps the handshake a single ACID write — recommended for a prototype on a fixed budget. Chosen against, deliberately, to demonstrate real-world scaling architecture (independent deploy/scale, event-driven decoupling, saga, per-service data). Cost survives because everything is serverless pay-per-use. |
| **Datastore** | **DynamoDB, one table per service** | *Aurora/Postgres per service* fits the relational domain and gives RLS, but our polling app would keep Aurora Serverless v2 from auto-pausing (~$88/mo each × 6) — impossible on a ~$100 budget. DynamoDB on-demand has no per-table floor, so 6 tiny tables are still ~$0. Scope visibility is enforced in `packages/authz` (tested), not RLS. |
| **Async backbone** | **EventBridge bus + SQS-per-consumer (+ DLQ)** | *SNS + SQS fan-out* gives the same per-consumer buffering but coarser (attribute-only) filtering and much more wiring across 6 services. *Kinesis* adds ordered sharded streams we don't need. *EventBridge → Lambda direct* drops the per-consumer buffer/backpressure. The hybrid is what production converges on. |
| **Sync calls** | **None on the request path** (local projections) | A *central authz service* called per request is a hot-path dependency + SPOF. *Membership claims in the JWT* go stale and can't hold many deals. Local projections keep the hot path in-process at the cost of a seconds-long consistency window. |
| **Compute** | **Lambda + one API Gateway HTTP API** | *Fargate/App Runner per service* = always-on cost × 6 + ALB/VPC wiring. *One API Gateway per service* = 6 endpoints for the SPA to juggle. Path-routing one HTTP API to 6 Lambdas is $0-idle and keeps a single origin. |
| **Auth** | **Amazon Cognito user pool + hosted UI** | *Self-rolled* = avoidable security surface. *Auth0/Clerk* = external dependency + cost. Cognito integrates natively with the API Gateway JWT authorizer and is free at this user count. |
| **SPA auth client** | **`react-oidc-context` + `oidc-client-ts`** (standard OIDC, auth-code + PKCE, ~small) | **AWS Amplify Auth (`aws-amplify`) is the better production choice** — it wraps MFA (TOTP/SMS), sign-up/confirmation/forgot-password flows, automatic token refresh + rotation, and `cookieStorage`. Chosen against here only to keep the bundle and surface area minimal for the prototype; see Future work. |
| **Frontend hosting** | **SPA on S3 + CloudFront (OAC)** | *Amplify Hosting* = another managed layer. *SSR* = compute + complexity with no SEO/first-paint need. |
| **Real-time** | **Short polling (~3–5 s)** | *WebSockets / AppSync subscriptions* = connection state + a second API paradigm; deferred to Future work. |
| **Document transfer** | **Presigned S3 URLs** | *Proxying bytes through Lambda* hits payload limits and adds egress cost; every URL issue is still audited. |
| **IaC** | **AWS CDK v2 (TypeScript)** | *Terraform* — user prefers CDK; *SAM* — narrower; *Console* — not reproducible. |
| **Repo layout** | **Monorepo (pnpm workspaces)** | *Polyrepo* is the production choice for independent service lifecycles, but a monorepo is right for a submission reviewers clone once, and it shares the `events`/`authz`/`platform` packages without publishing. |

## 8. Data model

Six DynamoDB tables, one per service, all on-demand (no per-table floor), each
single-table-designed within its own domain. `PK` / `SK` are strings; GSIs as
noted. **No service reads another service's table.**

### 8.1 `accounts` table (Accounts svc)

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| Profile | `USER#<userId>` | `PROFILE` | email, name, company, industryRole, phone, createdAt (`userId` = Cognito `sub`) |

- **GSI-email** `EMAIL#<lowercased>` → uniqueness / lookup.
- Patterns: get my profile (GetItem); resolve a user by email.

### 8.2 `deals` table (Deals svc) — source of truth for deals + membership

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| Deal meta | `DEAL#<dealId>` | `META` | address, propertyType, label, price, earnestMoney, targetClosingDate, actualClosingDate, description, status, currentStage, firm, createdBy, createdAt |
| Membership | `DEAL#<dealId>` | `MEMBER#<userId>` | role, side, status, invitedBy, joinedAt, version · **GSI1** `USER#<userId>` / `DEAL#<dealId>` |
| Invitation | `DEAL#<dealId>` | `INVITE#<token>` | email, role, side, invitedBy, status, expiresAt · **GSI2** `EMAIL#<email>` / `INVITE#<dealId>` |
| Stage state | `DEAL#<dealId>` | `STAGE#<n>` (1–6) | name, status, targetDate, notes, completedBy, completedAt |
| Checklist item | `DEAL#<dealId>` | `CHECK#<n>#<itemId>` | title, assigneeUserId, dueDate, done, doneBy, doneAt, fromTemplate |
| Handshake | `DEAL#<dealId>` | `HS#<hsId>` | action, payload, initiatedBy, initiatedSide, status (`pending`→`approved`/`rejected`/`completed`), sagaState, decidedBy, decisionReason, createdAt, decidedAt |
| Approval pointer | `DEAL#<dealId>` | `APPR#<hsId>#<userId>` | one per eligible approver (a lead on the counterparty side) · **GSI1** `USER#<userId>` / `APPR#<createdAt>#<hsId>` — serves "my pending approvals"; all pointers for an `hsId` are deleted when it is decided |
| Stage | `DEAL#<dealId>` | `STAGE#<n>` (1–6) | key, name, status, targetDate, notes, completedBy, completedAt — the 6 rows are written by `createDeal` |
| Checklist item | `DEAL#<dealId>` | `CHECK#<n>#<itemId>` | title, assigneeUserId, dueDate, done, doneBy/At, fromTemplate — template items are materialized the first time a stage's checklist is read |

- **GSI1 "by user"** → my deals (memberships); my pending approvals (handshakes).
- **GSI2 "by email"** → pending invites for an email at login.
- Patterns: deal meta (GetItem); members / invites / stages / checklist / open
  handshakes (Query by `SK` prefix); my deals & my approvals (GSI1).

### 8.3 `chat` table (Chat svc)

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| Thread | `DEAL#<dealId>` | `THREAD#<threadId>` | subject, scope, stageTag, createdBy, createdAt, convertedFrom |
| Message | `DEAL#<dealId>` | `MSG#<threadId>#<createdAt>#<msgId>` | authorId, body (never wiped), mentions[], attachments[] (opaque `{docId,title}` refs until Module 7 validates them), editedAt, deletedAt, `history[]` (prior bodies), `system` |
| Receipt | `DEAL#<dealId>` | `RCPT#<msgId>#<userId>` | deliveredAt, readAt — written per recipient at send (frozen set) |
| Read marker | `DEAL#<dealId>` | `READ#<threadId>#<userId>` | lastReadTs |
| Membership projection | `DEAL#<dealId>` | `MEMBERVIEW#<userId>` | role, side, status, version — upserted by the consumer from `member.*`, guarded by `version <= :occurredAt` |
| Feed item | `DEAL#<dealId>` | `FEED#<occurredAt>#<eventId>` | kind, summary, actorId — written by the consumer from `stage.advanced` / `handshake.approved`/`rejected` / `deal.status_changed` / `member.joined`; `PutItem`-if-absent for idempotency |

- Patterns: threads in a deal (Query prefix → filter by `authz`); messages in a
  thread since `ts` (Query `BETWEEN`, polling); receipts for a message (Query
  prefix); a member's read marker (GetItem); the activity feed
  (`GET /deals/{id}/activity` → Query `FEED#` newest-first). V1's feed is
  system events only; merging visible messages into it is a refinement.

### 8.4 `documents` table (Documents svc) + S3 docs bucket

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| Document | `DEAL#<dealId>` | `DOC#<docId>` | category, title, description, scope, stageTag, currentVersion, versionCount, uploadedBy, createdAt, archivedAt |
| Version | `DEAL#<dealId>` | `DOCVER#<docId>#<n>` | s3Key, size, contentType, uploadedBy, uploadedAt, note |
| Doc request | `DEAL#<dealId>` | `DOCREQ#<reqId>` | category, note, targetUserId?, targetRole?, dueDate, stageTag, scope, status, fulfilledDocId?, declineReason?, createdBy, resolvedAt |
| Membership projection | `DEAL#<dealId>` | `MEMBERVIEW#<userId>` | role, side, status, version |

- S3 object key: `<dealId>/<docId>/v<n>/<filename>`. Bucket blocks all public
  access; access only via presigned URLs.
- Patterns: documents in a deal (Query prefix → filter by scope + category);
  versions of a doc; open document requests.

### 8.5 `notifications` table (Notifications svc)

| Entity | PK | SK | Key attributes |
|---|---|---|---|
| Notification | `USER#<userId>` | `NOTIF#<occurredAt>#<eventId>` | type, title, dealId, actorId, targetType, targetId, readAt, sourceEventId |
| Membership projection | `DEAL#<dealId>` | `MEMBERVIEW#<userId>` | role, side, status, version |
| Profile projection | `USER#<userId>` | `PROFILE` | email, name |

- One row **per (recipient, source event)**. The SK is deterministic
  (`occurredAt` + `eventId` from the envelope), so `attribute_not_exists(SK)`
  absorbs a redelivered event — no separate dedupe marker.
- The consumer keeps two projections in the same table: `member.*` →
  `MEMBERVIEW#` (for `allMembers` / `role` fan-out) and `account.created` →
  `PROFILE#` (email/name, for the action-required email).
- Patterns: my notifications newest-first (Query on `USER#<id>` /
  `begins_with(NOTIF#)`, `ScanIndexForward=false`, `Limit`); the bell's unread
  count is derived from that page (no counter item — exact at any realistic
  volume, no drift).

### 8.6 `audit` table + `audit-membership` table (Audit svc)

| Table | PK | SK | Key attributes |
|---|---|---|---|
| **`audit`** — audit event | `DEAL#<dealId>` | `AUDIT#<occurredAt>#<eventId>` | actorId, detailType, action, targetType, targetId, scope, summary, metadata (raw `detail`), correlationId |
| **`audit-membership`** — projection | `DEAL#<dealId>` | `MEMBERVIEW#<userId>` | role, side, status, version |

- **Append-only, enforced by IAM.** The consumer Lambda's role has
  `dynamodb:PutItem` on the `audit` table and **nothing else** — no
  `UpdateItem`, `DeleteItem`, or `BatchWriteItem`. There is no code path that
  mutates a row. Idempotency needs no separate dedupe marker: the SK is
  deterministic (`occurredAt` + `eventId` both come from the event envelope), so
  a redelivered SQS message is absorbed by `attribute_not_exists(SK)`.
- **Why two tables.** The `member.*` projection the service also maintains
  (for scoped reads) needs `UpdateItem`, which would break the append-only
  grant. It lives in a separate, mutable `audit-membership` table the consumer
  may read/write freely; the log itself stays untouchable. The projection is a
  derived cache — losing it is a re-sync, not data loss.
- **Scope.** Every auditable event now carries its own visibility `scope`
  (chat + document/doc-request events were enriched in this module); deal-,
  member-, stage- and handshake-domain events are inherently `deal_wide`. The
  consumer never guesses a scope.
- Patterns: audit for a deal newest-first (Query, `ScanIndexForward=false`),
  optional `occurredAt` range on the SK; then filter by the reader's
  `visibleScopes` (**the security boundary**) and the convenience filters
  (`actor` / `action` / `targetType` / `targetId`) in the handler. Export
  scans the deal partition (capped at 10k rows) and applies the same filter.

### 8.7 Within-service transactions (`TransactWriteItems`, single-region ACID)

- **Deals — initiate handshake:** put `HS#` (pending) + set GSI1 pending pointer
  for each buy-side approver (or the admin). *Then* publish `handshake.requested`.
- **Deals — approve handshake (deal-local action):** update `HS#` → approved +
  apply the effect (`META.currentStage` + two `STAGE#` items for an advance; or
  `META.price`; or `META.status`) + clear GSI1 pointers, in one transaction.
  *Then* publish `handshake.approved` + `stage.advanced` / `deal.updated`.
- **Deals — approve handshake (document delete):** update `HS#` →
  `approved, sagaState=awaiting_document` + publish `handshake.approved`. On the
  inbound `document.archived` event, transition `HS#` → `completed`.
- **Chat — send message:** put `MSG#` + one `RCPT#` per frozen recipient. *Then*
  publish `message.posted`.
- **Chat — convert channel thread:** update `THREAD#` scope + put a system
  `MSG#`. *Then* publish `thread.converted` (Notifications emails the dropped
  party; Audit records it).

Audit and notification records are **not** written in these transactions — they
are produced by the respective services from the published events, keyed on
`eventId` for idempotency.

### 8.8 Event catalog (`packages/events`)

Every event: `{ eventId, occurredAt, correlationId, dealId, actorId, detail }`.
`source = "cre.<service>"`, `detail-type` as below. Every event that concerns a
scoped resource (chat threads/messages, documents, doc-requests) carries a
`scope` field so the Audit service can filter reads without a lookup or a guess;
deal-, member-, stage- and handshake-domain events are inherently `deal_wide`.

| detail-type | Producer | Key `detail` fields | Main consumers |
|---|---|---|---|
| `account.created` | Accounts | userId, email | Audit |
| `deal.created` | Deals | dealId, createdBy | Audit |
| `deal.updated` | Deals | fields changed (old→new) | Audit |
| `deal.status_changed` | Deals | status, reason | Notifications, Audit |
| `member.invited` | Deals | email, role, side, token | Notifications (email), Audit |
| `member.joined` | Deals | userId, role, side | Chat, Documents (projection), Notifications, Audit |
| `member.role_changed` | Deals | userId, old, new | Chat, Documents, Audit |
| `member.removed` | Deals | userId | Chat, Documents, Audit |
| `stage.advanced` | Deals | from, to, firmNowTrue? | Notifications, Audit |
| `handshake.requested` | Deals | hsId, action, payload, approverIds | Notifications, Audit |
| `handshake.approved` | Deals | hsId, action, payload, initiatedBy, initiatedSide | Documents (delete saga), Notifications, Audit |
| `handshake.rejected` | Deals | hsId, reason, initiatedBy, initiatedSide | Notifications, Audit |
| `message.posted` | Chat | threadId, msgId, scope, mentions[] | Notifications (@mentions), Audit |
| `message.edited` / `message.deleted` | Chat | threadId, msgId, scope | Audit |
| `thread.created` | Chat | threadId, scope, subject | Audit |
| `thread.converted` | Chat | threadId, toScope, droppedUserId | Notifications, Audit |
| `document.uploaded` | Documents | docId, category, scope | Audit |
| `document.delete_requested` | Documents | docId, requestedBy, requesterRole, requesterSide | Deals (opens the delete handshake), Audit |
| `document.versioned` | Documents | docId, n, scope | Audit |
| `document.promoted` | Documents | docId, scope (`deal_wide`) | Audit |
| `document.archived` | Documents | docId, hsId, scope | Deals (close saga), Audit |
| `document.accessed` | Documents | docId, n, mode (`opened`/`downloaded`), by, scope | Audit |
| `docrequest.created` | Documents | reqId, category, scope, targetUserId?/targetRole?, createdBy | Notifications, Audit |
| `docrequest.fulfilled` / `declined` | Documents | reqId, scope, createdBy (+ fulfilledDocId / reason) | Notifications, Audit |
| `docrequest.cancelled` | Documents | reqId, scope | Audit |
| `notification.emailed` | Notifications | notifId, channel | Audit |

## 9. API surface

REST-style, all under `/v1`, all JWT-authed except `GET /v1/health`. **One**
API Gateway HTTP API is the edge; routes are path-matched to per-service Lambda
integrations (nested paths resolve most-specific-first, so
`/v1/deals/{id}/threads/*` → Chat and `/v1/deals/{id}/*` → Deals). Every handler
validates input with `zod`, then calls `packages/authz` against its local
membership view before touching data.

- **Accounts svc:** `GET /me`, `PUT /me` (sign-up/login via Cognito hosted UI;
  post-confirmation Lambda writes the profile).
- **Deals svc — deal:** `POST /deals`, `GET /deals/{id}`, `PATCH /deals/{id}`,
  `POST /deals/{id}/status`, `GET /deals/{id}/dashboard`.
- **Deals svc — members/invites:** `GET/POST /deals/{id}/invites`,
  `GET|DELETE /deals/{id}/invites/{token}`,
  `POST /deals/{id}/invites/{token}/accept` (the deal id is in the path so no
  token→deal lookup is needed), `GET /deals/{id}/members`,
  `PATCH|DELETE /deals/{id}/members/{userId}`.
- **Deals svc — milestones:** `GET /deals/{id}/stages`,
  `PATCH /deals/{id}/stages/{n}` (notes / target date — target dates are
  handshake-gated once firm), `POST /deals/{id}/advance` (opens an advance
  handshake), `GET/POST /deals/{id}/stages/{n}/checklist`,
  `PATCH|DELETE /deals/{id}/stages/{n}/checklist/{itemId}`.
- **Deals svc — terms & status:** `POST /deals/{id}/status` (close/cancel —
  unilateral pre-firm, opens a handshake once firm), `POST /deals/{id}/terms`
  (price change → always a handshake; closing-date change → unilateral pre-firm,
  handshake once firm).
- **Deals svc — handshakes:** `GET /deals/{id}/handshakes`, `GET /handshakes`
  (my pending approvals across every deal, via the `APPR#` pointers on GSI1),
  `POST /deals/{id}/handshakes/{hsId}/approve|reject`. Approve/reject applies the
  effect and clears the pointers in one `TransactWriteItems`; the initiator may
  also reject to withdraw.
- **Chat svc:** `GET/POST /deals/{id}/threads`,
  `POST /deals/{id}/threads/{tid}/convert`,
  `GET/POST /deals/{id}/threads/{tid}/messages`,
  `PATCH|DELETE …/messages/{mid}`, `POST …/threads/{tid}/read`,
  `GET …/messages/{mid}/receipts`.
- **Documents svc** (13 routes): `GET/POST /deals/{id}/documents`,
  `GET /deals/{id}/documents/{did}` (metadata + versions),
  `POST /deals/{id}/documents/{did}/versions`,
  `GET …/versions/{n}/download`, `GET …/versions/{n}/view` (both presign a
  short-TTL S3 `GET` and publish `document.accessed`),
  `POST /deals/{id}/documents/{did}/promote`,
  `DELETE /deals/{id}/documents/{did}` (publishes `document.delete_requested`,
  returns `202` — the delete saga opens a handshake);
  `GET/POST /deals/{id}/doc-requests`, `POST …/{rid}/fulfill|decline|cancel`.
  `POST /documents` and `…/versions` return a presigned S3 `PUT` — the browser
  uploads the bytes directly (optimistic: the `DOC#`/`DOCVER#` row and
  `document.uploaded` are written before the `PUT` completes).
- **Audit svc:** `GET /deals/{id}/audit` — newest-first, scoped to the caller's
  `visibleScopes`, with `actor` / `action` / `targetType` / `targetId` /
  `from` / `to` filters and `limit` + opaque `cursor` pagination.
  `GET /deals/{id}/audit/export?format=csv|json` — the same scoped + filtered
  rows (capped at 10k) returned as an `attachment` download (`text/csv` or a
  JSON envelope), via the router's `raw` response escape hatch.
- **Notifications svc:** `GET /v1/notifications?limit=` — this user's rows
  newest-first with `unreadCount`; `POST /v1/notifications/read` — `{ id }`
  (the `<occurredAt>#<eventId>` composite from the list) or `{ all: true }`.
  Cross-deal, per-user (no `dealId` in the path).

## 10. Key flows

**Membership projection.** Deals is the source of truth. On any membership
change it writes its own `MEMBER#` row and publishes `member.joined` /
`member.role_changed` / `member.removed`. Chat, Documents, and Audit each
consume these from their SQS queue and upsert a `MEMBERVIEW#<userId>` row in
their own table, guarded by a conditional write on `version` so out-of-order
events converge. All subsequent authz checks in those services read the local
`MEMBERVIEW#` rows — no call back to Deals.

**Invitation.** Admin (bootstrap) or a buy-side lead `POST …/invites` →
`INVITE#` written + GSI2-indexed + `member.invited` published; the response
carries `{ token, acceptUrl }` (Module 9 will also send the SES email). The
invitee signs up / logs in and `POST …/invites/{token}/accept` — the JWT `email`
claim must match the invite (case-insensitive) — then Deals writes `MEMBER#`
(`active`) + flips the invite to `accepted` in one transaction and publishes
`member.joined` → projections + audit + a "you're in" notification follow.

**Handshake (advance milestone) — saga.**
1. Either side `POST /deals/{id}/advance`. Deals writes `HS#` (pending) + GSI1
   pending pointers for the counterparty approvers, then publishes
   `handshake.requested`. Notifications notifies the approver(s); Audit records
   it. On the buy side the pointer is written for **both** `BUYER` and
   `BUYER_AGENT`; whichever approves first wins.
2. An approver `POST …/handshakes/{hsId}/approve`. Deals runs one
   `TransactWriteItems`: `HS#` → `approved`, `META.currentStage`++, the two
   `STAGE#` rows, GSI1 pointers cleared; if stage 2 → 3 it also sets
   `META.firm = true`. Then it publishes `handshake.approved` + `stage.advanced`.
3. Audit writes entries from those events; Notifications notifies both sides.

**Handshake (delete a document) — cross-service saga.** Fully event-driven —
no synchronous service-to-service call on the request path.
1. `DELETE /deals/{id}/documents/{docId}` (Documents svc) checks
   `can('deleteDocument', …)` against the local projection, then publishes
   `document.delete_requested` `{docId, requestedBy, requesterRole,
   requesterSide}` and returns `202`.
2. A **Deals consumer** (SQS off `cre.documents`) picks it up, loads the deal,
   rebuilds the `AuthzContext`, and runs `handshake.initiate(action=
   delete_document)` on the requester's behalf — writing the `HS#` pending row +
   `APPR#` pointers and publishing `handshake.requested`. It is idempotent: a
   redelivered request whose `docId` already has a pending/approved
   `delete_document` handshake is a no-op. A permanent rejection (`HttpError`:
   requester not permitted, deal gone) is logged and dropped, not retried.
3. An approver `POST …/handshakes/{hsId}/approve`. Deals sets `HS#` →
   `approved, sagaState=awaiting_document` and publishes `handshake.approved`.
4. The **Documents consumer** matches `handshake.approved` with
   `action=delete_document`, sets `DOC#.archivedAt` (idempotent
   `if_not_exists`), and publishes `document.archived` `{docId, hsId}`.
5. The Deals consumer matches `document.archived` and sets `HS#` → `completed`
   (`completeHandshakeSaga`, conditional on `status=approved`, so a replay is a
   no-op). Audit records every step. If Documents fails, SQS redrive + DLQ
   surface it and the `HS#` stays `awaiting_document` (visible as an incomplete
   saga) — no partial "deleted" state is shown, because `archivedAt` is only set
   on success.

**Message receipts.** On send, `RCPT#` rows created for the frozen recipient set
(`deliveredAt`/`readAt` null). Each client's `GET …/messages` stamps
`deliveredAt` for messages it just fetched; opening the thread
(`POST …/threads/{tid}/read`) stamps `readAt` and advances the read marker. The
sender's rollup = min state across the recipient set.

**Document upload + promote.** `POST /documents` writes `DOC#` + `DOCVER#1` and
returns a presigned `PUT`. New versions: `POST …/versions` → `DOCVER#n` +
`currentVersion` bump. `POST …/promote` flips `scope` from `side_private:*` to
`deal_wide` (non-`OTHER` member of that side only) + audit. Downloads/views
issue short-TTL presigned `GET`s and write `AUDIT#` (`downloaded` / `opened`).

**Notification fan-out.** The Notifications consumer maps each event to a
recipient *directive* — explicit user ids (`approverIds`, `mentions`,
`initiatedBy`, `createdBy`, `droppedUserId`), `allMembers`, or a `role` — and
resolves the last two against its `MEMBERVIEW#` projection. It writes one
`NOTIF#<occurredAt>#<eventId>` row per recipient (skipping the actor), guarded
by `attribute_not_exists`. `handshake.requested` and `docrequest.created` are
also "action required": if email is enabled it looks up the recipient's
`PROFILE#` email, sends via SESv2, and publishes `notification.emailed` (which
Audit records). `member.invited` is email-only — the invitee has no account, so
there is no in-app row. The SPA bell polls `GET /v1/notifications` every 30 s.

## 11. Security considerations

- **Authorization is server-side and layered:** the API Gateway JWT authorizer
  rejects unauthenticated calls; every service handler re-checks with
  `packages/authz` against its **local membership projection**. The UI hiding
  actions is convenience, not a control.
- **Per-service least-privilege IAM:** each service's Lambda role can access only
  its own table, publish to the bus, consume its own SQS queue, and (Documents)
  presign its own bucket. The Audit **consumer** role is `dynamodb:PutItem`-only
  on the `audit` table — no `UpdateItem`, `DeleteItem`, or `BatchWriteItem` — so
  append-only is enforced by the platform, not just by code. Its `member.*`
  projection (which needs `UpdateItem`) is kept in a separate `audit-membership`
  table so that grant can't touch the log. The Audit **API** role is
  read-only on both tables.
- **Eventual-consistency window:** a membership change reaches Chat/Documents/
  Audit within seconds via the bus. A removed member could in principle act in
  that window; the actions that matter (advance, delete, price, close) are all
  owned by Deals, which re-checks against its own source-of-truth `MEMBER#` rows,
  so the exposure is limited to reading a thread/document a beat longer than
  intended. Acceptable for V1; a synchronous projection-invalidation call is the
  hardening step.
- **No god view.** The admin's reach is deal-wide + sell-side only; cross-side
  private content is unreachable by anyone — including in the audit trail, where
  each row's `scope` is checked against the reader's `visibleScopes` before it
  is returned (list *and* export).
- **Documents:** bucket has all public access blocked; access only via
  presigned URLs with a short TTL (≈ 5 min); the S3 key embeds `dealId`; every
  URL issue is audited.
- **Audit integrity:** append-only enforced by IAM — the consumer role can
  `PutItem` on the `audit` table and nothing else; there is no update/delete
  code path. Redeliveries are idempotent via the deterministic
  `AUDIT#<occurredAt>#<eventId>` SK + `attribute_not_exists`. Hash-chaining for
  tamper-evidence is noted as future hardening.
- **Soft-delete everywhere:** nothing is destroyed; disputes can always be
  reconstructed.
- **Handshake** removes unilateral irreversible actions once the deal is firm.
- **Input validation:** `zod` schema per handler; reject on parse failure.
- **Secrets:** the SPA is a public Cognito client using PKCE (no client secret).
  Any other config goes in SSM Parameter Store (free tier), not hard-coded.
- **SES** starts in sandbox — seed identities are verified for the demo; DKIM +
  production access are a deployment step, noted in the README.
- **Rate limiting:** API Gateway default throttling; per-route limits noted as
  hardening.

## 12. Cost estimate (us-east-2, demo traffic)

| Item | Estimate |
|---|---|
| 6 DynamoDB tables (on-demand, tiny) | ~$0 (no per-table floor) |
| 6 Lambdas (services) + trigger/consumer Lambdas | ~$0 (free tier) |
| EventBridge custom-bus events ($1/M) | cents |
| 6 SQS queues + DLQs ($0.40/M requests) | cents |
| API Gateway HTTP API ×1 | ~$0–2 / mo |
| S3 (documents + web) | < $1 / mo |
| CloudFront | ~$0 (1 TB free egress) |
| Cognito (< 50 MAU) | ~$0 |
| SES | ~$0 ($0.10 / 1k emails) |
| 6+ CloudWatch log groups (1-week retention) | < $2 / mo |
| X-Ray (100k traces/mo free) | ~$0 |
| **Total** | **~$2–8 / month** |

Microservices cost more in wiring and build time, not dollars — everything is
serverless pay-per-use, so it stays well inside the ~$100 credit for the
assignment and for keeping the demo up afterward.

## 13. Testing strategy

- **Unit (per package/service, no AWS):** `packages/authz` (table-driven per
  role × action × context; scope visibility); the handshake state machine +
  saga transitions (incl. the `awaiting_document` path); buy-side invite-limit
  checks; milestone advance rules (forward-only, `firm` transition); projection
  reducers (out-of-order `member.*` events converge).
- **Contract tests:** `packages/events` `zod` schemas — every producer's payload
  validates; every consumer parses the fixtures it subscribes to. This is the
  cross-service contract.
- **Integration (deploy-to-AWS dev loop):** `cdk deploy` a service to a dev
  stack; exercise its handlers and its event consumer end to end (publish a test
  event → assert the projection / audit / notification row appears).
- **Infra:** CDK `Template.fromStack` per stack — table + GSIs present, docs
  bucket `BlockPublicAccess.BLOCK_ALL`, Audit role has no
  `UpdateItem`/`DeleteItem`, each consumer has an SQS queue + DLQ, JWT authorizer
  attached, CloudFront using OAC.
- **Manual E2E:** the verification checklist in §14, against the deployed stack
  with seed data.

## 14. Verification checklist (against the deployed stack + seed data)

- Each seeded user sees only the threads / documents / audit entries their role +
  scope permit; the admin cannot see buy-side-private content.
- An unauthorized document fetch is denied (no presigned URL issued); open /
  preview / download are all logged.
- A handshake-gated action (advance milestone, delete document, edit price) does
  not take effect until the counterparty approves; every step is audited.
- Message receipts progress **sent → received → read** as recipients load and
  open the thread.
- An invited user receives the SES email and can log in; buy-side self-invite
  limits (≤ 2 agents, ≤ 2 attorneys, ≤ 7 total) are enforced.
- Close / cancel is admin-unilateral before Attorney Review and a handshake
  after.
- Converting a `channel:agent` thread to side-private drops the other agent,
  keeps history, notifies them, and is audited.
- **Event-driven paths:** after an @mention, a notification row appears for the
  mentioned user (via the bus, not a synchronous write); after any mutation, a
  matching audit entry appears in the `audit` table within seconds; a
  `member.removed` propagates so the removed user loses thread/document access.
- **Delete-document saga:** approving the handshake leaves `HS#` in
  `awaiting_document` until `document.archived` arrives, then `completed`; the
  document only shows archived after the Documents service confirms.

## 15. Assumptions

- A deal starts at an accepted offer; no in-app bidding.
- Exactly one property per deal.
- The sole admin is the `SELLER_AGENT` who created the deal.
- Either the `BUYER` or the `BUYER_AGENT` may act as the buy-side handshake
  approver; one approval from the buy side suffices. `LENDER` is never an
  approver.
- `TITLE_AGENT` is neutral and invited by the admin only.
- Milestone regression is disallowed in V1.
- "Firm" means Attorney Review is completed.
- Edits and deletes are soft everywhere; the audit log retains originals.
- Single region, US/English, USD.

## 16. Future work

**Stretch — attempt in this build if time allows, after the core is solid:**

- Payments: earnest-money / closing-funds handling + payer identity verification
  (problem 1).
- Document e-signature for the purchase agreement and disclosures.

**Next — out of scope for the prototype:**

- Pre-contract stages + in-app bidding (Sourcing & Underwriting, Offer / LOI with
  a preliminary underwriting model; offer submission, counters, acceptance).
- Deadline & contingency automation: lead-time reminders and escalation on stage
  target dates and checklist items (problem 5).
- Real-time push (API Gateway WebSockets or AppSync) instead of short polling.
- Multi-property / portfolio deals; richer deal state machine (e.g. `ON_HOLD`).
- Identity verification / KYC for all parties; audit-log tamper-evidence via
  hash-chaining.
- **Account-lifecycle audit:** a system/global audit view for `dealId`-less
  events (sign-ups, profile edits, eventual sign-in / MFA events). The Audit
  service skips these in v1 because its only surface is per-deal.
- **Audit read at scale:** a GSI by `actorId` (and/or `action`) instead of the
  deal-partition Query + in-handler filter; streamed / fully-paginated export
  instead of the 10k-row cap.
- Integrations: MLS, DocuSign, title production, lender LOS, county e-recording.
- Multi-tenant brokerage/org accounts + billing; document OCR + full-text
  search; native mobile apps + SMS.
- Per-document custom sharing; custom-participant threads; deal-wide promotion of
  threads.
- Per-user notification preferences (mute, email level) — V2.
- **Adopt AWS Amplify Auth** on the SPA for MFA (TOTP/SMS), managed
  sign-up/confirm/forgot-password flows, automatic refresh-token rotation, and
  `cookieStorage` (replacing `react-oidc-context` + `oidc-client-ts`). Also
  enable Cognito threat protection (adaptive/risk-based MFA) once on a paid
  feature plan.


## 17. As-built notes

Where the implementation diverged from the design above, and why. (The design
sections have been updated to match; this section is the changelog.)

### Architecture / cross-cutting

- **Event enrichment for scope & attribution.** Every event that concerns a
  scoped resource (chat threads/messages, documents, doc-requests) now carries a
  `scope` field, and the handshake / doc-request *outcome* events carry the
  originator (`initiatedBy` / `createdBy`). The Audit and Notifications
  consumers therefore never infer a scope or look up an originator — the
  producer, which has the row in hand, is authoritative. A wrong inference in
  Audit would have leaked a side-private action across sides.
- **Deterministic-SK idempotency instead of `SEEN#` markers.** Audit and
  Notifications rows use a SK built from the event envelope
  (`AUDIT#<occurredAt>#<eventId>`, `NOTIF#<occurredAt>#<eventId>`), so a
  redelivered SQS message is absorbed by `attribute_not_exists(SK)`. The
  separate per-consumer dedupe marker in the original data model was dropped.
- **`@cre/platform/projection.ts`** — the `MEMBERVIEW#` upsert/get/list helper
  (version-guarded on `occurredAt`) was extracted so Documents, Audit,
  Notifications and the Deals delete-saga consumer share one implementation.
  Chat keeps its own copy (written first; identical behaviour).
- **`raw` router escape hatch.** `@cre/platform`'s HTTP router gained a
  `{ raw: {...} }` result form so the audit CSV export can return real
  `text/csv` with a `Content-Disposition` attachment header instead of a JSON
  envelope.
- **`httpApiEndpoint` SSM read removed** from the Chat and Documents stacks —
  `HttpApi.fromHttpApiAttributes` only needs the id for route creation, and the
  unused parameter tripped `cdk synth --strict` (W2001).

### Accounts / auth

- **Invitations are link-based, not emailed.** `POST …/invites` returns the
  `acceptUrl`; the SPA shows it for the inviter to share. Email is implemented
  in Notifications but flag-gated off (below).
- **`USER_PASSWORD_AUTH`** is enabled on the SPA app client so the seed/verify
  scripts can authenticate; the browser still uses the hosted UI (auth-code +
  PKCE). Production should be SRP-only.
- **Buy-side bootstrap.** The design first said only `BUYER` / `BUYER_AGENT`
  invite the buy-side; that is a chicken-and-egg on a fresh deal, so the admin
  (`SELLER_AGENT`) bootstraps the first buy-side lead, after which the buy-side
  self-manages within the ≤2 / ≤2 / ≤7 limits. (§5.3 / §6 updated.)

### Deals

- The Deals stack gained a small **SQS consumer** (Module 7) that turns
  `document.delete_requested` into a handshake and closes the saga on
  `document.archived` — the document-delete flow is fully event-driven, with no
  synchronous service-to-service call.
- `allMembers` **broadcast notifications** (`stage.advanced`,
  `deal.status_changed`) include the actor; a milestone is deal-wide news, not
  feedback on one's own click. Targeted notifications still skip the actor.

### Audit

- **Two tables.** The append-only `audit` table's consumer role has
  `dynamodb:PutItem` and nothing else. The `member.*` projection it also
  maintains needs `UpdateItem`, so it lives in a separate `audit-membership`
  table — append-only is enforced by IAM per-table, not by a code convention.
- The consumer rule matches **`source: [{ prefix: "cre." }]`** (all events);
  Notifications matches a fixed detail-type list across sources.

### Notifications

- **Email dispatch is wired but disabled.** SESv2 templates (invitation +
  action-required), the `notification.emailed` event, and the `ses:SendEmail`
  grant are all in place, unit-tested behind a mock, but the consumer no-ops
  unless `NOTIFY_EMAIL_FROM` is set. No SES sender identity is verified in the
  demo project and the SES sandbox only delivers to verified addresses.
  Enabling in production is: verify a domain, set the env var — no code change.
- **Unread count is derived** from the returned page (latest ~50), not a
  maintained counter item — exact at any realistic volume, no drift.
- **Profile projection.** `account.created` feeds a `PROFILE#<userId>` row
  (email/name) used only for the action-required email lookup.

### Scripts / seeding

- `scripts/seed.mjs` and `scripts/verify.mjs` (+ `scripts/lib/portal.mjs`)
  resolve stack identifiers from **SSM**, not `infra/cdk-outputs.json`.
- They create Cognito users with **`admin-create-user` + `SUPPRESS` + a
  permanent password**, because the Cognito-default email sender's daily cap is
  low and a scripted cohort exhausts it. Consequence: those users do **not**
  fire the `PostConfirmation` trigger, so they have no `accounts` profile row —
  fine for every deal flow (which keys off membership + JWT claims), but
  `GET /v1/me` 404s for a scripted login.
