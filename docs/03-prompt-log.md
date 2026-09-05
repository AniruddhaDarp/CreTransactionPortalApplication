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
