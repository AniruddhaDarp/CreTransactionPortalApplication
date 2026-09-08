# 05 — Full-deal walkthrough

One scripted scenario that carries a single commercial purchase from **offer
accepted** to **closed**, exercising every feature along the way: membership &
invitations, all four chat scopes (plus a channel→side conversion), the
document room (versions, the role→category matrix, promotion, a delete saga,
document requests), the milestone pipeline with a handshake on every advance,
the price / date / status handshakes, recording payments with confirm/void
handshakes, e-signature, the audit trail (no god view), and notifications.

`docs/04-test-plan.md` is the per-feature matrix; this is the narrative
counterpart — run it top to bottom and you have touched the whole system.
Budget ~90 minutes.

---

## How to run this

**Environment (live):**

| | |
|---|---|
| SPA | https://d2nvvjs357ot5x.cloudfront.net |
| API | https://d1016hsgh5.execute-api.us-east-2.amazonaws.com |
| Hosted UI | https://cre-portal-581759697181.auth.us-east-2.amazoncognito.com |

**Accounts.** Run the seed script once to provision the nine-role cohort:

```sh
node scripts/seed.mjs
```

It also creates a sample deal — **ignore it**; this walkthrough builds its own
from scratch. Every seeded login uses the password **`CrePortalDemo!2026`**.

**Sessions.** You are nine people. Use at least a normal window **and** an
incognito window; a third profile helps. You can sign out / back in as you go,
but steps marked **⇄ two sessions** need two people signed in at once (a
handshake approval, message receipts, a thread conversion). Keep the SPA open in
each — panels poll on a timer (bell 30 s, threads/activity 15 s, open thread
4 s), so give notifications and projections a few seconds to land.

**API-only checks.** A handful of steps are marked **(API)** — they are awkward
in the browser (limit 409s, wrong-email refusals, audit export). Have a shell
ready:

```sh
API='https://d1016hsgh5.execute-api.us-east-2.amazonaws.com'
tok() {
  aws cognito-idp initiate-auth --region us-east-2 \
    --client-id 2fdcqgqaqcqq9n49qv1qmjd8is --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters USERNAME="$1",PASSWORD='CrePortalDemo!2026' \
    --query 'AuthenticationResult.IdToken' --output text
}
TOK=$(tok seed-buyer@cre-portal.example)
curl -s -H "authorization: Bearer $TOK" "$API/v1/handshakes" | jq
```

**Known gaps you will hit (not bugs):**

- **Email is off.** Invitations do not send mail — the invite call returns an
  `acceptUrl` link; copy it to the invitee.
- **`GET /v1/me` / the Profile page 404s for seeded logins** (they are created
  by `admin-create-user`, which skips the profile trigger). Deals, chat,
  documents, etc. all work — just don't judge the Profile page.
- **Projection lag.** For ~2–10 s after someone joins a deal, their chat /
  documents / audit calls 403 with "membership may not be synced yet", then
  200. Wait and retry.
- **Polling, not push.** Nothing is real-time; the timers above drive refresh.

---

## The cast

| Person | Login (`@cre-portal.example`) | Role | Side |
|---|---|---|---|
| **Selena Ortiz** | `seed-selleragent` | SELLER_AGENT | sell — **deal admin** |
| **Sam Reed** | `seed-seller` | SELLER | sell |
| **Priya Nair** | `seed-sellerattorney` | SELLER_ATTORNEY | sell |
| **Bianca Cho** | `seed-buyer` | BUYER | buy — **buy-side lead** |
| **Diego Ramos** | `seed-buyeragent` | BUYER_AGENT | buy — **buy-side lead** |
| **Marcus Lin** | `seed-buyerattorney` | BUYER_ATTORNEY | buy |
| **Fatima Khan** | `seed-lender` | LENDER | buy |
| **Owen Pratt** | `seed-inspector` | OTHER (inspector) | buy (assigned) |
| **Tara Vance** | `seed-title` | TITLE_AGENT | neutral |

Handshake shorthand: **either side initiates**, the **opposite side's lead**
approves — Selena for the sell side, Bianca *or* Diego for the buy side. The
lender, attorneys, title agent, and inspector are never approvers.

## The property

**1200 Congress Ave, Austin TX** — a 42,000 sf multi-tenant office building.
Accepted price **$14,250,000**, earnest money **$250,000**, target closing about
60 days out. Pick a real date ~60 days ahead for `targetClosingDate`
(`YYYY-MM-DD`).

---

## Act 1 — Stage 1: Offer Accepted / PSA Negotiation

### 1.1 Selena creates the deal

**As Selena.** New deal → address `1200 Congress Ave, Austin TX`, type
`office`, price `14250000`, earnest money `250000`, optionally a Label and a
target closing date (`<+60d>`).

→ Lands on the deal page. Status **ACTIVE**, milestone **1 / 6**, **not firm**.
Selena is **SELLER_AGENT + admin**. Keep this deal open in Selena's session for
the whole walkthrough.

> The `earnestMoney` figure lives on the deal record for reference only. The
> money itself is handled where it matters — as a **recorded payment in step
> 2.4** (with the confirm handshake).

### 1.2 Selena builds the sell-side roster

**As Selena**, invite `seed-seller` as **SELLER** and `seed-sellerattorney` as
**SELLER_ATTORNEY**. Each invite shows an **invitation link** (email is off).
Copy each link into Sam's and Priya's sessions and accept.

→ The member list grows to four. All membership changes are auditable.

### 1.3 Selena brings in the buy-side leads

**As Selena**, invite `seed-buyer` as **BUYER** and `seed-buyeragent` as
**BUYER_AGENT**. Bianca and Diego accept from their own sessions.

→ The admin bootstraps the first buy-side leads; from here the buy side manages
its own roster.

### 1.4 The buy side self-manages its roster (and the limits)

- **As Bianca** (a buy-side lead), invite `seed-buyerattorney` as
  **BUYER_ATTORNEY** and `seed-lender` as **LENDER**. Accept both.
- **As Diego**, invite `seed-inspector` as **OTHER**, side **buy**. Accept.
- **(API) As Bianca**, try to invite a *third* `BUYER_AGENT`:
  `POST $API/v1/deals/<id>/invites {"email":"x@x.com","role":"BUYER_AGENT"}`
  → **409** (cap 2 agents). A third `BUYER_ATTORNEY` → **409** (cap 2). Keep
  inviting throw-away `BUYER`s until the buy side has **7** members — the next
  one → **409** (cap 7 total, all roles counted). Revoke the throw-aways
  afterward (they disappear from the pending list; that link then 409s on
  accept).

### 1.5 Selena invites the title company

**As Selena**, invite `seed-title` as **TITLE_AGENT**. Accept as Tara.

- **(API) As Bianca**, `POST .../invites {"role":"SELLER_ATTORNEY",…}` → **403**
  and `{"role":"TITLE_AGENT",…}` → **403**. Only the admin seats sell-side and
  neutral roles.

### 1.6 Kickoff — the deal-wide thread

**As Selena**, Communication panel → new thread **"Kickoff & logistics"**,
scope **deal-wide**. Post a welcome message that **@mentions Bianca**.

- **As Bianca**, within ~30 s the bell gains a **`mention`** notification that
  links to the thread.
- Post a plain reply (no mention) as Bianca → **no** new notification for
  anyone (plain messages only bump unread counts).
- Confirm everyone — including **Tara** (title) and **Owen** (inspector) — sees
  this thread.
- **As Owen** (OTHER), try to create a **deal-wide** thread → refused. Create a
  **side_private:buy** thread **"Diligence notes"** → OK. OTHER reads deal-wide
  but only writes inside its own side.

### 1.7 Side-private threads and the two channels

- **As Selena**, new thread **"Seller strategy"**, scope **side_private:sell** —
  Sam and Priya see it; **no one on the buy side does**.
- **As Bianca**, new thread **"Buy-side financing & diligence"**, scope
  **side_private:buy**.
- **As Selena** (an agent) → new **channel:agent** thread **"Agent
  coordination"**. Diego (the other agent) sees it; nobody else does.
- **As Priya** (an attorney) → new **channel:attorney** thread **"PSA
  redlines"**. Marcus sees it; nobody else — not even Selena the admin.
- **As Sam** (SELLER — neither agent nor attorney), try to create a channel
  thread → refused.

### 1.8 The draft PSA enters the document room

**As Priya**, Documents panel → upload the draft PSA. Category **Purchase
Agreement**, scope **deal-wide**, pick any small PDF.

- **As Marcus**, open the PSA drawer → **Download**. The link is a short-lived
  S3 URL (`X-Amz-…` query params). A few seconds later the Audit panel shows a
  **`document.accessed`** row, `mode: downloaded`.
- **As Marcus**, add a **new version** (any file) with redline notes. Current
  version → **v2**; v1 is still listed and downloadable.

### 1.9 Advance to Stage 2 — the first handshake ⇄ two sessions

**As Selena** (or Bianca — either side may start), Milestones panel → **Request
advance to Attorney Review**.

→ Response is **202** and a **pending handshake**. The stage has **not** moved.

**As Diego** (a buy-side lead — the counterparty), the approvals badge shows
**1 waiting**; open Milestones → **Approve**.

→ Milestone goes **1 → 2**. **Every** member — including Diego, who approved —
gets a **`stage_advanced`** notification (it is a deal-wide broadcast, not
feedback on your own click). Audit shows, in order:
`handshake.requested` → `handshake.approved` → `stage.advanced`.

Repeat once and **Reject** instead (as Diego, with a reason "need the redline
first"): the handshake drops, the stage is unchanged, Selena can re-initiate,
and the audit keeps `handshake.rejected`.

---

## Act 2 — Stage 2: Attorney Review  *(completing this makes the deal "firm")*

### 2.1 Attorneys finalise in their channel

**As Priya and Marcus**, exchange a few messages in **"PSA redlines"**.

- **As Marcus**, **edit** one of your messages → it shows **"(edited)"** with
  the new text. **Delete** another → **"[message removed]"**. Both are *soft*:
  the audit gets `message.edited` / `message.deleted` rows, and the original
  text is retained in the message's own history — never in the audit payload.
- **As Priya**, upload PSA **v3** (final draft). Current → v3.

### 2.2 A price reduction — always a handshake ⇄ two sessions

The parties agree to a **$250,000** credit for deferred maintenance.

**As Diego** (buy-side lead), deal terms → set price **`14000000`**.

→ **202** + a pending **`edit_price`** handshake (a price change is *always* a
handshake, firm or not).

**As Selena**, approve it. `GET $API/v1/deals/<id>` now shows
`price: 14000000`. Audit shows the `edit_price` handshake plus a `deal.updated`
row: `price: 14250000 → 14000000`.

### 2.3 Execute the PSA — e-signature ⇄ two sessions

**As Priya**, open the PSA drawer → **Send this document for signature** → tick
**Sam** (seller) and **Bianca** (buyer) → send.

→ A **`sent`** envelope appears with a status chip per signer (via `fake`).

- **As Sam**, the drawer shows a **Sign** button on that envelope → Sign. Your
  chip flips to `completed`; the envelope stays **`sent`** (Bianca hasn't
  signed).
- **As Bianca**, Sign. The envelope flips to **`completed`**, and PSA **v4** is
  written automatically with the note *"Signed via fake envelope …"*. Download
  v4 — it is a real PDF containing **"SIGNED COPY"**.
- Audit shows `signature.requested` → `signature.recipient_completed` →
  `signature.completed` **and** `document.versioned`. Everyone gets a
  **`signature_completed`** notification.

Now exercise the two negative paths on a throw-away document:

- **As Priya**, upload a "Disclosure addendum" (category **Disclosure**,
  deal-wide) and send it to **Sam**. **As Sam**, **Decline** with a reason. The
  envelope → **`declined`**, **no** new version is written, and Priya gets a
  **`signature_declined`** notification.
- **As Priya**, send that document for signature again, then — before anyone
  signs — **Void** it. Envelope → **`voided`**.
- **(API) Signer visibility is enforced.** As Bianca, try to send a
  buy-side-private / Financing document with **Sam** (sell side) as a signer:
  `POST .../signature {"signerUserIds":["<Sam's sub>"]}` → **400** "signer …
  cannot see this document", and no envelope is created.

### 2.4 Record the earnest-money deposit — payment + confirm handshake ⇄ two sessions

Bianca has wired the **$250,000** earnest money to escrow.

**As Bianca** (buy-side lead), **Payments** panel → **Record a payment**:
kind **earnest_money**, amount **250000**, method **wire**, payer **buyer**,
payee **escrow**, reference "FED-…", paid-on today.

→ **201**, row status **`recorded`**, and a **`confirm_payment`** handshake
opens automatically. Bianca sees **no** approve button for it — you cannot
confirm your own payment — and it is **absent** from Bianca's
`GET $API/v1/handshakes`.

**As Selena** (counterparty lead), Milestones → approve the `confirm_payment`
handshake.

→ Payment status → **`confirmed`**, `confirmedBy` = Selena. Every member gets a
**`payment_confirmed`** notification. Audit: `payment.recorded` ("… pending
confirmation") → `payment.confirmed`.

*(In the portal's model the counterparty lead confirms receipt; a
title-company-as-escrow-agent confirmer is noted as future work in
`docs/02-design.md §16`.)*

- **(API) Non-leads cannot record.** As **Sam**, **Marcus**, **Fatima**, or
  **Owen**: `POST .../payments {…}` → **403**.

### 2.5 Advance to Stage 3 — the deal becomes firm ⇄ two sessions

**As Selena**, Request advance to **Due Diligence**. **As Bianca**, approve.

→ Milestone **2 → 3**, and the deal's **firm** flag flips **true** (completing
Attorney Review = firm). The SPA shows a **"Firm"** pill; the `stage.advanced`
event carries `firmNow: true`; the notification reads "… it is now firm".

**From here, date changes and close/cancel are also handshakes.**

---

## Act 3 — Stage 3: Due Diligence

### 3.1 Document requests — fulfil, decline, cancel

**As Diego**, Documents panel → create a **document request** targeting the
**role `SELLER`**: "Current rent roll + trailing-12 operating statement",
scope deal-wide.

- **As Sam**, the bell shows **`docrequest_assigned`**. Upload the rent roll
  (category **Other**, deal-wide) and **fulfil** the request by linking it.
  Diego gets **`docrequest_fulfilled`**; the request → **`fulfilled`**.
- **As Diego**, create a second request targeting **Tara by name** for the
  title commitment. **As Tara**, **decline** it with a reason ("ordered — not
  back yet") → **`declined`**, Diego notified.
- **As Diego**, create a third request and **cancel** it yourself →
  **`cancelled`**.

### 3.2 The inspector works inside the buy side (OTHER, scoped + matrixed)

**As Owen** (OTHER), upload the **Phase I ESA** — category **Inspection**,
scope **side_private:buy** (OTHER can only write to its own side's private
scope).

Check who can see it:

| Viewer | Sees the Phase I? | Why |
|---|---|---|
| Bianca, Diego, Marcus | **yes** | buy side, side-private |
| **Fatima** (LENDER) | **no** | Inspection is hidden from the lender |
| Selena, Sam, Priya | **no** | sell side + side-private |
| **Tara** (TITLE) | **no** | Inspection is hidden from title |

- **As Owen**, post findings in the buy-side-private thread. Then try to post in
  the **deal-wide** "Kickoff" thread → refused.

### 3.3 Promote a side-private document

The Phase I is clean; the buy side chooses to disclose it.

**As Diego** (a non-OTHER buy-side member), open the Phase I → **Promote →
deal-wide**.

→ Scope becomes `deal_wide`. **Selena** can now see it (once Inspection is
deal-wide the sell side may view it). **Tara** and **Fatima** still cannot
(their category rules don't depend on scope). Promote again → **409**. As
**Owen**, the Promote control is absent / **403**.

### 3.4 Delete a stale document — the handshake saga ⇄ two sessions

Someone uploaded a wrong file earlier (use any deal-wide doc you don't need).

**As Bianca** (buy-side lead) — or Selena — open it → **Request delete**.

→ **202**, and the document is **still there**. Within a few seconds a
**`delete_document`** handshake appears (this one is a cross-service saga:
Documents emits the request, the Deals service opens the handshake).

**As Selena** (counterparty lead), approve.

→ The document is archived — `GET .../documents/<id>` → **404**, it drops off
the list — the handshake goes **`completed`**, and **`document.archived`** is in
the audit.

- **As Marcus** (BUYER_ATTORNEY, not a lead), try **Request delete** on another
  doc → **403**.

### 3.5 An extension fee — record, confirm, then void ⇄ two sessions

Diligence needs 10 more days; the parties agree a **$15,000** extension fee,
buyer → seller.

**As Diego**, Payments → record: kind **extension_fee**, amount **15000**,
method **check**, payer **buyer**, payee **seller**. **As Selena**, approve the
`confirm_payment` handshake → **`confirmed`**.

Then the check is returned. **As Diego**, on that payment → **Void** (reason
"check returned NSF").

→ A **`void_payment`** handshake opens (voiding is *always* a handshake, even
for a confirmed payment). **As Selena**, approve → status **`void`**. Every
member gets **`payment_voided`**. A second Void on it → **409**.

### 3.6 Move the closing date — now a handshake (deal is firm) ⇄ two sessions

The extension pushes closing out 10 days.

**As Selena**, deal terms → set `targetClosingDate` to `<+10 days>`.

→ Because the deal is firm this is **202** + an **`edit_dates`** handshake, not
an immediate change. **As Bianca**, approve. Audit shows `deal.updated` with the
date diff.

*(For contrast: the same edit on a **not-yet-firm** deal is a direct **200**.
You can only see that on a different, pre-Attorney-Review deal.)*

### 3.7 Advance to Stage 4 ⇄ two sessions

Request advance to **Financing** → approve. Milestone **3 → 4**.

---

## Act 4 — Stage 4: Financing

### 4.1 Lender documents (the category matrix again)

**As Fatima** (LENDER), upload the **loan commitment letter** — category
**Financing**, scope **side_private:buy**.

| Viewer | Sees it? |
|---|---|
| Bianca, Diego, Marcus | **yes** |
| Selena, Sam, Priya | **no** — Financing is hidden from the sell side (at any scope) |
| **Tara** (TITLE) | **no** — Financing is hidden from title |

- **As Fatima**, post in the buy-side-private thread to coordinate the
  appraisal. Fatima is a full buy-side member (reads buy-private, posts,
  uploads) but is **not** a handshake lead and **cannot** invite anyone —
  confirm the invite form is absent.

### 4.2 Convert the agent channel to side-private ⇄ two sessions

The buy side wants everyone to see the agent coordination.

**As Diego**, open **"Agent coordination"** (channel:agent) → **Convert to
buy-side**.

→ The thread moves to **side_private:buy**, a **system message** is appended,
the **whole buy side** (Bianca, Marcus, Fatima, Owen) now sees it, and
**Selena** — the other agent — **loses** it and gets a **`thread_converted`**
notification ("… you were removed").

### 4.3 Check the activity feed

**As Bianca**, open the deal's **Activity** tab — it shows member joins, stage
advances, handshake outcomes, uploads and status changes, all **scoped** to what
Bianca may see (no sell-private items).

### 4.4 Advance to Stage 5 ⇄ two sessions

Request advance to **Title & Survey** → approve. Milestone **4 → 5**.

---

## Act 5 — Stage 5: Title & Survey

### 5.1 Title work (neutral role)

**As Tara** (TITLE_AGENT), upload the **title commitment** and the **ALTA
survey**, both category **Title**, scope **deal-wide**. Title-category
documents are visible to **both** sides. Post an update in the deal-wide
thread.

Confirm Tara's neutrality:

- No side-private thread or channel is visible to Tara — only deal-wide.
- Tara has no invite / remove controls.
- Tara never appears as a handshake approver (`GET $API/v1/handshakes` as Tara
  is empty even while handshakes are pending).

**As Priya**, upload a curative document (category **Title**) for one title
exception.

### 5.2 Advance to Stage 6 ⇄ two sessions

Request advance to **Closing** → approve. Milestone **5 → 6**.

---

## Act 6 — Stage 6: Closing

### 6.1 Closing funds ⇄ two sessions

**As Bianca**, Payments → record the buyer's closing wire: kind
**closing_funds**, amount **`13750000`** (the $14,000,000 reduced price less the
$250,000 earnest money already on deposit), method **wire**, payer **buyer**,
payee **escrow**. **As Selena**, approve the confirm handshake →
**`confirmed`**.

**As Diego**, record the lender's proceeds as a second **closing_funds**
payment, payer **lender**, payee **escrow** (a lead records on the lender's
behalf; lender-initiated recording is future work). Leave **"Counts toward the
purchase price" unticked** — the lender's wire is a *funding source*, not an
additional payment on the price (it defaults off for `payer = lender`). **As
Selena**, confirm. The Payments-tab price tally stays at the accepted price.

### 6.2 Settlement statement & deed

- **As Tara**, upload the **settlement statement** — category **Closing**,
  deal-wide.
- **As Priya**, upload the **deed** (category **Closing**) and **send it for
  signature to Sam** (the grantor). **As Sam**, Sign → envelope `completed`, a
  signed deed version is written.

### 6.3 Close the deal — the last step of the pipeline ⇄ two sessions

**As Selena**, Milestones tab → with the deal in stage 6 (Closing) the advance
control reads **"Request deal completion (close)"** → click it, add a note
("funded & recorded").

→ Because the deal is firm this is **202** + a **`close_deal`** handshake, not
an immediate close — it appears in the Pending handshakes card and the Actions
tab. **As Bianca**, approve.

→ Status → **CLOSED**, `actualClosingDate` is set to today. Every member gets a
**`deal_closed`** notification.

### 6.4 The workspace is now read-only

The deal page still renders fully for everyone — threads, every document
version, the audit, the payments ledger all remain. But:

- posting a message, starting/converting/deleting a thread → **409**
- uploading a document or a new version, promoting, deleting, creating or
  resolving a document request, sending for signature / signing → **409**
- Request deal completion / Record a payment → **409**

Every write returns `the deal is closed — the workspace is read-only`. Reads
(threads, messages, every document version, the audit, payments) all still work.

The deal is a **permanent, frozen record**.

---

## Act 7 — Prove the audit trail (no god view)

This is the payoff for "who saw / changed / disclosed what". Open the **Audit**
panel as several people.

**As Selena (sell-side admin):**

- Every `deal_wide`, `side_private:sell`, and `channel:agent` row is present.
- There is **no `side_private:buy` row** — no buy-private thread message, no
  buy-private document event, nothing from the Phase I before it was promoted.
- There is **no `channel:attorney` row** — the PSA-redlines channel is invisible
  to Selena even though she is the admin.
- **(API)** Export both formats and confirm the same scoping:
  ```sh
  TOK=$(tok seed-selleragent@cre-portal.example)
  curl -s -D - "$API/v1/deals/<id>/audit/export?format=csv" -H "authorization: Bearer $TOK"
  curl -s "$API/v1/deals/<id>/audit/export?format=json" -H "authorization: Bearer $TOK" | jq '.count'
  ```
  `text/csv` / `application/json` attachments, no buy-private rows. `?format=xml`
  → **400**.

**As Bianca (buy-side lead):** the mirror image — buy-private and agent-channel
rows present, **zero `side_private:sell`**, zero attorney channel.

**As Marcus (BUYER_ATTORNEY):** sees the `channel:attorney` rows that **Bianca**
does not.

**As Tara (TITLE):** `deal_wide` rows only.

**Filters (any viewer):** `?action=stage.advanced` → only the five advance
rows. `?actor=<a user's sub>` → only that actor. `?from=2099-01-01` → empty.
`?targetType=payment` → only the payment rows.

**The headline: not even the admin sees the other side's private activity.**

---

## Coverage — what this walkthrough exercised

| Area | Steps |
|---|---|
| Deal creation, fields, admin, statuses | 1.1, 6.3, 6.4 |
| Invitations (link-based), accept, wrong-side / wrong-role refusal, revoke | 1.2–1.5 |
| Buy-side self-management + limits (≤2 / ≤2 / ≤7) | 1.4 |
| Admin-only sell-side & neutral seating | 1.5 |
| OTHER — side-assigned, scoped read/write, no deal-wide | 1.6, 3.2 |
| TITLE — neutral, deal-wide only, never an approver | 5.1 |
| LENDER — full buy-side member, not a lead | 4.1 |
| 6-stage pipeline, forward-only, handshake per advance | 1.9, 2.5, 3.7, 4.4, 5.2 |
| Firm flip at Attorney Review; post-firm gating | 2.5, 3.6, 6.3 |
| Handshake — initiate (202), approve, reject, cross-deal `/handshakes` | 1.9, and throughout |
| `edit_price` (always), `edit_dates` (firm), `close_deal` (firm) | 2.2, 3.6, 6.3 |
| Payments — record, confirm handshake, void handshake, all kinds, deal-wide visibility, non-lead 403, deal-must-be-active | 2.4, 3.5, 6.1 |
| Chat — 4 scopes, create-permission matrix, @mention notify vs. plain | 1.6, 1.7 |
| Chat — soft edit / delete with retained history | 2.1 |
| Chat — channel → side-private conversion + drop notification | 4.2 |
| Chat — activity feed, scoped | 4.3 |
| Documents — upload, versioning, presigned URL + `document.accessed` logging | 1.8 |
| Documents — role→category matrix (LENDER / TITLE / sell-side negatives) | 3.2, 4.1 |
| Documents — side-private scope + promotion (one-way) | 3.3 |
| Documents — delete handshake saga; non-lead 403 | 3.4 |
| Document requests — create / fulfil / decline / cancel + notifications | 3.1 |
| E-signature — send, multi-recipient sign, completion + version write-back | 2.3 |
| E-signature — decline, void, signer-visibility enforcement | 2.3 |
| Audit — scoped read, **no god view**, filters, CSV / JSON export | Act 7, 1.8, 3.4 |
| Notifications — every type, actor exclusion, broadcast includes the actor, email off | throughout |
| Read-only after close | 6.4 |

---

## Cleanup

Leave the deal as a populated demo, or **as Selena** cancel it
(`CANCELLED`, which needs a handshake now that it is firm — or just leave it
`CLOSED`). The seeded logins persist until the next `node scripts/seed.mjs`
run, which deletes and recreates them.
