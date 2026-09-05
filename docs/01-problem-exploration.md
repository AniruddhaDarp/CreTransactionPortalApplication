# Problem Exploration

## The brief

> *"Imagine you are a staff software engineer at a commercial real estate company.
> Identify a meaningful problem worth solving and build a working solution for it."*

That is the entire specification. No problem, no users, no constraints given.
This document records the problems I considered, what I found researching each,
and why I chose the one I built.

My filter for "meaningful and worth building here":

1. **Real cost** — measurable money or time lost today, ideally getting worse.
2. **Clear users** — a specific set of people whose job this touches.
3. **A genuine gap** — not already solved well by an incumbent.
4. **Buildable in the time** — a defensible vertical slice without needing data
   or integrations I can't get for a prototype.
5. **Exercises real engineering** — architecture and tradeoffs worth discussing,
   not a CRUD form.

## Candidate problems

### 1. Lease critical-date management

Commercial leases bury money-critical dates — renewal-option notice windows
(typically 9–12 months before expiry), escalations, expirations, termination
rights, CAM caps. The renewal-notice deadline is both the most commonly missed
and the most financially damaging: miss it by a day and the option is gone.
Tracking is mostly spreadsheets, and studies put material-error rates in
spreadsheets around 88%. AI lease abstraction is now reported at 94–99% accuracy
with human validation.

**Why not chosen:** a strong problem, but crowded with capable incumbents (VTS,
Prophia, Occupier, LeaseAccelerator), and the interesting core is an LLM
extraction + evaluation pipeline — a narrower "systems" story than I wanted, and
problem identification here isn't novel.

### 2. CAM / operating-expense reconciliation

Landlords send an annual true-up of estimated vs. actual operating expenses;
tenants have a 90-day-to-12-month window to audit it. Disputes reliably cluster
around capital expenditures misclassified as operating expenses, management fees
on a grossed-up base, and double-dipped charges. Recoveries are real money.

**Why not chosen:** sharp and valuable, but narrow. A convincing demo needs a
corpus of leases plus their reconciliation statements, and the work is mostly a
rules engine plus arithmetic — less architecture to discuss.

### 3. The 2026 debt-maturity wall

Roughly $950B–$1.26T of CRE loans mature each year across 2025–2027, refinancing
into higher rates and stricter DSCR minimums (commonly 1.20x–1.35x). Lenders and
borrowers need covenant-compliance and refinance-risk monitoring across a loan
portfolio.

**Why not chosen:** macro-timely, but the software is essentially a
spreadsheet-replacement tracker. The hard part is acquiring borrower financials
each period — which I can't realistically source or fake well for a prototype.

### 4. Building Performance Standard penalties

16+ US jurisdictions now impose financial penalties for buildings over an
emissions cap — NYC Local Law 97 at $268 per metric ton of CO₂e over cap across
~50,000 buildings, DC BEPS up to $10/sf. Owners need per-building breach
forecasts and retrofit prioritization.

**Why not chosen:** differentiated and current, but it's jurisdiction-specific
rules (that change) plus data ingestion from ENERGY STAR Portfolio Manager — a
rules-and-data exercise, and it reads more as a sustainability-consultant tool
than something a staff engineer *at a CRE company* would own.

### 5. Executing the transaction — coordination across all parties

Closing a property purchase runs across email, text, personal inboxes, phone
calls, PDFs, e-sign tools, and shared drives, with no single source of truth.
Concretely:

- **No shared source of truth.** Standard failure modes: a message isn't
  relayed, someone takes a vacation day, a document goes missing → delays from
  "poor communication, manual workflows, and limited visibility into transaction
  progress."
- **Document version chaos + coarse permissions.** Multiple versions of the same
  document circulate with no clear current one; generic file sharing is
  folder-level only, so teams over-share or build unmanageable folder trees —
  when the buyer's environmental consultant should see the Phase I report but not
  the financials, and the lender needs financials but not litigation files.
- **No audit trail** of who disclosed what and when — which matters when a
  disclosure deadline or contingency is later disputed.

For backdrop on why the insecure, ad-hoc channel is costly: FBI IC3 2025
reported 12,368 real-estate-fraud complaints and $275.1M in losses, with
business email compromise at $3.04B overall, 86% moved by wire/ACH and usually
unrecoverable, and AI-generated impersonation now a named factor.

Existing tools are almost all **single-constituency** — built for the brokerage
(Dotloop, SkySlope, Brokermint), *or* the title/escrow company (Qualia,
Snapdocs), *or* the lender, *or* wire-fraud prevention (CertifID, Closinglock),
*or* CRE due-diligence data rooms (Intralinks, Datasite, Dealpath). The buyer,
seller, and the two attorneys are typically bolted on as guests.

## The problem I chose

**The coordination gap in problem 5: there is no neutral, multi-party workspace
for a property transaction where every party — buyer, seller, both agents, both
attorneys, lender, title — is a first-class member.** The build targets three
sub-problems:

- **(2)** one shared source of truth per deal — threaded communication, visible
  to the right parties;
- **(3)** a document room with explicit versioning and role-scoped access;
- **(4)** an append-only audit trail of every message, upload, version, access
  grant, view, and download.

Why this one, against the filter:

- **Real cost:** transaction delays and disputes are chronic and well
  documented; the insecure channel also enables the fraud losses above.
- **Clear users:** the six-to-eight named parties on any deal, plus the
  transaction coordinator whose whole job is running this manually.
- **Genuine gap:** the neutral, all-parties-first-class workspace doesn't exist
  in a widely adopted form.
- **Buildable:** the coordination layer is deal-type-agnostic — it needs auth,
  authorization, document handling, and an audit log, not MLS/title/lender
  integrations or a proprietary data corpus.
- **Exercises real engineering:** identity and multi-party invitations, a
  role→capability permission model enforced server-side, a four-way
  visibility-scope model, secure document access via short-lived URLs, a
  dual-approval ("handshake") workflow for irreversible actions, and
  audit-log integrity — all worth defending.

The repository name (`CreTransactionPortalApplication`) keeps the framing
commercial; the standard commercial purchase process (PSA negotiation →
attorney review → due diligence → financing → title & survey → closing) is the
milestone backbone. The coordination layer itself would apply with minor changes
to residential purchases too.

## Scope

**In scope for the prototype:** one deal type (a property purchase that has
already reached an accepted offer), a fixed party/role set, the six-stage
milestone backbone with per-stage checklists, four-scope threaded messaging,
message delivery/read receipts, a versioned + permissioned document room with
document requests, a dual-approval handshake for gated actions, an append-only
scoped audit log with export, an in-app notification centre, real
authentication, and email invitations — deployed and working with seed data.

**Deferred (see `docs/02-design.md` → Future work):**

- **Problem 1 — secure funds & identity:** verified party identities and
  tamper-evident, in-platform delivery of wire/payoff instructions. The
  highest-value extension; a stretch goal for this build, otherwise next.
- **Problem 5 — deadline & contingency automation:** turning the milestone
  checklists into tracked deadlines with lead-time alerts.
- In-app bidding / pre-contract sourcing, e-signature, integrations, real-time
  push, multi-tenant billing, mobile.
