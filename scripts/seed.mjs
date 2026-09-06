#!/usr/bin/env node
/**
 * Seed one fully-populated sample deal on the DEPLOYED stack, so a reviewer can
 * sign in as any party and immediately see the portal working: full roster,
 * milestones advanced through real handshakes, threads in every scope, versioned
 * documents across the category matrix, an open document request, and a
 * handshake left pending. This organically fills the audit trail and every
 * party's notification bell.
 *
 * Idempotent: the seed users have fixed addresses and are deleted + recreated on
 * each run. (A prior run's deal rows are left as inert orphans — no member can
 * reach a deal whose creator no longer exists, and there is no deal-delete API.)
 *
 *   node scripts/seed.mjs
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteUser,
  inviteAndAccept,
  makeUser,
  putToS3,
  resolveConfig,
  waitFor,
} from './lib/portal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'CrePortalDemo!2026';
const DOMAIN = 'cre-portal.example';

const CAST = [
  { key: 'sellerAgent', role: 'SELLER_AGENT', label: 'Selena Ortiz — listing broker (deal admin)' },
  { key: 'seller', role: 'SELLER', label: 'Sam Reed — seller / owner' },
  { key: 'sellerAttorney', role: 'SELLER_ATTORNEY', label: 'Priya Nair — seller counsel' },
  { key: 'buyer', role: 'BUYER', label: 'Bianca Cho — buyer / principal' },
  { key: 'buyerAgent', role: 'BUYER_AGENT', label: 'Diego Ramos — buy-side broker' },
  { key: 'buyerAttorney', role: 'BUYER_ATTORNEY', label: 'Marcus Lin — buyer counsel' },
  { key: 'lender', role: 'LENDER', label: 'Fatima Khan — acquisition lender' },
  { key: 'inspector', role: 'OTHER', side: 'buy', label: 'Owen Pratt — Phase I / PCA inspector' },
  { key: 'title', role: 'TITLE_AGENT', label: 'Tara Vance — title & escrow' },
];

const emailFor = (key) => `seed-${key.toLowerCase()}@${DOMAIN}`;

async function main() {
  const cfg = await resolveConfig();
  console.log(`Seeding against ${cfg.apiBaseUrl}\n`);

  console.log('· reset — removing any existing seed users');
  for (const c of CAST) await deleteUser(cfg.userPoolId, emailFor(c.key));

  console.log('· creating + confirming the cast');
  const U = {};
  for (const c of CAST) {
    U[c.key] = await makeUser(cfg, { email: emailFor(c.key), name: c.label.split(' — ')[0], password: PASSWORD });
    process.stdout.write(`  ${c.role.padEnd(16)} ${U[c.key].email}\n`);
  }

  console.log('\n· creating the deal (admin = SELLER_AGENT)');
  const deal = await U.sellerAgent.must('POST', '/v1/deals', {
    address: '4200 Larkspur Commons, Austin, TX 78744',
    propertyType: 'industrial',
    label: 'Larkspur Commons — 82,000 SF distribution',
    price: 14_750_000,
    earnestMoney: 500_000,
    targetClosingDate: '2026-12-15',
    description: 'Class B distribution facility, single tenant, 6 years remaining on the lease.',
  });
  const id = deal.dealId;
  console.log(`  dealId = ${id}`);

  console.log('· roster — sell-side + title, then bootstrap buy-side, then buy-side self-manages');
  await inviteAndAccept(U.sellerAgent, U.seller, id, 'SELLER');
  await inviteAndAccept(U.sellerAgent, U.sellerAttorney, id, 'SELLER_ATTORNEY');
  await inviteAndAccept(U.sellerAgent, U.title, id, 'TITLE_AGENT');
  await inviteAndAccept(U.sellerAgent, U.buyer, id, 'BUYER');
  await inviteAndAccept(U.sellerAgent, U.buyerAgent, id, 'BUYER_AGENT');
  await inviteAndAccept(U.buyer, U.buyerAttorney, id, 'BUYER_ATTORNEY');
  await inviteAndAccept(U.buyerAgent, U.lender, id, 'LENDER');
  const inviteOther = await U.buyerAgent.must('POST', `/v1/deals/${id}/invites`, {
    email: U.inspector.email,
    role: 'OTHER',
    side: 'buy',
  });
  await U.inspector.must('POST', `/v1/deals/${id}/invites/${inviteOther.token}/accept`, undefined, [200, 201]);
  console.log('  9 members joined');

  console.log('· waiting for the Chat / Documents / Notifications projections to sync');
  await waitFor(async () => (await U.buyerAgent.call('GET', `/v1/deals/${id}/threads`)).status === 200, 'chat sync');
  await waitFor(async () => (await U.buyerAgent.call('GET', `/v1/deals/${id}/documents`)).status === 200, 'docs sync');
  await waitFor(async () => (await U.title.call('GET', `/v1/deals/${id}/documents`)).status === 200, 'title docs sync');

  console.log('· milestones — advance PSA → Attorney Review → Due Diligence via handshakes');
  const advance = async (approver) => {
    const hs = await U.sellerAgent.must('POST', `/v1/deals/${id}/advance`);
    await approver.must('POST', `/v1/deals/${id}/handshakes/${hs.handshakeId}/approve`);
  };
  await advance(U.buyer); // stage 1 → 2
  await advance(U.buyerAgent); // stage 2 → 3 (flips "firm")
  // tick a couple of checklist items on the completed stages
  for (const n of [1, 2]) {
    const { items } = await U.sellerAgent.must('GET', `/v1/deals/${id}/stages/${n}/checklist`);
    for (const it of items.slice(0, 2)) {
      await U.sellerAgent.must('PATCH', `/v1/deals/${id}/stages/${n}/checklist/${it.itemId}`, { done: true });
    }
  }

  console.log('· threads — one per scope, with a couple of messages');
  const thread = async (author, subject, scope) => {
    const t = await author.must('POST', `/v1/deals/${id}/threads`, { subject, scope });
    return t.threadId;
  };
  const post = (author, tid, body, mentions) =>
    author.must('POST', `/v1/deals/${id}/threads/${tid}/messages`, { body, ...(mentions ? { mentions } : {}) });

  const tDeal = await thread(U.sellerAgent, 'Kickoff & introductions', 'deal_wide');
  await post(U.sellerAgent, tDeal, 'Welcome all — target close is Dec 15. Please introduce yourselves here.');
  await post(U.buyer, tDeal, `Thanks @${U.sellerAgent.name}. Bianca here for the buyer; Diego is our broker.`, [
    U.sellerAgent.sub,
  ]);
  await post(U.title, tDeal, 'Tara from title — I have the prelim order open, commitment out this week.');

  const tBuy = await thread(U.buyerAgent, 'Buy-side financing & diligence prep', 'side_private:buy');
  await post(U.buyerAgent, tBuy, 'Lender needs the rent roll and trailing-12 by Friday. Owen, PCA scope attached in Docs.');
  await post(U.lender, tBuy, 'Confirmed — commitment letter uploaded to the buy-side room.');

  const tSell = await thread(U.sellerAttorney, 'Seller disclosures & PSA redlines', 'side_private:sell');
  await post(U.sellerAttorney, tSell, 'Draft disclosures posted deal-wide. Holding the environmental rep as-is for now.');

  const tAgents = await thread(U.buyerAgent, 'Agent coordination', 'channel:agent');
  await post(U.buyerAgent, tAgents, 'Can we align on the inspection access window next week?');
  await post(U.sellerAgent, tAgents, 'Tenant prefers Tue/Wed AM. I will confirm.');

  const tAttys = await thread(U.buyerAttorney, 'Contract redlines', 'channel:attorney');
  await post(U.buyerAttorney, tAttys, 'Sending redlines on §7 (title objections) and §11 (casualty) today.');

  console.log('· documents — across the category matrix, one with a second version');
  const upload = async (author, { category, title, scope, filename, body }) => {
    const created = await author.must('POST', `/v1/deals/${id}/documents`, {
      category,
      title,
      scope,
      filename,
      contentType: 'text/plain',
    });
    await putToS3(created.uploadUrl, body, 'text/plain');
    return created.docId;
  };
  const psa = await upload(U.sellerAttorney, {
    category: 'Purchase Agreement',
    title: 'Purchase & Sale Agreement (execution copy)',
    scope: 'deal_wide',
    filename: 'psa-v1.txt',
    body: 'PURCHASE & SALE AGREEMENT\nSeller: Reed Holdings LLC\nBuyer: Cho Capital Partners\nPrice: $14,750,000\n(v1)',
  });
  const psaV2 = await U.sellerAttorney.must('POST', `/v1/deals/${id}/documents/${psa}/versions`, {
    filename: 'psa-v2.txt',
    contentType: 'text/plain',
    note: 'Incorporates buyer redlines to §7 and §11.',
  });
  await putToS3(psaV2.uploadUrl, 'PURCHASE & SALE AGREEMENT (v2 — redlined §7, §11)', 'text/plain');

  await upload(U.seller, {
    category: 'Disclosure',
    title: 'Seller property disclosures',
    scope: 'deal_wide',
    filename: 'disclosures.txt',
    body: 'SELLER DISCLOSURES\n- Roof replaced 2021\n- No known environmental claims\n- One open permit (dock leveler)',
  });
  await upload(U.lender, {
    category: 'Financing',
    title: 'Loan commitment letter',
    scope: 'side_private:buy',
    filename: 'commitment.txt',
    body: 'COMMITMENT LETTER\nBorrower: Cho Capital Partners\nLoan: $9,600,000 @ 65% LTV\nConditions: appraisal, clean Phase I',
  });
  await upload(U.inspector, {
    category: 'Inspection',
    title: 'Phase I ESA — draft findings',
    scope: 'side_private:buy',
    filename: 'phase-i.txt',
    body: 'PHASE I ESA (DRAFT)\nNo RECs identified. One HREC (former dry cleaner, 400 ft, upgradient). Recommend records review.',
  });

  console.log('· an open document request + a pending handshake (so the badges are live)');
  await U.sellerAgent.must('POST', `/v1/deals/${id}/doc-requests`, {
    category: 'Title',
    scope: 'deal_wide',
    targetRole: 'TITLE_AGENT',
    note: 'Please post the title commitment + the ALTA survey when ready.',
  });
  await U.buyerAgent.must('POST', `/v1/deals/${id}/terms`, { price: 14_500_000 }); // opens an edit_price handshake, left pending

  const logins = CAST.map((c) => ({ role: c.role, email: U[c.key].email, who: c.label }));
  const out = {
    generatedAt: new Date().toISOString(),
    spaUrl: cfg.spaUrl,
    dealUrl: `${cfg.spaUrl}/deals/${id}`,
    hostedUiUrl: cfg.hostedUiUrl,
    password: PASSWORD,
    dealId: id,
    logins,
  };
  await writeFile(join(HERE, 'seed-output.json'), JSON.stringify(out, null, 2) + '\n');

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`Deal:  ${out.dealUrl}`);
  console.log(`SPA:   ${cfg.spaUrl}   (sign in via the hosted UI)`);
  console.log(`Password for every seeded user:  ${PASSWORD}\n`);
  for (const l of logins) console.log(`  ${l.role.padEnd(16)} ${l.email}`);
  console.log('\nWrote scripts/seed-output.json');
  console.log('────────────────────────────────────────────────────────');
}

main().catch((e) => {
  console.error('\nseed failed:', e.message);
  process.exit(1);
});
