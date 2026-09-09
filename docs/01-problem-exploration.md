# Problem Exploration

## Candidate problems

### 1. Lease critical-date management

Commercial leases bury money-critical dates — renewal-option notice windows
(typically 9–12 months before expiry), ROFO/ROFR triggers, escalation dates,
expirations, termination rights, CAM-cap true-up windows. The renewal-notice
deadline is both the most commonly missed and the most financially damaging:
miss it by a day and the option is gone. Tracking is mostly spreadsheets, and
studies put material-error rates in spreadsheets around 88%.

**The technical problem:** a document-understanding pipeline feeding an alerting
engine. Ingest heterogeneous lease PDFs (scanned originals plus a chain of
amendments and estoppels), extract a normalized set of dated obligations,
reconcile the amendment chain to decide which clause is operative, attach
calibrated confidence, and route low-confidence extractions to human review —
then drive lead-time alerts and escalation off the resulting dates. The
engineering worth defending is the extraction-evaluation loop: a gold set,
precision/recall gates, and regression tests that catch drift when a model or a
prompt changes.

**Why not chosen:** the quality ceiling is set by the model and a labeled lease
corpus, not by system design, and I have neither. Without them the prototype
either runs on toy inputs or collapses to the same alerting engine the
transaction problem also needs. The distinctive engineering is one narrow slice
(the eval harness), and the space is crowded with capable incumbents (VTS,
Prophia, Occupier, LeaseAccelerator).

### 2. CAM / operating-expense reconciliation

Landlords send an annual true-up of estimated vs. actual operating expenses;
tenants have a 90-day-to-12-month window to audit it. Disputes reliably cluster
around capital expenditures misclassified as operating expenses, management fees
on a grossed-up base, and double-dipped charges. Recoveries are real money.

**The technical problem:** a lease-economics rules engine. Represent each
lease's expense provisions — exclusions, caps, gross-up percentage, base year,
pro-rata share, admin-fee basis — as structured, versioned rules; parse the
landlord's reconciliation statement into line items; recompute the tenant's
share deterministically; and emit an explainable line-by-line diff that cites
the governing clause for every discrepancy. The interesting part is the rule
representation — a small DSL for lease economics — and reproducible
recomputation.

**Why not chosen:** it is a closed, single-tenant computation — no multi-party
state, no concurrency, no authorization model, no workflow — so it exercises one
engineering muscle deeply and nothing else. Turning prose clauses into
structured rules is again a document-extraction task, and a convincing demo
needs paired leases and reconciliation statements that aren't publicly
available.

### 3. Building Performance Standard penalties

16+ US jurisdictions now impose financial penalties for buildings over an
emissions cap — NYC Local Law 97 at $268 per metric ton of CO₂e over cap across
~50,000 buildings, DC BEPS up to $10/sf. Owners need per-building breach
forecasts and retrofit prioritization.

**The technical problem:** an effective-dated rules engine over regulations that
change. Encode each jurisdiction's cap schedule (caps step down each compliance
period), fuel-to-CO₂e coefficients (periodically revised), and penalty formulas
as versioned rules keyed by effective date, so a compliance calculation for 2027
run today uses the coefficients as they will stand then and stays reproducible
when audited later. Layer on ingestion of monthly energy data (ENERGY STAR
Portfolio Manager API, utility feeds) and scenario modeling to rank retrofit
capital across a portfolio.

**Why not chosen:** the effective-dated rules engine is real, but most of the
work is encoding jurisdiction-by-jurisdiction rules that track legislation —
content that ages, not system design — plus one external-API ingestion adapter.
It also reads as a sustainability-consulting tool, further from the transaction
and asset-management systems a CRE engineering team actually owns.

### 4. Executing the transaction — coordination across all parties

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

**The coordination gap: there is no neutral, multi-party workspace
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
milestone backbone, four-scope threaded messaging,
message delivery/read receipts, a versioned + permissioned document room with
document requests, a dual-approval handshake for gated actions, an append-only
scoped audit log with export, an in-app notification centre, real
authentication, and email invitations — deployed and working with seed data.

**Deferred (see `docs/02-design.md` → Future work):**

- **Problem 1 — secure funds & identity:** verified party identities and
  tamper-evident, in-platform delivery of wire/payoff instructions. The
  highest-value extension; a stretch goal for this build, otherwise next.
- **Problem 5 — deadline & contingency automation:** tracked deadlines on the
  milestone stages with lead-time alerts and escalation.
- In-app bidding / pre-contract sourcing, e-signature, integrations, real-time
  push, multi-tenant billing, mobile.
