# Prompt Log

A running record of the prompts used to build this project, with the context at
the time and what each produced. Prompts related to the initial survey of the
commercial-real-estate industry (used only to *choose* the problem) are
deliberately excluded; this log covers the solution being implemented.

Prompts are near-verbatim; long ones are trimmed with `…` where marked.

---

## 1 — The assignment

> I have received a take home assignment for an interview loop I'm participating
> in as the candidate. Here is the problem description: *Imagine you are a staff
> software engineer at a commercial real estate company. Identify a meaningful
> problem worth solving and build a working solution for it.* … We're less
> interested in the volume of code you produce and more interested in the
> thinking behind it. During the follow-up discussion, be prepared to walk us
> through: why you chose this problem and who it serves; what you learned from
> your research; how you determined what was worth building; the key assumptions
> and tradeoffs you made; your architecture and technical decisions; what you
> built; what you'd change or build next.

**Context:** starting point. The whole exercise is deliberately ambiguous; the
deliverable is a working app plus a defensible narrative.

**Outcome:** agreed to research CRE problems, pick one, and document the
reasoning in a short problem-exploration doc.

---

## 2 — The product idea

> Is there anything related to buying and selling houses? I had an idea for a
> portal where the buyer, seller, real estate agents on both sides and lawyers
> on both sides can communicate, share docs and perform other formalities
> associated with buying or selling of houses. Can you check if any technical
> problems exist with the buying/selling of properties?

**Context:** choosing the problem. Focused research on the transaction-execution
process rather than the broader industry.

**Outcome:** confirmed a real, well-documented cluster of problems — no single
source of truth, document version chaos with coarse permissions, no audit trail
— and that existing tools are almost all single-constituency (built for the
brokerage, or title, or the lender). Settled on a neutral, all-parties-first
transaction portal. Recorded in `docs/01-problem-exploration.md`.

---

## 3 — Scope: generic, incremental, problems 2/3/4

> Let's keep it for buying properties to make it more generic and not specific to
> buying resident housing. I'm guessing most of the process will be quite
> similar? … We can have an app that primarily targets problems 2, 3 and 4.
> Later we might be able to expand the scope to problem 1 but I'd rather start
> small and build incrementally.

**Context:** setting scope before design.

**Outcome:** target the coordination layer (single source of truth, document
room + permissions, audit trail). Wire fraud (problem 1) and deadline automation
(problem 5) deferred. Framing kept generic to property purchases.

---

## 4 — Prototype depth and guidance level

> Ideally, this is to create a prototype and defend choices in an interview
> setting. However, I don't want only the happy path flow in terms of features. …
> it should have all features like auth for login, db to store chat or other
> data needed by the application, storage for documents shared amongst parties,
> etc. … For the guidance level, let's go with High so that I'm involved in the
> building process and will be able to describe the solution in the interview.

**Context:** calibrating breadth vs. depth, and working style.

**Outcome:** a real prototype — working auth, a real datastore, real object
storage, enforced permissions — but limited breadth (one deal type, fixed
milestones, seed data instead of integrations). Guidance level HIGH, persisted
to `CLAUDE.md`.

---

## 5 — Ground rules and deliverables

> You already know what needs to be submitted at the end. I need … the working
> application … a markdown file with the design, commit history in git … and the
> list of prompts I'm providing to you. … we could maintain 3 markdown files.
> First to go over the different types of problems we looked at before choosing
> this one … Second one which acts as the design document … And the third one to
> store the prompts being used …
>
> Note that you do not need to commit anything yourself. After each stage, I will
> commit and push changes to the repo. Also, for the markdown file with the
> prompts, don't include the ones I already provided. I will tell you when you
> should start logging prompts.

**Context:** defining deliverables and the working process.

**Outcome:** three docs — `01-problem-exploration.md`, `02-design.md`,
`03-prompt-log.md`. The user owns all git commits/pushes, one per module. Prompt
logging starts on the user's signal (given at prompt 7).

---

## 6 — Repository setup

> I created a new repository:
> https://github.com/AniruddhaDarp/CreTransactionPortalApplication. … The local
> clone does not exist yet. Can you create one in ~/workspace? … I just need a
> basic markdown file called design-doc.md … so I can test the github commit
> integration. … Can you move the markdown file to docs folder? … Add the
> gitconfig … The name on the commits should be Aniruddha Darp … Can you do
> option B for me? [SSH]

**Context:** standing up the repo and verifying the end-to-end commit/push path
before writing anything substantial.

**Outcome:** local repo at `~/workspace/CreTransactionPortalApplication`; global
`~/.gitconfig` (Aniruddha Darp / aniruddhadarp5@gmail.com); HTTPS password auth
is unsupported by GitHub, so switched the remote to SSH with a new ed25519 key;
`docs/design-doc.md` (title only) committed and pushed successfully.

---

## 7 — Feature discussion, then start logging

> Let's first discuss the features we want the application to have before getting
> to the implementation plan. Also, you can start logging the prompts now. …
> only include prompts for the solution we're implementing.

**Context:** working through the feature set one area at a time before any code.

**Outcome:** logging started (this file). The nine feature areas were then walked
through and resolved one by one (accounts, deal record, parties & membership +
handshake, milestones + checklists, communication, document room, audit trail,
notifications, permission model), followed by the architecture decisions
(DynamoDB single-table for cost, plus the rest of the AWS stack). All captured in
`docs/02-design.md`.

---

## 8 — Design-doc review: both buyer and buyer's agent as handshake leads

> Mostly looks good. I had one note: Let's have both buyer and buyer agent and
> the buy side handshake leads (because most of the heavy lifting will be done by
> the agent on the buyer's instruction).

**Context:** first review pass of `docs/02-design.md`.

**Outcome:** the buy-side handshake approver is now **either** the `BUYER` or the
`BUYER_AGENT` — a single approval from one of them resolves a handshake.
Previously the agent was only a fallback when no buyer had joined. `LENDER`
remains a non-approver. Updated §3, §4, §5.4, §10, §15 of the design doc.

---

## 9 — Microservices architecture

> Before we start implementation, let's breakdown the modules we plan to have.
> At a high level … 1. Accounts/Auth service 2. Permissions service 3. Chat
> Service 4. Documents Service 5. Notifications Service 6. Deal service 7.
> Auditing Service. Do you have any suggestions or an alternative breakdown …?
>
> I would prefer a true micro service because it shows how the app would
> behave/scale in a real world scenario.
>
> 1. 6 services is fine. 2. Yes, one gateway is acceptable with per-service
> lambdas. 3. Explain this a bit more. 4. Yes [X-Ray + correlation IDs]. 5. AWS
> deploy loop is fine. However, I also want the code locally so I can keep
> commiting progress on GitHub.
>
> I prefer the recommended option [EventBridge bus + SQS-per-consumer].

**Context:** deciding how to decompose the app before writing code. The design
doc to this point assumed a single Lambda + single DynamoDB table.

**Discussion:** I recommended a **modular monolith** (one deployable, module
boundaries in code, one table, atomic handshake) as the better fit for a
prototype on a fixed budget, and flagged the costs of true microservices —
distributed transactions/saga, eventually-consistent authorization, ~1.5–2×
build effort. The user chose **true microservices** deliberately, to demonstrate
real-world scaling architecture.

**Outcome — architecture set:**

- **6 services:** Accounts, Deals (absorbs membership + invitations +
  milestones + handshakes), Chat, Documents, Notifications, Audit. "Permissions"
  is **not** a service — it's `packages/authz`, a pure library bundled into every
  service, backed by a per-service local `memberships` projection.
- **Async:** one **EventBridge** custom bus; each consumer gets an **SQS queue +
  DLQ** in front of its Lambda (routing from EventBridge, buffering/redrive from
  SQS — the production hybrid). Chosen over SNS+SQS fan-out (coarser filtering,
  far more wiring) and EventBridge→Lambda direct (no per-consumer buffer).
- **Sync:** one API Gateway HTTP API, path-routed to per-service Lambdas; **no
  service-to-service calls on the request path**.
- **Data:** one DynamoDB table per service (on-demand; 6 tiny tables still ~$0).
- **Handshake** becomes a **saga** — deal-local effects stay ACID in the `deals`
  table; the one cross-service effect (archiving a document on a delete
  handshake) is choreographed via `handshake.approved` → Documents →
  `document.archived` → Deals closes the saga.
- **Observability:** correlation ID propagated HTTP → event → logs; AWS X-Ray on
  the API and every Lambda.
- **Repo:** pnpm-workspaces monorepo — `services/*`, `packages/{authz,events,
  platform}`, `web/`, `infra/`. CDK: `SharedStack` + one stack per service.
- **Local/dev:** unit + contract tests run locally with no AWS; integration is a
  `cdk deploy`-to-dev loop (no LocalStack). Code lives in the repo, committed per
  module.
- **Cost:** revised to ~$2–8/month, still well inside the ~$100 credit.

Design doc §1, §6, §7 (rewritten), §8 (rewritten — 6 tables + event catalog),
§9–§14 updated. Implementation plan re-cut into 9 service-oriented modules.

---

## 10 — Architecture diagram

> Looks good. Can you also create a service architecture diagram on draw.io
> here? [Google Drive link]

**Context:** wanting a visual of the 6-service architecture for the submission.

**Outcome:** the Google Drive link is auth-walled and there's no Drive/draw.io
integration available, so instead:

- `docs/architecture.drawio` — a draw.io / diagrams.net file (mxGraph XML) with
  the full topology: SPA → CloudFront/S3 and → API Gateway; path routing to the
  six service Lambdas; per-service DynamoDB tables; the S3 documents bucket;
  Cognito (Hosted UI, User Pool, post-confirmation trigger); the EventBridge bus
  with content-based rules → SQS+DLQ per consumer → consuming services; the
  document-delete saga edge; SES. Solid = sync, dashed = async; colour-coded by
  layer. Open it at diagrams.net and export/save to Drive.
- `docs/02-design.md` §7.1 also gets an inline **Mermaid** version so it renders
  on GitHub without opening draw.io.

*(Follow-up: "It is a bit cluttered. Can you just increase the spacing …" —
`architecture.drawio` was rebuilt on a larger canvas with bigger boxes, wider
row pitch, the async backbone in its own band, rule filters moved off the arrows
into a notes box, and white label backgrounds.)*

---

## 11 — Module 1: scaffold

> We can move on to the implementation phase now. I want the implementation to be
> one module/service at a time. Let's start small and implement it step by step.

**Context:** design doc and diagram approved; beginning the build.

**Outcome:** Module 1 — the monorepo scaffold, verified green:

- **pnpm workspace** (`pnpm@9.15.9` via Corepack); `tsconfig.base.json` (strict,
  ESM/NodeNext); ESLint 9 flat config + Prettier; Vitest.
- **`packages/events`** — `@cre/events`: the `eventEnvelopeSchema` (zod) and
  `eventSource()` helper; per-service event schemas added later.
- **`packages/authz`** — `@cre/authz`: `Role` / `Side` / `Scope` types,
  `ROLE_SIDE` map, `sideOf()`. The `can()` capability matrix + scope resolution
  land in Module 4.
- **`packages/platform`** — `@cre/platform`: structured JSON `log`; DynamoDB /
  EventBridge / HTTP-adapter helpers land with the first service that needs them.
- **`web/`** — Vite + React + TS SPA shell (one placeholder page + a render test).
- **`infra/`** — CDK v2 app; `SharedStack` empty shell pinned to
  `581759697181` / `us-east-2`; a synth test. Real resources in Module 2.
- Verification: `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`
  (10 tests pass), `pnpm lint`, `pnpm --filter infra synth` — all green.
- One fix along the way: pinned `web` to Vite 5 to match the Vite that `vitest@2`
  bundles (Vite 6 caused a plugin-type mismatch).

---

## 12 — Module 2: SharedStack + edge

> [After reviewing the full module list] Looks good. Let's go to Module 2 then.

**Context:** first real infrastructure module.

**Architecture refinement made here:** Cognito moved **out** of `SharedStack`
into the Accounts stack (Module 3). If SharedStack owned the user pool while
Accounts owned the post-confirmation trigger and the `/me` routes (which need
SharedStack's API), the stacks would depend on each other cyclically. Accounts
now owns the user pool + app client + hosted-UI domain + trigger + the shared
JWT authorizer; SharedStack has no Cognito dependency. All cross-stack wiring is
via SSM parameters (`infra/lib/param-names.ts`).

**Outcome — `SharedStack` (verified by synth + 8 unit tests):**

- EventBridge custom bus `cre-portal-bus`.
- One edge API Gateway **HTTP API** with a public `GET /v1/health` route backed
  by an inline arm64 Node 22 Lambda (X-Ray active) — the deploy smoke test.
- SPA hosting: private S3 bucket (`BLOCK_ALL`, `DESTROY` + `autoDeleteObjects`)
  behind CloudFront with OAC, HTTP/2+3, `PRICE_CLASS_100`, and 403/404 → 200
  `/index.html` for client-side routing.
- Context-gated SES sender identity (`-c senderEmail=…`).
- Seven `/cre-portal/shared/*` SSM parameters (bus, api id/endpoint, web bucket,
  distribution id/domain) for service stacks to consume.
- Corrected the design doc: HTTP APIs don't support X-Ray active tracing (only
  REST APIs do) — tracing is Lambda-layer + correlation-id propagation.

Not deployed yet (needs `aws login`); `pnpm --filter infra synth --strict` is
clean and all 17 workspace tests pass.

---

## 13 — Module 3: Accounts service + Cognito

> Should we get back to it? The auth module is the next one right? Let me take a
> look before we start implementation.
>
> 1. Let's do the lightweight solution for now. However, make note of Amplify
> being the better option since it provides MFA amongst other benefits.
> 2. Fine using runtime configs. 3. Yes, that's ok. 4. Deploy now.

**Context:** the auth module. User reviewed the plan first, then chose:
`react-oidc-context` over Amplify (noting Amplify is the better production
choice — MFA etc.), a runtime `/config.json`, Cognito's built-in email sender,
and to deploy at the end.

**Outcome — verified by 48 tests + `cdk synth --strict`:**

- **`packages/platform`** grew real implementations: `logger` (structured JSON +
  `child()`), `ddb` (memoized DocumentClient), `bus` (`publish()` — envelopes
  each event, batches at 10, checks `FailedEntryCount`), `http` (`router()`
  API-Gateway-v2 adapter: correlation id, JWT-claims → `userId`, JSON parse,
  `HttpError` → response, structured logs; `parseBody()` zod guard).
- **`services/accounts`** — `repo` (profile item: get / conditional create /
  partial update), `handler` (`GET`/`PUT /v1/me` with a zod patch schema),
  `post-confirmation` (Cognito trigger → provisions the profile row + publishes
  `account.created`; idempotent on trigger retry).
- **`infra/lib/accounts-stack.ts`** — `accounts` DynamoDB table + `gsi-email`;
  Cognito user pool (self-sign-up, email alias, `DESTROY`), public SPA app
  client (no secret, auth-code + PKCE, 1 h tokens, revocation on), hosted-UI
  domain `cre-portal-<account>`; post-confirmation trigger; two `NodejsFunction`
  Lambdas (arm64, Node 22, X-Ray); `HttpJwtAuthorizer` + JWT-authorized
  `GET`/`PUT /v1/me` routes on the imported edge API; 4 SSM params.
- **`web`** — runtime `/config.json` loader, `react-oidc-context` `AuthProvider`,
  a sign-in/sign-out gate, and a `Home` view that reads and edits `/v1/me`.
- Design doc: added an "SPA auth client" alternatives row and a Future-work
  bullet — **Amplify Auth is the better production choice** (MFA, managed flows,
  refresh-token rotation, `cookieStorage`).
- Fixes en route: `esbuild` had to be a **root** dev-dependency for
  `NodejsFunction`'s pnpm bundling to find it; `Stack.addDependency` →
  `addStackDependency`.

**Deployed** to `581759697181` / `us-east-2` (`aws login` done by the user):

- `CrePortalShared` (~3.5 min, CloudFront) + `CrePortalAccounts` (~1 min).
- Outputs: CloudFront `https://d2nvvjs357ot5x.cloudfront.net`, edge API
  `https://d1016hsgh5.execute-api.us-east-2.amazonaws.com`, hosted UI
  `https://cre-portal-581759697181.auth.us-east-2.amazoncognito.com`, user pool
  `us-east-2_NEfKsWuON`.
- `scripts/sync-config.mjs` (`pnpm sync-config`) wrote `web/public/config.json`
  from the outputs (non-secret IDs, committed); `web` built + synced to the S3
  bucket; CloudFront invalidated.

**Verified live:**
- `GET /v1/health` → 200; `GET /v1/me` without a token → 401 (JWT authorizer).
- All 11 `/cre-portal/*` SSM parameters present.
- End-to-end: `sign-up` → `admin-confirm-sign-up` fired the post-confirmation
  trigger → profile row written to DynamoDB → `USER_PASSWORD_AUTH` login →
  `GET /v1/me` → 200 → `PUT /v1/me` merged `company`/`phone`. Test users cleaned
  up.

Post-deploy tidy-ups: enabled `USER_PASSWORD_AUTH` on the app client (needed for
the seed script + E2E; hosted UI still uses PKCE); `repo` now strips DynamoDB
key attributes (`PK`/`SK`/`GSI1PK`) from the `/v1/me` response; added Node
globals for `.mjs` scripts in the ESLint flat config.

---

## 14 — Module 4: Deals service (core)

> Done. Let's discuss the deals service now.
>
> 1. Yes [invite token in the response]. 2. Yes [accept requires matching email].
> 3. Agreed [admin fixed = creator]. 4. Yes, go ahead — keep it response-only,
> never trust it as input [capabilities map]. 5. Sure, okay with stubs which will
> be featurized as part of future modules [authz matrix].

**Outcome — 97 workspace tests + 13 live E2E checks pass:**

- **`packages/authz`** — the real library: `roles` (predicates), `scope`
  (`visibleScopes` / `canSee`, four-scope model, full), `permissions` (`can()`
  matrix — deal + membership actions full; milestone/thread/document actions
  best-guess with `// refined in Module N`; `inviteLimits`, `inviteActionFor`,
  `capabilitiesFor`).
- **`packages/events`** — `zod` schemas for `deal.*` and `member.*` + a
  `dealEventSchemas` registry for contract tests.
- **`services/deals`** — `repo` (single-table `deals`: META / MEMBER / INVITE,
  GSI1 by-user, GSI2 by-email; `TransactWriteItems` for create + accept),
  `context.buildCtx`, and a 14-route handler: deal CRUD + dashboard + status,
  members list, invitations (create returns `{token, acceptUrl}`; who-can-invite
  + ≤2/≤2/≤7 buy-side limits enforced), preview + email-matched accept, role
  change + soft remove. Every mutation publishes its `deal.*` / `member.*` event.
- **`infra/lib/deals-stack.ts`** — `deals` table (2 GSIs) + one `DealsFn`
  (arm64 / Node 22 / X-Ray) + 14 JWT-authorized routes on the shared API +
  least-privilege IAM.
- **`web`** — `react-router-dom` enters: deals list, new-deal form, deal detail
  (members, invite form + acceptUrl, revoke, remove), accept-invite page.
- **Design refinement:** the admin *bootstraps* the buy side (there is no
  buy-side lead until a `BUYER`/`BUYER_AGENT` joins); after that those leads
  self-manage. §5.3, §6, §9, §10 updated. Route deviation from §9:
  `POST /v1/deals/{dealId}/invites/{token}/accept` (deal id in the path — no
  token→deal lookup).
- Fixes en route: `declaration: false` for service tsconfigs (TS2742 "portable
  type" on the Lambda handler); **per-service JWT authorizer names**
  (`cre-portal-jwt-<service>`) — API Gateway rejects duplicate authorizer names,
  which surfaced only on deploy (`CrePortalDeals` rolled back once, was deleted
  and re-created).

**Deployed** `CrePortalAccounts` (authorizer rename) + `CrePortalDeals`; SPA
rebuilt + synced. E2E: create → list → capabilities → non-member 403 → PATCH →
invite (acceptUrl) → preview → accept → buy-lead caps (2 ok, 3rd 409) →
cross-side invite 403 → cross-side remove 403 → pre-firm cancel 200.

---

## 15 — Module 5: milestones, checklists, handshake state machine

> [After discussing scope] 1. Yes [advance needs a buy-side lead]. 2. Yes [stage
> notes/dates: admin + buy-side lead]. 3. All five [handshake actions]. 4. Build
> it now [`GET /handshakes`].

**Outcome — 113 workspace tests + 11 live E2E checks pass:**

- **`services/deals/src/pipeline.ts`** — the fixed 6 stages + per-stage checklist
  templates.
- **`repo`** — `createDeal` now writes the 6 `STAGE#` rows in the create
  transaction; added stage / checklist (materialize-on-first-read) / handshake /
  `APPR#`-pointer functions + a generic `runTransaction`.
- **`services/deals/src/handshake.ts`** — the state machine: an applier registry
  (`advance_stage`, `close_deal`, `cancel_deal`, `edit_price`, `edit_dates`,
  `delete_document`), `initiate` (checks `can()`, pre-flights the effect,
  computes the counterparty-lead approvers, writes `HS#` + `APPR#` pointers) and
  `decide` (one `TransactWriteItems`: HS status + effect + pointer deletes;
  non-saga → `completed`, `delete_document` → `approved` + `awaiting_document`).
- **`stages.ts` / `handshakes.ts`** — 11 new routes; `deals.ts` recomposed as
  `router({ ...dealRoutes, ...stageRoutes, ...handshakeRoutes })`, its ad-hoc
  `publish` calls replaced with a shared `emit()`, `POST /status` now opens a
  handshake once firm, new `POST /terms` for price/date changes.
- **`@cre/events`** — 8 new schemas (`stage.*`, `handshake.*`, `checklist.*`).
- **`@cre/authz`** — `editStageMeta`, `handshakeApproverSide`,
  `isHandshakeApprover`, `initiateActionFor`, `HANDSHAKE_ACTIONS`.
- **`web`** — `Milestones` component in the deal page (stage rail, request-advance
  button, current-stage checklist toggles, pending-handshake approve/reject) and
  a nav "N approvals waiting" badge from `GET /v1/handshakes`.
- Fix en route: `repo.table()` → exported `repo.tableName()` so the appliers can
  build `TransactItem`s without importing the private helper.

**E2E:** 6 stages · checklist materialized + toggled (doneBy stamped) · advance
before a buyer joined → **409** · advance handshake → buyer sees it in
`GET /v1/handshakes` → approves → stage 1 completed, stage 2 in progress ·
advance 2→3 → **firm flips true** · advance 3→4 rejected → stage unchanged ·
firm deal `POST /status CLOSED` → **202 handshake** → buyer approves → deal
`CLOSED`.

---

## 16 — Module 6: Chat service (first consumer)

> [After discussing scope] 1. Yes, include [activity feed]. 2. [polling
> clarified — 4 s on the open thread] Okay, 4s for #2 looks good. Go ahead with
> implementation. 3. Yes [opaque attachment refs]. 4. Good [consumer event set].

**Outcome — 133 workspace tests + a live E2E pass (after one fix):**

- **`ChatStack`** — the consumer pattern the later modules copy: an **API
  Lambda** on the shared HTTP API (10 routes) **plus** an **SQS-triggered
  `ConsumerFn`** fed by an **EventBridge rule** on `cre-portal-bus` matching
  `member.*` + `stage.advanced` / `handshake.approved`/`rejected` /
  `deal.status_changed`. Queue + DLQ (`maxReceiveCount: 5`),
  `reportBatchItemFailures` so only failed records retry.
- **`chat` table** — `THREAD#`, `MSG#<threadId>#<createdAt>#<msgId>`, `RCPT#`,
  `READ#`, `MEMBERVIEW#` (projection), `FEED#` (activity), `ttl`.
- **`consumer.ts`** — `member.*` → version-guarded `MEMBERVIEW#` upsert;
  system events → deduped `FEED#` items; `SQSBatchResponse` for partial retry.
- **`api.ts`** — threads (4 scopes, create rules per scope), `GET /threads`
  filtered by `visibleScopes` against the local projection, channel→side-private
  conversion (drops the other side's agent/attorney, appends a system message),
  messages (soft edit/delete + `history[]`), receipts (frozen recipient set at
  send; `sent`/`received`/`read` rollup), `GET /activity`.
- **`@cre/events`** — `chat.ts` (`thread.created`/`converted`,
  `message.posted`/`edited`/`deleted`).
- **`web`** — a `Chat` panel in the deal page: thread list, 4 s message poll +
  auto mark-read, compose box, new-thread form, activity feed.
- **Fix:** `upsertMemberView` tried to `SET PK`/`SET SK` in an
  `UpdateExpression` — DynamoDB rejects assigning key attributes, so every
  consumer record failed (`Cannot update attribute SK`). Dropped them; `dealId`/
  `userId` set via `if_not_exists`. Consumer test now asserts the expression
  never assigns `PK`/`SK`.

**E2E:** admin's `member.joined` syncs the `MEMBERVIEW#` (a few seconds) → admin
opens a deal-wide thread + posts → buyer + buyer-agent invited & synced → buyer
sees the thread + message, replies → admin's receipt rolls up to `received` →
buyer's `side_private:buy` thread is invisible to the sell-side admin →
buyer-agent opens `channel:agent`, converts it to `side_private:buy` → admin
(other-side agent) loses it, buyer gains it → activity feed shows the member
joins.

---

## 17 — Module 7: Documents service (versioned room, category matrix, delete saga)

> 1, 2, 3 recommended. 4: matrix

Four decisions on the Module 7 plan: (1) the **full event-driven delete saga**
(adds a small Deals consumer) rather than a synchronous internal call;
(2) **optimistic upload** — write the `DOC#` row + `document.uploaded` when
metadata is submitted, the browser `PUT`s the bytes to S3 separately;
(3) emit **`document.accessed`** on every view / download; (4) implement the
design §6 **role→category visibility matrix**.

**Outcome — 148 workspace tests green; `cdk synth --strict` clean:**

- **`@cre/authz/documents.ts`** — `DOCUMENT_CATEGORIES` (8) + `categoryVisible`
  / `canSeeDocument` implementing the §6 matrix: sell-side can't see Financing /
  Appraisal and only sees deal-wide Inspection; `LENDER` sees all but
  Inspection; `TITLE_AGENT` is limited to the shared categories; `OTHER` is
  gated by scope only. `canSeeDocument = canSee(scope) ∧ categoryVisible`.
- **`@cre/events/documents.ts`** — 10 zod event schemas incl.
  `document.delete_requested`, `document.archived {docId,hsId}`,
  `document.accessed {n,mode}`.
- **`@cre/platform/projection.ts`** — the `MEMBERVIEW#` upsert/getter/list
  helper extracted so Documents and the Deals consumer share it (takes the
  table name as a param; the Module 6 chat copy is left as-is).
- **`services/documents`** — `repo.ts` (`DOC#` / `DOCVER#<n>` / `DOCREQ#`,
  `TransactWriteItems` create, version bump, `archivedAt` via `if_not_exists`),
  `s3.ts` (presigned `PUT` / `GET`, 300 s TTL, `attachment` vs `inline`
  disposition), `api.ts` (13 routes), `consumer.ts` (`member.*` → projection;
  `handshake.approved`/`delete_document` → archive + `document.archived`).
- **`services/deals/consumer.ts`** (new) — SQS off `cre.documents`:
  `document.delete_requested` → rebuild `AuthzContext` from the deal +
  `handshake.initiate(delete_document)` (idempotent per `docId`; permanent
  `HttpError` dropped, transient retried); `document.archived` →
  `completeHandshakeSaga`.
- **`infra`** — `DocumentsStack` (table + **private S3 bucket**, BLOCK_ALL +
  CORS `PUT`/`GET` for the SPA origins, `autoDeleteObjects`; API Lambda +
  consumer Lambda + queue/DLQ/rule). `DealsStack` gains the delete-saga
  consumer + queue/DLQ/rule. Dropped the now-unreferenced `httpApiEndpoint`
  SSM read from both the chat and documents stacks so `cdk synth --strict`
  is warning-free.
- **`web`** — a `Documents` panel: upload (metadata → presigned `PUT`), version
  list + add-version, view / download (opens the presigned URL),
  promote → deal-wide, request-delete (starts the handshake), and the
  document-request list with fulfil / decline / cancel.

---

## 18 — Module 8: Audit service (append-only trail, no god view)

> [Four decisions on the plan] 1. Enrich events at the producer (recommended).
> 2. IAM PutItem-only + deterministic-SK idempotency (recommended). 3. CSV +
> JSON export, capped at latest 10k rows (recommended). 4. [on skipping
> dealId-less events] "Which events wouldn't have any dealId?" → only
> `account.created`. → **Skip it in v1, start building module 8.**

**Outcome — 191 workspace tests green; `cdk synth --strict` clean:**

- **Event enrichment (producers).** Added a `scope` field to every auditable
  event that lacked one: `message.edited` / `message.deleted` (chat) and
  `document.versioned` / `document.promoted` / `document.archived` /
  `document.accessed` / `docrequest.fulfilled` / `.declined` / `.cancelled`
  (documents). Scope is now authoritative from the service that holds the row —
  the Audit consumer never guesses (a wrong guess would leak a side-private
  action across sides).
- **`services/audit`** — `consumer.ts` (SQS off a `source: [{prefix:'cre.'}]`
  rule → every event; `member.*` also feed the projection; `dealId`-less events
  skipped), `describe.ts` (`summarize` → human-readable action/target/summary
  per event type, with a safe default), `scope.ts` (`deriveScope` +
  `viewerScopes` = `@cre/authz` `visibleScopes`), `repo.ts` (deterministic
  `AUDIT#<occurredAt>#<eventId>` SK + `attribute_not_exists` → idempotent, no
  SEEN marker), `api.ts` (`GET /audit` scoped + filtered + cursor-paginated;
  `GET /audit/export?format=csv|json` capped at 10k, returned as an `attachment`
  download).
- **`@cre/platform` router** — a `raw` `RouteResult` escape hatch so the export
  endpoint can return real `text/csv` instead of a JSON envelope.
- **`infra/lib/audit-stack.ts`** — **two** tables: `audit` (append-only —
  consumer role gets `dynamodb:PutItem` and nothing else) and `audit-membership`
  (the mutable `member.*` projection, kept out of the append-only grant so it
  can `UpdateItem`). API Lambda is read-only on both. Queue + DLQ; rule matches
  all `cre.*` via a source prefix.
- **`web`** — an `Audit` panel: actor / action / date-range filters, a scoped
  table ("no cross-side view"), and CSV / JSON export via a client-side Blob
  download.
- **docs** — `02-design.md` §7.2 / §8.6 (two-table split, deterministic SK) /
  §8.8 (scope fields) / §9 (audit routes + filters) / §11 (IAM append-only) /
  §16 (account-lifecycle audit + audit-at-scale as future work).
