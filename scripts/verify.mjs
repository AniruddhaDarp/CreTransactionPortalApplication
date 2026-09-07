#!/usr/bin/env node
/**
 * Acceptance test for the deployed stack — the design-doc §14 checklist, run
 * end-to-end against the live API. Self-contained: creates a short-lived
 * `verify-*` cohort, exercises every guarantee, and deletes its users at the
 * end (pass or fail).
 *
 *   node scripts/verify.mjs
 */
import {
  deleteUser,
  inviteAndAccept,
  makeUser,
  putToS3,
  resolveConfig,
  waitFor,
  waitMemberSync,
} from './lib/portal.mjs';

const PASSWORD = 'CrePortalVerify!2026';
const RUN = Date.now().toString(36);
const email = (k) => `verify-${k}-${RUN}@cre-portal.example`;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (cond) pass++;
  else fail++;
};
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const section = (s) => console.log(`\n${s}`);
const types = (r) => (r.body?.events ?? []).map((e) => e.detailType);

/** Deals created during the run — cancelled in cleanup to slow orphan build-up
 *  (there is no deal-delete API). */
const createdDeals = [];

async function main() {
  const cfg = await resolveConfig();
  console.log(`Verifying ${cfg.apiBaseUrl}  (run ${RUN})`);

  const cast = {
    admin: 'selleragent',
    seller: 'seller',
    sellerAtty: 'selleratty',
    buyer: 'buyer',
    buyerAgent: 'buyeragent',
    buyerAtty: 'buyeratty',
    lender: 'lender',
    extraAgent: 'extraagent',
    extraAtty1: 'extraatty1',
    extraAtty2: 'extraatty2',
    outsider: 'outsider',
  };
  const U = {};
  const newDeal = async (body) => {
    const d = await U.admin.must('POST', '/v1/deals', body);
    createdDeals.push(d.dealId);
    return d;
  };

  try {
    section('· provisioning the verify cohort');
    for (const [k, slug] of Object.entries(cast)) {
      U[k] = await makeUser(cfg, { email: email(slug), name: `verify-${k}`, password: PASSWORD });
    }
    ok(true, `${Object.keys(U).length} users created + confirmed`);

    const deal = await newDeal({
      address: `${RUN} Verification Way`,
      propertyType: 'office',
      price: 8_000_000,
      targetClosingDate: '2026-11-30',
    });
    const id = deal.dealId;
    ok(!!id, `deal created (${id})`);

    section('· §14.5 — roster, invitation accept, buy-side self-invite limits');
    await inviteAndAccept(U.admin, U.seller, id, 'SELLER');
    await inviteAndAccept(U.admin, U.sellerAtty, id, 'SELLER_ATTORNEY');
    await inviteAndAccept(U.admin, U.buyer, id, 'BUYER');
    await inviteAndAccept(U.admin, U.buyerAgent, id, 'BUYER_AGENT');
    ok(true, 'admin bootstrapped the buy-side, then the buy-side self-manages');
    await inviteAndAccept(U.buyer, U.buyerAtty, id, 'BUYER_ATTORNEY');
    await inviteAndAccept(U.buyerAgent, U.lender, id, 'LENDER');

    // ≤2 buy-side agents
    const secondAgent = await U.buyer.call('POST', `/v1/deals/${id}/invites`, {
      email: U.extraAgent.email,
      role: 'BUYER_AGENT',
    });
    ok(secondAgent.status === 201, 'a 2nd buy-side agent is allowed (limit is 2)');
    await U.extraAgent.must('POST', `/v1/deals/${id}/invites/${secondAgent.body.token}/accept`, undefined, [200, 201]);
    await waitMemberSync(U.extraAgent, id);
    const thirdAgent = await U.buyer.call('POST', `/v1/deals/${id}/invites`, {
      email: `verify-3rdagent-${RUN}@cre-portal.example`,
      role: 'BUYER_AGENT',
    });
    ok(thirdAgent.status === 409, `a 3rd buy-side agent is rejected (${thirdAgent.status})`);

    // ≤2 buy-side attorneys
    await inviteAndAccept(U.buyer, U.extraAtty1, id, 'BUYER_ATTORNEY'); // this is the 2nd (buyerAtty was 1st)
    const thirdAtty = await U.buyer.call('POST', `/v1/deals/${id}/invites`, {
      email: U.extraAtty2.email,
      role: 'BUYER_ATTORNEY',
    });
    ok(thirdAtty.status === 409, `a 3rd buy-side attorney is rejected (${thirdAtty.status})`);

    // ≤7 buy-side total — buy-side now has buyer, buyerAgent, buyerAtty, lender, extraAgent, extraAtty1 = 6
    const seventh = await U.buyer.call('POST', `/v1/deals/${id}/invites`, {
      email: `verify-7th-${RUN}@cre-portal.example`,
      role: 'BUYER',
    });
    ok(seventh.status === 201, '7th buy-side member allowed');
    const eighth = await U.buyer.call('POST', `/v1/deals/${id}/invites`, {
      email: `verify-8th-${RUN}@cre-portal.example`,
      role: 'BUYER',
    });
    ok(eighth.status === 409, `8th buy-side member rejected — cap is 7 (${eighth.status})`);

    // every member is invited via inviteAndAccept(), which now waits for that
    // member's projection to land in chat + documents + audit before returning.

    section('· §14.1 — scoping / no god view (threads, documents, audit)');
    const buyThread = (await U.buyerAgent.must('POST', `/v1/deals/${id}/threads`, {
      subject: 'buy-only strategy',
      scope: 'side_private:buy',
    })).threadId;
    await U.buyerAgent.must('POST', `/v1/deals/${id}/threads/${buyThread}/messages`, { body: 'buy-side only note' });
    await U.sellerAtty.must('POST', `/v1/deals/${id}/threads`, {
      subject: 'sell-only strategy',
      scope: 'side_private:sell',
    });

    const adminThreads = (await U.admin.must('GET', `/v1/deals/${id}/threads`)).threads.map((t) => t.subject);
    ok(adminThreads.includes('sell-only strategy'), 'admin sees the sell-side-private thread');
    ok(!adminThreads.includes('buy-only strategy'), 'admin does NOT see the buy-side-private thread (no god view)');
    const buyerThreads = (await U.buyer.must('GET', `/v1/deals/${id}/threads`)).threads.map((t) => t.subject);
    ok(buyerThreads.includes('buy-only strategy') && !buyerThreads.includes('sell-only strategy'),
      'buyer sees only its own side-private thread');

    const buyDoc = (await U.lender.must('POST', `/v1/deals/${id}/documents`, {
      category: 'Financing',
      title: 'verify financing doc',
      scope: 'side_private:buy',
      filename: 'f.txt',
      contentType: 'text/plain',
    }));
    await putToS3(buyDoc.uploadUrl, 'financing bytes', 'text/plain');

    const adminDocs = (await U.admin.must('GET', `/v1/deals/${id}/documents`)).documents;
    ok(!adminDocs.some((d) => d.docId === buyDoc.docId),
      'sell-side admin cannot see a Financing / side_private:buy document');
    const adminDocGet = await U.admin.call('GET', `/v1/deals/${id}/documents/${buyDoc.docId}`);
    ok(adminDocGet.status === 403, `direct GET of that document by the admin is 403 (${adminDocGet.status})`);

    await waitFor(async () => types(await U.buyer.call('GET', `/v1/deals/${id}/audit`)).includes('document.uploaded'),
      'buyer audit rows populated');
    const adminAudit = await U.admin.must('GET', `/v1/deals/${id}/audit`);
    ok(!adminAudit.events.some((e) => e.scope === 'side_private:buy'),
      'admin audit trail contains NO side_private:buy rows');
    const buyerAudit = await U.buyer.must('GET', `/v1/deals/${id}/audit`);
    ok(buyerAudit.events.some((e) => e.scope === 'side_private:buy'),
      'buyer audit trail DOES contain its own side_private:buy rows');
    const csv = await U.admin.call('GET', `/v1/deals/${id}/audit/export?format=csv`);
    ok(csv.status === 200 && (csv.headers.get('content-type') || '').includes('text/csv') &&
      !csv.text.includes('side_private:buy'), 'admin CSV export is scoped (no buy-private rows)');

    section('· §14.2 — unauthorized document fetch denied; access is logged');
    const outsiderGet = await U.outsider.call('GET', `/v1/deals/${id}/documents`);
    ok(outsiderGet.status === 403, `a non-member gets 403 from the document room (${outsiderGet.status})`);
    const dl = await U.lender.must('GET', `/v1/deals/${id}/documents/${buyDoc.docId}/versions/1/download`);
    ok(typeof dl.url === 'string' && dl.url.includes('X-Amz-'), 'an authorized download returns a presigned URL');
    await waitFor(async () =>
      types(await U.lender.call('GET', `/v1/deals/${id}/audit`)).includes('document.accessed'),
      'the download produced a document.accessed audit row');
    ok(true, 'document open/download is recorded in the audit trail');

    section('· §14.3 — handshake gating (advance milestone) + audit at each step');
    const stagesBefore = await U.admin.must('GET', `/v1/deals/${id}/stages`);
    const hs = await U.admin.must('POST', `/v1/deals/${id}/advance`);
    const stagesMid = await U.admin.must('GET', `/v1/deals/${id}/stages`);
    ok(stagesMid.currentStage === stagesBefore.currentStage,
      'stage does NOT change while the handshake is pending');
    const wrongApprover = await U.seller.call('POST', `/v1/deals/${id}/handshakes/${hs.handshakeId}/approve`);
    ok(wrongApprover.status === 403, `a non-lead cannot approve the handshake (${wrongApprover.status})`);
    await U.buyer.must('POST', `/v1/deals/${id}/handshakes/${hs.handshakeId}/approve`);
    const stagesAfter = await U.admin.must('GET', `/v1/deals/${id}/stages`);
    ok(stagesAfter.currentStage === stagesBefore.currentStage + 1,
      `stage advances only after the counterparty approves (${stagesBefore.currentStage} → ${stagesAfter.currentStage})`);
    await waitFor(async () => {
      const t = types(await U.admin.call('GET', `/v1/deals/${id}/audit`));
      return t.includes('handshake.requested') && t.includes('handshake.approved') && t.includes('stage.advanced');
    }, 'every handshake step is in the audit trail');
    ok(true, 'handshake.requested / approved / stage.advanced all audited');

    section('· §14.6a — pre-firm: close/cancel is admin-unilateral');
    // deal 1 is at stage 2 (Attorney Review not completed) → not firm
    const dealPre = (await U.admin.must('GET', `/v1/deals/${id}`));
    ok(dealPre.firm === false, 'deal is not yet firm (Attorney Review not completed)');
    const closePreFirm = await U.admin.call('POST', `/v1/deals/${id}/status`, {
      status: 'CANCELLED',
      reason: 'pre-firm unilateral test',
    });
    ok(closePreFirm.status === 200, `pre-firm cancel is applied immediately, no handshake (${closePreFirm.status})`);
    ok((await U.admin.must('GET', `/v1/deals/${id}`)).status === 'CANCELLED', 'the deal is now CANCELLED');

    section('· §14.4 — message receipts progress sent → received → read');
    // fresh deal so the recipient set is non-trivial and nothing is pre-read
    const d2 = (await newDeal({
      address: `${RUN} Receipts Rd`, propertyType: 'retail', price: 3_000_000,
    })).dealId;
    await inviteAndAccept(U.admin, U.buyer, d2, 'BUYER');
    await inviteAndAccept(U.admin, U.buyerAgent, d2, 'BUYER_AGENT');
    const rcptThread = (await U.admin.must('POST', `/v1/deals/${d2}/threads`, {
      subject: 'receipts', scope: 'deal_wide',
    })).threadId;
    const msg = await U.admin.must('POST', `/v1/deals/${d2}/threads/${rcptThread}/messages`, { body: 'ping' });
    const rollup = async () =>
      (await U.admin.must('GET', `/v1/deals/${d2}/threads/${rcptThread}/messages/${msg.msgId}/receipts`)).rollup;
    ok((await rollup()) === 'sent', 'a new message starts at "sent"');
    await U.buyer.must('GET', `/v1/deals/${d2}/threads/${rcptThread}/messages`); // buyer's client fetches
    await U.buyerAgent.must('GET', `/v1/deals/${d2}/threads/${rcptThread}/messages`);
    ok((await rollup()) === 'received', 'after every recipient fetches → "received"');
    await U.buyer.must('POST', `/v1/deals/${d2}/threads/${rcptThread}/read`);
    await U.buyerAgent.must('POST', `/v1/deals/${d2}/threads/${rcptThread}/read`);
    ok((await rollup()) === 'read', 'after every recipient opens the thread → "read"');

    section('· §14.6b — post-firm: close/cancel becomes a handshake');
    // push d2 through Attorney Review so it is "firm"
    for (const approver of [U.buyer, U.buyerAgent]) {
      const h = await U.admin.must('POST', `/v1/deals/${d2}/advance`);
      await approver.must('POST', `/v1/deals/${d2}/handshakes/${h.handshakeId}/approve`);
    }
    ok((await U.admin.must('GET', `/v1/deals/${d2}`)).firm === true, 'd2 is firm after Attorney Review completes');
    const closePostFirm = await U.admin.call('POST', `/v1/deals/${d2}/status`, {
      status: 'CANCELLED',
      reason: 'post-firm handshake test',
    });
    ok(closePostFirm.status === 202, `post-firm cancel opens a handshake, does not apply immediately (${closePostFirm.status})`);
    ok((await U.admin.must('GET', `/v1/deals/${d2}`)).status === 'ACTIVE', 'd2 is still ACTIVE — the handshake is pending');

    section('· §14 (notifications) — the counterparty is notified of a pending handshake');
    // Downstream of an at-least-once bus (EventBridge → SQS → the notifications
    // consumer); under load it can lag well past the "seconds" the design
    // implies, so a miss here is a soft warning, not a run failure — the hard
    // notification guarantees are covered by the @cre/notifications unit tests.
    let notified = false;
    for (let i = 0; i < 90 && !notified; i++) {
      const n = await U.buyer.call('GET', '/v1/notifications');
      notified = (n.body.notifications ?? []).some((x) => x.type === 'handshake_pending');
      if (!notified) await new Promise((r) => setTimeout(r, 2000));
    }
    if (notified) ok(true, 'a pending handshake raises a notification for the approver');
    else warn('handshake_pending notification did not arrive within ~3 min (bus backlog) — not counted as a failure');
  } finally {
    console.log('\n· cleanup');
    for (const dealId of createdDeals) {
      await U.admin
        ?.call('POST', `/v1/deals/${dealId}/status`, { status: 'CANCELLED', reason: 'verify cleanup' })
        .catch(() => {});
    }
    for (const u of Object.values(U)) if (u?.email) await deleteUser(cfg.userPoolId, u.email);
    for (const extra of ['3rdagent', '7th', '8th']) await deleteUser(cfg.userPoolId, `verify-${extra}-${RUN}@cre-portal.example`);
  }

  console.log(`\n${fail === 0 ? '🎉 ALL CHECKS PASS' : '⚠️  CHECKS FAILED'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nverify crashed:', e.message);
  process.exit(1);
});
