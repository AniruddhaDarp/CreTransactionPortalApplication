import { describe, expect, it } from 'vitest';
import type { Role, Side } from './roles.js';
import {
  can,
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

  it('only the admin edits deal fields', () => {
    expect(can('editDealFields', ctx({ isAdmin: true }))).toBe(true);
    expect(can('editDealFields', ctx({ role: 'SELLER', isAdmin: false }))).toBe(false);
  });

  it('admin or a buy-side lead may initiate a price-change handshake', () => {
    expect(can('editPurchasePrice', ctx({ isAdmin: true }))).toBe(true);
    expect(can('editPurchasePrice', ctx({ role: 'BUYER_AGENT', side: 'buy' }))).toBe(true);
    expect(can('editPurchasePrice', ctx({ role: 'BUYER_ATTORNEY', side: 'buy' }))).toBe(false);
  });

  it('date/status edits are admin-only pre-firm, handshake-initiable post-firm', () => {
    expect(can('editDates', ctx({ role: 'BUYER', side: 'buy', isFirm: false }))).toBe(false);
    expect(can('editDates', ctx({ role: 'BUYER', side: 'buy', isFirm: true }))).toBe(true);
    expect(can('changeDealStatus', ctx({ isAdmin: true, isFirm: false }))).toBe(true);
  });

  it('routes invitations by who manages the target side', () => {
    expect(can('inviteSellSide', ctx({ isAdmin: true }))).toBe(true);
    // admin bootstraps the buy side; a plain sell-side member cannot
    expect(can('inviteBuySide', ctx({ isAdmin: true }))).toBe(true);
    expect(can('inviteBuySide', ctx({ role: 'SELLER', isAdmin: false }))).toBe(false);
    expect(can('inviteBuySide', ctx({ role: 'BUYER', side: 'buy' }))).toBe(true);
    expect(can('inviteTitle', ctx({ isAdmin: true }))).toBe(true);
    expect(can('inviteOther', ctx({ isAdmin: true, targetSide: 'sell' }))).toBe(true);
    expect(can('inviteOther', ctx({ isAdmin: true, targetSide: 'buy' }))).toBe(false);
    expect(can('inviteOther', ctx({ role: 'BUYER', side: 'buy', targetSide: 'buy' }))).toBe(true);
  });

  it('roster changes require managing the target member’s side', () => {
    expect(can('removeMember', ctx({ isAdmin: true, targetSide: 'sell' }))).toBe(true);
    expect(can('removeMember', ctx({ isAdmin: true, targetSide: 'buy' }))).toBe(false);
    expect(can('changeMemberRole', ctx({ role: 'BUYER', side: 'buy', targetSide: 'buy' }))).toBe(
      true,
    );
  });
});

describe('can — stubbed groups still give sensible answers', () => {
  it('advanceMilestone / deleteDocument are lead-initiable', () => {
    expect(can('advanceMilestone', ctx({ role: 'BUYER', side: 'buy' }))).toBe(true);
    expect(can('deleteDocument', ctx({ role: 'SELLER', side: 'sell' }))).toBe(false);
  });

  it('OTHER cannot post deal-wide or create deal-wide threads/docs', () => {
    const other = ctx({ role: 'OTHER', side: 'buy' });
    expect(can('createThreadDealWide', other)).toBe(false);
    expect(can('uploadDealWideDoc', other)).toBe(false);
    expect(can('createThreadSidePrivate', other)).toBe(true);
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
    // buy initiated -> the admin approves
    expect(isHandshakeApprover(ctx({ isAdmin: true }), 'buy')).toBe(true);
    expect(isHandshakeApprover(ctx({ role: 'SELLER', isAdmin: false }), 'buy')).toBe(false);
  });

  it('maps each handshake action to its initiating capability', () => {
    expect(initiateActionFor('advance_stage')).toBe('advanceMilestone');
    expect(initiateActionFor('close_deal')).toBe('changeDealStatus');
    expect(initiateActionFor('edit_price')).toBe('editPurchasePrice');
    expect(initiateActionFor('delete_document')).toBe('deleteDocument');
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
    const caps = capabilitiesFor(ctx({ isAdmin: true }));
    expect(caps.editDealFields).toBe(true);
    expect(caps.inviteBuySide).toBe(true); // admin bootstraps the buy side
    expect(caps.manageRoster).toBe(true);
    const plainSeller = capabilitiesFor(ctx({ role: 'SELLER', isAdmin: false }));
    expect(plainSeller.editDealFields).toBe(false);
    expect(plainSeller.inviteBuySide).toBe(false);
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
