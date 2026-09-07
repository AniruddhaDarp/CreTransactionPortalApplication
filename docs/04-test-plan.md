# Manual Test Plan

Module-by-module walkthrough of the deployed app. Work top to bottom; most tests
run against the **seed deal** so there is little setup. Record pass/fail in the
[results log](#results-log) at the bottom.

`scripts/verify.mjs` already automates the design §14 acceptance checklist
(33 assertions). This plan is the wider manual pass — the SPA, the negative
cases, and the things the automated script doesn't touch.

---

## Setup

### Live environment

| | |
|---|---|
| SPA | https://d2nvvjs357ot5x.cloudfront.net |
| API | `https://d1016hsgh5.execute-api.us-east-2.amazonaws.com` (`$API` below) |
| Hosted UI | https://cre-portal-581759697181.auth.us-east-2.amazoncognito.com |

### Seed data

Run `node scripts/seed.mjs` first (idempotent — safe to re-run). It provisions
one deal and prints the logins; `scripts/seed-output.json` has the deep link.

**Password for every seeded user:** `CrePortalDemo!2026`

| Role | Login | Side |
|---|---|---|
| `SELLER_AGENT` (admin) | `seed-selleragent@cre-portal.example` | sell |
| `SELLER` | `seed-seller@cre-portal.example` | sell |
| `SELLER_ATTORNEY` | `seed-sellerattorney@cre-portal.example` | sell |
| `BUYER` | `seed-buyer@cre-portal.example` | buy |
| `BUYER_AGENT` | `seed-buyeragent@cre-portal.example` | buy |
| `BUYER_ATTORNEY` | `seed-buyerattorney@cre-portal.example` | buy |
| `LENDER` | `seed-lender@cre-portal.example` | buy |
| `OTHER` (inspector) | `seed-inspector@cre-portal.example` | buy |
| `TITLE_AGENT` | `seed-title@cre-portal.example` | neutral |

**Seed deal state after a fresh run:** stage 3 (Due Diligence), **firm** (it was
advanced through Attorney Review); 5 threads (one per scope); 4 documents (PSA
has 2 versions); an **open** document request for the `TITLE_AGENT`; and a
**pending `edit_price` handshake** (initiated by the buyer agent, awaiting the
admin) — so the approvals badge and a notification are live immediately.

### Two sessions

Scoping / "no god view" tests need two users signed in at once. Use a normal
window + an incognito window, or two browsers.

### API tests

Some endpoints aren't surfaced in the SPA (audit filters, receipt detail,
doc-request decline, notification mark-all). For those, get a bearer token for a
seeded user and use `curl`:

```sh
API='https://d1016hsgh5.execute-api.us-east-2.amazonaws.com'
tok() {
  aws cognito-idp initiate-auth --region us-east-2 \
    --client-id 2fdcqgqaqcqq9n49qv1qmjd8is --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters USERNAME="$1",PASSWORD='CrePortalDemo!2026' \
    --query 'AuthenticationResult.IdToken' --output text
}
TOK=$(tok seed-selleragent@cre-portal.example)
curl -s -H "authorization: Bearer $TOK" "$API/v1/deals" | jq
```

### Known gaps you will hit (not bugs)

- **Email is disabled.** No invitation or action-required email is sent.
  Invitations come back as a link (`acceptUrl`) the inviter shares.
- **`GET /v1/me` 404s for seeded users.** They are created with
  `admin-create-user`, which doesn't fire the profile-provisioning trigger.
  A genuine hosted-UI sign-up (test 2.x) does get a profile.
- **Projection lag.** After a member joins, their scoped views (chat, docs,
  audit) 403 for ~2–10 s until the `member.joined` event is consumed, then 200.
- **Polling, not push.** The bell (30 s), thread list / activity (15 s), open
  thread (4 s), approvals badge (30 s) refresh on a timer — give it a beat.

### Legend

`[SPA]` via the web app · `[API]` via `curl` · `[CLI]` via `aws`

---

## 1. Edge & hosting (Module 2)

**T1.1 `[API]` Health route** — `curl -s "$API/v1/health"` → `200`, small JSON
body. No auth required.

**T1.2 `[API]` Auth required elsewhere** — `curl -s -o /dev/null -w '%{http_code}'
"$API/v1/deals"` (no token) → `401`.

**T1.3 `[SPA]` App loads** — open the SPA URL → the shell renders, "Sign in"
button shown when logged out.

**T1.4 `[SPA]` SPA deep-link / history fallback** — while signed in, open
`…/deals/<seedDealId>` **directly** (paste the URL, new tab). It loads the deal
page, not a CloudFront 404. (CloudFront rewrites 403/404 → `index.html`.)

**T1.5 `[SPA]` Unknown path** — open `…/nonsense-path` → the app renders (falls
back to `index.html`), no raw error page.

---

## 2. Accounts & auth (Module 3)

**T2.1 `[SPA]` Hosted-UI sign-up** — sign out. Click "Sign in" → Cognito hosted
UI → "Sign up", use a **real** address you can receive mail at, confirm with the
emailed code. Redirects back to the SPA, signed in.
_(If the Cognito daily email cap is hit you'll see a limit error — that's the
same cap the seed script works around; try again later or skip.)_

**T2.2 `[SPA]` Profile provisioned** — as the T2.1 user, open **Profile**. Your
name/email show (the post-confirmation trigger created the row).

**T2.3 `[API]` `GET /v1/me`** — token for the T2.1 user → `GET $API/v1/me` →
`200` with your profile. For a **seeded** user → `404` (documented gap).

**T2.4 `[API]` `PUT /v1/me`** — `PUT $API/v1/me` `{"company":"Acme","phone":"512-555-0100"}`
as the T2.1 user → `200`, echoes the updated profile. Re-`GET` confirms.

**T2.5 `[SPA]` Session persists** — reload the SPA → still signed in (no
re-login). Sign out → returns to the logged-out shell; a protected route
redirects to sign-in.

**T2.6 `[API]` Garbage token rejected** — `curl -H "authorization: Bearer xxx"
"$API/v1/deals"` → `401`.

---

## 3. Deals, membership & invitations (Module 4)

**T3.1 `[SPA]` Create a deal** — as `seed-selleragent`, create a new deal
(address, property type, price, target close). Lands on its detail page; you are
`SELLER_AGENT` + admin. **Keep this deal for T3.x / T4.1a.**

**T3.2 `[SPA]` Non-admin cannot edit deal fields** — as `seed-seller` open the
seed deal. There is no edit control for address/type/price. `[API]` `PATCH
$API/v1/deals/<id>` `{"label":"x"}` as `seed-seller` → `403`.

**T3.3 `[SPA]` Dashboard** — the deal page shows stage progress (3 / 6 · firm),
member list, and (admin) the invite form.

**T3.4 `[SPA]` Invite + accept** — on your **T3.1** deal, as admin invite
`seed-buyer` as `BUYER`. You get an `acceptUrl`. Open it in the incognito
session signed in as `seed-buyer` → "join" → membership active.

**T3.5 `[SPA]` Wrong-email accept is refused** — take the T3.4 `acceptUrl` and
try to accept it while signed in as `seed-seller` → `403` "for a different email
address".

**T3.6 `[API]` Buy-side self-invite limits** — on your T3.1 deal, after
`seed-buyer` joined:
- as `seed-buyer`, invite `agent-a@x.com` + `agent-b@x.com` as `BUYER_AGENT` → both `201`.
- invite `agent-c@x.com` as `BUYER_AGENT` → `409` (cap 2 agents).
- invite `atty-a@x.com` + `atty-b@x.com` as `BUYER_ATTORNEY` → `201`; `atty-c@x.com` → `409` (cap 2).
- keep inviting `BUYER`s until the **7th** buy-side member is `201` and the **8th** is `409` (cap 7 total).

**T3.7 `[SPA]` Sell-side roster is admin-only** — as `seed-seller`, no invite
form. `[API]` `POST $API/v1/deals/<id>/invites` `{"email":"x@x.com","role":"SELLER_ATTORNEY"}`
as `seed-seller` → `403`.

**T3.8 `[API]` `OTHER` needs a side** — as admin, invite `{"role":"OTHER"}` with
no `side` → `400`; with `{"role":"OTHER","side":"buy"}` → `201`.

**T3.9 `[SPA]` Revoke a pending invite** — admin revokes one of the T3.6 pending
invites → it disappears from the list; the `acceptUrl` now `409`s on accept.

**T3.10 `[SPA]` Remove a member (managing side only)** — as admin on your T3.1
deal, remove a sell-side member you invited → row shows removed. `[API]` as
`seed-selleragent` try to remove a **buy-side** member → `403` (counterparty's
people). Removed member's scoped calls start 403ing within seconds.

**T3.11 `[API]` My deals** — `GET $API/v1/deals` as `seed-buyeragent` → includes
the seed deal with `myRole`.

---

## 4. Milestones & handshake (Module 5)

**T4.1 `[SPA]` Stage view** — seed deal shows 6 stages, 1 & 2 completed, 3 in
progress, target dates / notes where set.

**T4.2 `[SPA]` Advance requires a buy-side lead + a handshake** — as admin on the
seed deal, "Advance stage" → `202`, a pending handshake appears (not an
immediate stage change). As `seed-buyer` (approver): the approvals badge shows
"1 waiting"; approve → stage goes 3 → 4. Re-check as admin: `currentStage` is 4.

**T4.3 `[SPA]` Reject a handshake** — advance again (→ pending). As `seed-buyer`
reject with a reason → handshake drops, stage unchanged. Admin can re-initiate.

**T4.4 `[API]` Forward-only** — there is no "regress" control; `POST
$API/v1/deals/<id>/advance` only ever moves +1, and at stage 6 → `409`.

**T4.5 `[API]` Advance with no buy-side lead** — on a fresh deal with only
sell-side members, `POST …/advance` → `409` ("invite the buyer's side").

**T4.6 `[SPA]` Checklist** — open stage 3's checklist. Template items appear on
first view. Check two items → they persist on reload. As `seed-inspector`
(`OTHER`) checking an item → `403` (non-`OTHER` only).

**T4.7 `[API]` Edit price is always a handshake** — the seed deal already has one
pending (buyer agent → admin, $14.5M). As admin, `GET $API/v1/handshakes` →
shows it. Approve it → `GET $API/v1/deals/<id>` shows `price: 14500000`.

**T4.8 `[API]` Edit dates: unilateral pre-firm, handshake once firm** — on a
**fresh** (not-firm) deal, `POST …/terms {"targetClosingDate":"2027-01-31"}` as
admin → `200`, applied. On the **seed** deal (firm), same call → `202`, opens a
handshake.

**T4.9 `[API]` Close/cancel: unilateral pre-firm, handshake once firm** — fresh
deal: `POST …/status {"status":"CANCELLED","reason":"test"}` as admin → `200`,
deal `CANCELLED`. Seed deal (firm): same → `202`, deal stays `ACTIVE` with a
pending handshake.

**T4.10 `[SPA]` Read-only after close** — on the cancelled fresh deal, the SPA
shows it but posting a message / uploading a doc / advancing is refused
(`409`/read-only).

**T4.11 `[API]` `GET /v1/handshakes` is cross-deal** — as `seed-buyer`, the
response lists pending approvals from **every** deal they're a lead on, not just
one.

---

## 5. Chat (Module 6)

**T5.1 `[SPA]` Threads list is scoped** — as `seed-selleragent` open the seed
deal → you see *Kickoff & introductions* (deal-wide), *Seller disclosures & PSA
redlines* (sell-private), *Agent coordination* (agent channel). You do **not**
see *Buy-side financing & diligence prep* (buy-private) or *Contract redlines*
(attorney channel). As `seed-buyer` you see the deal-wide + buy-private ones,
not the sell-private one.

**T5.2 `[SPA]` Create thread — scope permission** — as `seed-buyer`: create a
`side_private:buy` thread → OK; try `side_private:sell` → refused. As
`seed-inspector` (`OTHER`): can create only `side_private:buy`. As
`seed-selleragent` (an agent): can create the `channel:agent` thread; as
`seed-seller` (not an agent) → refused.

**T5.3 `[SPA]` Post + @mention** — in the deal-wide thread, post a message
mentioning `seed-buyer`. As `seed-buyer`, the bell gains a **mention**
notification (within ~30 s). Post a plain message (no mention) → **no** new
notification.

**T5.4 `[SPA]` Soft edit / delete** — edit your message → shows "(edited)", new
text. Delete another → shows "[message removed]". Neither is truly gone (the
audit log keeps the original — see T7/T8).

**T5.5 `[SPA]` Receipts sent → received → read** _(needs 2 sessions)_ — as
`seed-selleragent` post a fresh message in a thread with `seed-buyer` +
`seed-buyeragent`. `[API]` `GET
$API/v1/deals/<id>/threads/<tid>/messages/<mid>/receipts` → `rollup: "sent"`.
Have both recipients open the thread's message list → `"received"`. Have both
open the thread (mark read) → `"read"`.

**T5.6 `[SPA]` Channel → side-private conversion** _(2 sessions)_ — as
`seed-buyeragent` open *Agent coordination* (`channel:agent`), convert it to
buy-side. Result: the thread moves to `side_private:buy`, a system message is
appended, the **whole buy side** now sees it, and `seed-selleragent` (the other
agent) **loses** it and gets a *thread converted* notification.

**T5.7 `[SPA]` Activity feed** — the deal page's activity list shows member
joins, stage advances, handshake outcomes — scoped to what you can see.

**T5.8 `[API]` Non-member is shut out** — `GET $API/v1/deals/<seedId>/threads`
with a token for a user not on the deal → `403`.

---

## 6. Documents (Module 7)

**T6.1 `[SPA]` Document room is scoped + matrixed** — as `seed-selleragent` open
the seed deal's documents → you see *Purchase & Sale Agreement* and *Seller
property disclosures* (deal-wide). You do **not** see *Loan commitment letter*
(Financing / buy-private) or *Phase I ESA* (Inspection / buy-private). As
`seed-lender` you see the commitment letter; as `seed-buyer` you see all four.

**T6.2 `[SPA]` Upload** — as `seed-buyeragent`, upload a small file, category
*Title*, scope *deal-wide*. It appears for everyone. As `seed-seller`, upload
scope *side_private:buy* → refused (not your side).

**T6.3 `[SPA]` Versioning** — open the PSA → it has v1 and v2. Add a v3 (any
file). "current" advances to 3; all versions remain downloadable.

**T6.4 `[SPA]` Download / view = presigned + logged** — download the PSA → opens
an S3 URL with `X-Amz-…` query params (short-lived). `[API]` `GET
$API/v1/deals/<id>/audit` a few seconds later → a `document.accessed` row with
`mode: downloaded`.

**T6.5 `[SPA]` Promote side-private → deal-wide** — upload a *Disclosure* as
`seed-buyer` scope *side_private:buy*. As `seed-buyeragent` (buy side, not
`OTHER`) promote it → scope becomes `deal_wide`; `seed-selleragent` can now see
it. Try promoting again → `409` (already deal-wide). As `seed-inspector`
(`OTHER`) the promote control is absent / `403`.

**T6.6 `[SPA]` Category matrix negatives** — `[API]` as `seed-seller`, `GET
$API/v1/deals/<id>/documents/<loanCommitmentDocId>` → `403`. As `seed-title`,
list documents → you do **not** see the Inspection or Financing docs. As
`seed-lender`, you **do** see Financing but **not** Inspection.

**T6.7 `[SPA]` Delete = handshake saga** — as `seed-selleragent` (admin) or
`seed-buyer` (buy lead), "Request delete" on the deal-wide Disclosure → `202`,
the doc is still there. Within seconds a `delete_document` handshake appears
(`GET $API/v1/deals/<id>/handshakes`). The counterparty lead approves → the doc
disappears (`GET …/documents/<id>` → `404`) and the handshake goes `completed`.
As `seed-buyerattorney` (neither admin nor lead) → "Request delete" `403`.

**T6.8 `[SPA]` Document requests** — the seed deal has an open request for
`TITLE_AGENT`. As `seed-title`, fulfil it by linking a doc you upload → status
`fulfilled`, requester (`seed-selleragent`) gets a *fulfilled* notification.
`[API]` create another request targeting `seed-lender` by **name**; decline it
as `seed-lender` with a reason → status `declined`. Cancel a third as its
creator → `cancelled`.

---

## 7. Audit (Module 8)

**T7.1 `[API]` Scoped read** — `GET $API/v1/deals/<seedId>/audit` as
`seed-selleragent` → rows for `deal_wide` + `side_private:sell` + `channel:agent`
only; **no** `side_private:buy` rows. As `seed-buyer` → `side_private:buy` rows
present, no `side_private:sell`.

**T7.2 `[API]` Filters** —
`…/audit?action=stage.advanced` → only stage-advance rows.
`…/audit?actor=<a userId sub>` → only that actor's rows.
`…/audit?from=2099-01-01` → empty.
`…/audit?targetType=document` → only document rows.

**T7.3 `[API]` Pagination** — `…/audit?limit=5` → 5 rows + a `nextCursor`; pass
`…/audit?limit=5&cursor=<that>` → the next page, no overlap.

**T7.4 `[API]` Export CSV** — `curl -s -D - "$API/v1/deals/<id>/audit/export?format=csv"
-H "authorization: Bearer $TOK"` → `content-type: text/csv`,
`content-disposition: attachment; filename="audit-…csv"`, header row
`occurredAt,actorId,detailType,…`. As `seed-selleragent` the CSV contains **no**
`side_private:buy` rows.

**T7.5 `[API]` Export JSON** — `…/audit/export?format=json` → `application/json`
attachment, `{ count, events: [...] }`, `count === events.length`, every row in
your visible scopes. `…/audit/export?format=xml` → `400`.

**T7.6 Edited/deleted messages are preserved** — after T5.4, `…/audit` shows
`message.edited` / `message.deleted` rows; the message **body** is never in the
audit payload by design (it records that it happened, not the content) — the
retained original lives in the Chat table's message `history[]`.

**T7.7 Append-only (design note, not API-testable)** — the audit consumer's IAM
role has `dynamodb:PutItem` and nothing else on the `audit` table; there is no
update/delete code path. Nothing to click — noted so it isn't mistaken for a
gap.

---

## 8. Notifications (Module 9)

**T8.1 `[SPA]` Bell + unread count** — sign in as `seed-buyer`. The bell shows an
unread count (the seed left a pending handshake + activity). Open it → list of
notifications, unread ones bold.

**T8.2 `[SPA]` Mark read** — click one notification → it navigates to the deal
and that item is no longer bold; the count drops by 1. "Mark all read" → count
→ 0. `[API]` `POST $API/v1/notifications/read {"all":true}` also works.

**T8.3 Each type fires** — exercise and confirm a bell entry appears for:
| Action | Recipient | Type |
|---|---|---|
| @mention (T5.3) | mentioned user | `mention` |
| initiate a handshake (T4.2) | each approver | `handshake_pending` |
| approve it | the initiator | `handshake_approved` |
| reject it (T4.3) | the initiator | `handshake_rejected` |
| doc-request to a role (T6.8) | every holder of that role | `docrequest_assigned` |
| fulfil / decline it | the requester | `docrequest_fulfilled` / `_declined` |
| advance a stage (T4.2) | **every** member, incl. the approver | `stage_advanced` |
| close / cancel (T4.9) | every member | `deal_closed` / `deal_cancelled` |
| convert a channel (T5.6) | the dropped agent/attorney | `thread_converted` |

**T8.4 Plain messages don't notify** — posting a message with no @mention
produces **no** notification for anyone (only unread counts, which are a Chat
concern).

**T8.5 Actor exclusion** — the person who *initiates* a handshake does **not**
get `handshake_pending`; the person who *approves* it does **not** get
`handshake_approved` (that goes to the initiator). But everyone, including the
approver, **does** get `stage_advanced` (it's a deal-wide broadcast).

**T8.6 Email is off** — no email arrives for any of the above. Invitations
return the `acceptUrl` link instead. (This is the flag-gated design state.)

---

## 9. Seed & verify scripts (Module 10)

**T9.1 `[CLI]` Seed is idempotent** — run `node scripts/seed.mjs` twice. Second
run deletes and recreates the cohort, ends with the same summary and a fresh
`dealId`. `scripts/seed-output.json` is rewritten and git-ignored.

**T9.2 `[SPA]` Seeded deal is browsable** — open the `dealUrl` from
`seed-output.json`, sign in as any seeded login → the deal is populated (stages,
5 threads, 4 docs, an open doc-request, a pending handshake).

**T9.3 `[CLI]` Verify passes** — `node scripts/verify.mjs` → `🎉 ALL CHECKS
PASS: 33 passed, 0 failed`, and its `verify-*` cohort is deleted afterward
(`aws cognito-idp list-users …` shows only `seed-*` users).

**T9.4 `[CLI]` Verify is self-contained** — run it twice back to back; no
residue, no dependence on seed state. Each run mints a uniquely-suffixed cohort
and its own deals; `inviteAndAccept` now blocks on each member's projection
landing in chat + documents + audit (`waitMemberSync`), so a backlogged bus
slows the run but doesn't crash it on a `403 "may not be synced yet"`.

---

## 10. Cross-cutting

**T10.1 No god view (the headline)** — pick any `side_private:buy` thread,
document, or audit row. Confirm that **no** sell-side login — including
`seed-selleragent`, the admin — can see it in the list, by direct `GET`, or in
the CSV/JSON audit export. Mirror it for a `side_private:sell` item vs a
buy-side login, and a `channel:attorney` item vs a non-attorney.

**T10.2 Eventual consistency window** — invite + accept a new member; immediately
`GET` a scoped endpoint as them → `403` for a few seconds, then `200`. Not a
bug; note the observed delay.

**T10.3 Correlation id** — send a request with `-H 'x-correlation-id: test-123'`;
the response carries `x-correlation-id: test-123`, and CloudWatch logs for that
Lambda show the same id on every line for that request (and across the
downstream consumer, if you follow an event).

**T10.4 Per-service isolation (design note)** — each service's Lambda role can
reach only its own table + its own queue + the bus. Not clickable; verify by
reading the stack IAM policies if desired.

**T10.5 Cost** — after a day of testing, check the AWS Billing console → spend
should be within a few dollars (all serverless, pay-per-use).

---

## Results log

| Test | Result | Notes / issue |
|---|---|---|
| T1.1 | | |
| T1.2 | | |
| T1.3 | | |
| T1.4 | | |
| T1.5 | | |
| T2.1 | | |
| T2.2 | | |
| T2.3 | | |
| T2.4 | | |
| T2.5 | | |
| T2.6 | | |
| T3.1 | | |
| T3.2 | | |
| T3.3 | | |
| T3.4 | | |
| T3.5 | | |
| T3.6 | | |
| T3.7 | | |
| T3.8 | | |
| T3.9 | | |
| T3.10 | | |
| T3.11 | | |
| T4.1 | | |
| T4.2 | | |
| T4.3 | | |
| T4.4 | | |
| T4.5 | | |
| T4.6 | | |
| T4.7 | | |
| T4.8 | | |
| T4.9 | | |
| T4.10 | | |
| T4.11 | | |
| T5.1 | | |
| T5.2 | | |
| T5.3 | | |
| T5.4 | | |
| T5.5 | | |
| T5.6 | | |
| T5.7 | | |
| T5.8 | | |
| T6.1 | | |
| T6.2 | | |
| T6.3 | | |
| T6.4 | | |
| T6.5 | | |
| T6.6 | | |
| T6.7 | | |
| T6.8 | | |
| T7.1 | | |
| T7.2 | | |
| T7.3 | | |
| T7.4 | | |
| T7.5 | | |
| T7.6 | | |
| T8.1 | | |
| T8.2 | | |
| T8.3 | | |
| T8.4 | | |
| T8.5 | | |
| T8.6 | | |
| T9.1 | | |
| T9.2 | | |
| T9.3 | | |
| T9.4 | | |
| T10.1 | | |
| T10.2 | | |
| T10.3 | | |
| T10.4 | | |
| T10.5 | | |
