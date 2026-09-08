import { describe, expect, it } from 'vitest';
import type { Role, Side } from './roles.js';
import {
  approverSideFor,
  can,
  canApproveHandshake,
  capabilitiesFor,
  handshakeApproverSide,
  initiateActionFor,
  inviteActionFor,
  inviteLimits,
  isHandshakeApprover,
  type AuthzContext,
} from './permissions.js';

const ctx = (over: Partial<AuthzContext> = {}): AuthzContext => ({
  role: 'SELLER_AGENT',
  side: 'sell',
  isAdmin: false,
  isFirm: false,
  currentStage: 1,
  status: 'active',
  ...over,
});

describe('can — deal + membership', () => {
  it('lets any authenticated user create a deal, even with no membership', () => {
    expect(can('createDeal', ctx({ status: 'invited' }))).toBe(true);
  });

  it('blocks everything else for a non-active membership', () => {
    expect(can('editDealFields', ctx({ status: 'removed', isAdmin: true }))).toBe(false);
  });

  it('either sell-side lead (SELLER or SELLER_AGENT) edits deal fields; the buy side cannot', () => {
    expect(can('editDealFields', ctx({ role: 'SELLER_AGENT', isAdmin: true }))).toBe(true);
    expect(can('editDealFields', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('editDealFields', ctx({ role: 'SELLER_ATTORNEY', isAdmin: false }))).toBe(false);
    expect(can('editDealFields', ctx({ role: 'BUYER', side: 'buy' }))).toBe(false);
  });

  it('a sell-side or buy-side lead may initiate a price-change handshake', () => {
    expect(can('editPurchasePrice', ctx({ role: 'SELLER_AGENT', isAdmin: true }))).toBe(true);
    expect(can('editPurchasePrice', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('editPurchasePrice', ctx({ role: 'BUYER_AGENT', side: 'buy' }))).toBe(true);
    expect(can('editPurchasePrice', ctx({ role: 'BUYER_ATTORNEY', side: 'buy' }))).toBe(false);
  });

  it('date/status edits are sell-lead-only pre-firm, either-lead post-firm', () => {
    expect(can('editDates', ctx({ role: 'BUYER', side: 'buy', isFirm: false }))).toBe(false);
    expect(can('editDates', ctx({ role: 'BUYER', side: 'buy', isFirm: true }))).toBe(true);
    expect(can('changeDealStatus', ctx({ role: 'SELLER', isAdmin: false, isFirm: false }))).toBe(true);
    expect(can('changeDealStatus', ctx({ role: 'SELLER', isAdmin: false, isFirm: true }))).toBe(true);
  });

  it('routes invitations by who manages the target side', () => {
    expect(can('inviteSellSide', ctx({ role: 'SELLER_AGENT', isAdmin: true }))).toBe(true);
    expect(can('inviteSellSide', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('inviteSellSide', ctx({ role: 'SELLER_ATTORNEY', isAdmin: false }))).toBe(false);
    // a sell-side lead bootstraps the buy side; the buy side then self-manages
    expect(can('inviteBuySide', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('inviteBuySide', ctx({ role: 'BUYER', side: 'buy' }))).toBe(true);
    expect(can('inviteBuySide', ctx({ role: 'LENDER', side: 'buy' }))).toBe(false);
    expect(can('inviteTitle', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('inviteOther', ctx({ role: 'SELLER', isAdmin: false, targetSide: 'sell' }))).toBe(true);
    expect(can('inviteOther', ctx({ role: 'SELLER', isAdmin: false, targetSide: 'buy' }))).toBe(false);
    expect(can('inviteOther', ctx({ role: 'BUYER', side: 'buy', targetSide: 'buy' }))).toBe(true);
  });

  it('roster changes require managing the target member’s side', () => {
    expect(can('removeMember', ctx({ role: 'SELLER', isAdmin: false, targetSide: 'sell' }))).toBe(true);
    expect(can('removeMember', ctx({ role: 'SELLER', isAdmin: false, targetSide: 'buy' }))).toBe(false);
    expect(can('removeMember', ctx({ role: 'SELLER_ATTORNEY', targetSide: 'sell' }))).toBe(false);
    expect(can('changeMemberRole', ctx({ role: 'BUYER', side: 'buy', targetSide: 'buy' }))).toBe(
      true,
    );
  });
});

describe('can — stubbed groups still give sensible answers', () => {
  it('advanceMilestone / deleteDocument are lead-initiable on either side', () => {
    expect(can('advanceMilestone', ctx({ role: 'BUYER', side: 'buy' }))).toBe(true);
    expect(can('advanceMilestone', ctx({ role: 'SELLER', side: 'sell' }))).toBe(true);
    expect(can('deleteDocument', ctx({ role: 'SELLER', side: 'sell' }))).toBe(true);
    expect(can('deleteDocument', ctx({ role: 'SELLER_ATTORNEY', side: 'sell' }))).toBe(false);
  });

  it('OTHER cannot post deal-wide or create deal-wide threads/docs', () => {
    const other = ctx({ role: 'OTHER', side: 'buy' });
    expect(can('createThreadDealWide', other)).toBe(false);
    expect(can('uploadDealWideDoc', other)).toBe(false);
    expect(can('createThreadSidePrivate', other)).toBe(true);
  });

  it('sendForSignature is any active non-OTHER member', () => {
    expect(can('sendForSignature', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('sendForSignature', ctx({ role: 'BUYER_ATTORNEY', side: 'buy' }))).toBe(true);
    expect(can('sendForSignature', ctx({ role: 'OTHER', side: 'buy' }))).toBe(false);
    expect(can('sendForSignature', ctx({ status: 'removed' }))).toBe(false);
  });
});

describe('inviteLimits', () => {
  const bs = (roles: Role[]) => roles.map((role) => ({ role, status: 'active' as const }));

  it('caps buy-side agents at 2', () => {
    expect(inviteLimits(bs(['BUYER_AGENT', 'BUYER_AGENT']), 'BUYER_AGENT').ok).toBe(false);
    expect(inviteLimits(bs(['BUYER_AGENT']), 'BUYER_AGENT').ok).toBe(true);
  });

  it('caps buy-side attorneys at 2', () => {
    expect(inviteLimits(bs(['BUYER_ATTORNEY', 'BUYER_ATTORNEY']), 'BUYER_ATTORNEY').ok).toBe(false);
  });

  it('caps the buy side at 7 total', () => {
    const seven = bs(['BUYER', 'BUYER_AGENT', 'BUYER_ATTORNEY', 'LENDER', 'OTHER', 'OTHER', 'OTHER']);
    expect(inviteLimits(seven, 'OTHER').ok).toBe(false);
  });

  it('ignores removed members', () => {
    const withRemoved = [
      { role: 'BUYER_AGENT' as Role, status: 'removed' as const },
      { role: 'BUYER_AGENT' as Role, status: 'active' as const },
    ];
    expect(inviteLimits(withRemoved, 'BUYER_AGENT').ok).toBe(true);
  });
});

describe('handshake approval', () => {
  it('routes approval to the opposite side’s lead', () => {
    expect(handshakeApproverSide('sell')).toBe('buy');
    expect(handshakeApproverSide('buy')).toBe('sell');
    // sell initiated -> a buy-side lead approves
    expect(isHandshakeApprover(ctx({ role: 'BUYER', side: 'buy' }), 'sell')).toBe(true);
    expect(isHandshakeApprover(ctx({ role: 'BUYER_ATTORNEY', side: 'buy' }), 'sell')).toBe(false);
    // buy initiated -> a sell-side lead approves (SELLER or SELLER_AGENT)
    expect(isHandshakeApprover(ctx({ role: 'SELLER_AGENT', isAdmin: true }), 'buy')).toBe(true);
    expect(isHandshakeApprover(ctx({ role: 'SELLER', isAdmin: false }), 'buy')).toBe(true);
    expect(isHandshakeApprover(ctx({ role: 'SELLER_ATTORNEY', isAdmin: false }), 'buy')).toBe(false);
  });

  it('routes a side-private document archive to the initiating side’s own lead', () => {
    // deal-wide delete + every other action -> counterparty
    expect(approverSideFor('delete_document', 'buy', 'deal_wide')).toBe('sell');
    expect(approverSideFor('advance_stage', 'buy', 'side_private:buy')).toBe('sell');
    // side-private delete -> same side
    expect(approverSideFor('delete_document', 'buy', 'side_private:buy')).toBe('buy');
    expect(approverSideFor('delete_document', 'sell', 'side_private:sell')).toBe('sell');
    // deal-wide delete of a category the counterparty can't see -> same side
    expect(approverSideFor('delete_document', 'buy', 'deal_wide', 'Financing')).toBe('buy');
    expect(approverSideFor('delete_document', 'buy', 'deal_wide', 'Appraisal')).toBe('buy');
    // ...but a category the counterparty *can* see -> counterparty
    expect(approverSideFor('delete_document', 'buy', 'deal_wide', 'Title')).toBe('sell');

    // a buy-side lead approves a buy-side-private delete; the seller cannot
    expect(
      canApproveHandshake(ctx({ role: 'BUYER_AGENT', side: 'buy' }), 'delete_document', 'buy', 'side_private:buy'),
    ).toBe(true);
    expect(
      canApproveHandshake(ctx({ role: 'SELLER_AGENT', isAdmin: true }), 'delete_document', 'buy', 'side_private:buy'),
    ).toBe(false);
    // deal-wide delete keeps the counterparty as approver
    expect(
      canApproveHandshake(ctx({ role: 'SELLER', isAdmin: false }), 'delete_document', 'buy', 'deal_wide'),
    ).toBe(true);
  });

  it('maps each handshake action to its initiating capability', () => {
    expect(initiateActionFor('advance_stage')).toBe('advanceMilestone');
    expect(initiateActionFor('close_deal')).toBe('changeDealStatus');
    expect(initiateActionFor('edit_price')).toBe('editPurchasePrice');
    expect(initiateActionFor('delete_document')).toBe('deleteDocument');
    expect(initiateActionFor('confirm_payment')).toBe('recordPayment');
    expect(initiateActionFor('void_payment')).toBe('voidPayment');
  });
});

describe('can — payments (Module 11)', () => {
  it('either side’s lead may record / void; non-leads may not', () => {
    expect(can('recordPayment', ctx({ role: 'SELLER_AGENT', isAdmin: true }))).toBe(true);
    expect(can('recordPayment', ctx({ role: 'SELLER', isAdmin: false }))).toBe(true);
    expect(can('recordPayment', ctx({ role: 'BUYER', side: 'buy' }))).toBe(true);
    expect(can('voidPayment', ctx({ role: 'BUYER_AGENT', side: 'buy' }))).toBe(true);
    expect(can('recordPayment', ctx({ role: 'SELLER_ATTORNEY', isAdmin: false }))).toBe(false);
    expect(can('recordPayment', ctx({ role: 'LENDER', side: 'buy' }))).toBe(false);
    expect(can('voidPayment', ctx({ role: 'BUYER_ATTORNEY', side: 'buy' }))).toBe(false);
    expect(can('recordPayment', ctx({ role: 'SELLER', status: 'removed' }))).toBe(false);
  });

  it('exposes recordPayment in the SPA capability map', () => {
    expect(capabilitiesFor(ctx({ role: 'SELLER', isAdmin: false })).recordPayment).toBe(true);
    expect(capabilitiesFor(ctx({ role: 'SELLER_ATTORNEY', isAdmin: false })).recordPayment).toBe(false);
  });
});

describe('inviteActionFor', () => {
  it('maps role to the authorizing action', () => {
    const cases: [Role, string][] = [
      ['SELLER', 'inviteSellSide'],
      ['BUYER_AGENT', 'inviteBuySide'],
      ['LENDER', 'inviteBuySide'],
      ['TITLE_AGENT', 'inviteTitle'],
      ['OTHER', 'inviteOther'],
    ];
    for (const [role, action] of cases) expect(inviteActionFor(role)).toBe(action);
  });
});

describe('capabilitiesFor', () => {
  it('produces a boolean map an SPA can use to hide controls', () => {
    // a plain SELLER has the same authority as the SELLER_AGENT
    const seller = capabilitiesFor(ctx({ role: 'SELLER', isAdmin: false }));
    expect(seller.editDealFields).toBe(true);
    expect(seller.inviteBuySide).toBe(true); // a sell-side lead bootstraps the buy side
    expect(seller.manageRoster).toBe(true);
    const attorney = capabilitiesFor(ctx({ role: 'SELLER_ATTORNEY', isAdmin: false }));
    expect(attorney.editDealFields).toBe(false);
    expect(attorney.inviteBuySide).toBe(false);
    expect(attorney.manageRoster).toBe(false);
  });

  it('is all-false-ish for a removed member', () => {
    const caps = capabilitiesFor(ctx({ status: 'removed', isAdmin: true }));
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });

  it('never asserts on Side beyond the enum', () => {
    const s: Side = 'neutral';
    expect(capabilitiesFor(ctx({ side: s })).viewAudit).toBe(true);
  });
});
