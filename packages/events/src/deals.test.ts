import { describe, expect, it } from 'vitest';
import {
  dealEventSchemas,
  memberInvitedSchema,
  memberJoinedSchema,
} from './deals.js';

describe('deal event schemas', () => {
  it('accepts a well-formed member.invited detail', () => {
    const ok = memberInvitedSchema.parse({
      dealId: 'd1',
      email: 'a@b.com',
      role: 'BUYER_AGENT',
      side: 'buy',
      invitedBy: 'u1',
      token: 'tok-1',
    });
    expect(ok.role).toBe('BUYER_AGENT');
  });

  it('rejects an unknown role', () => {
    expect(() =>
      memberJoinedSchema.parse({ dealId: 'd1', userId: 'u1', role: 'CZAR', side: 'buy' }),
    ).toThrow();
  });

  it('exposes every event type in the registry', () => {
    expect(Object.keys(dealEventSchemas).sort()).toEqual(
      [
        'deal.created',
        'deal.status_changed',
        'deal.updated',
        'member.invited',
        'member.invite_declined',
        'member.joined',
        'member.removed',
        'member.role_changed',
        'stage.advanced',
        'stage.updated',
        'handshake.requested',
        'handshake.approved',
        'handshake.rejected',
        'checklist.item_added',
        'checklist.item_toggled',
        'checklist.item_removed',
        'payment.recorded',
        'payment.confirmed',
        'payment.voided',
      ].sort(),
    );
  });

  it('every registry entry parses its own minimal fixture', () => {
    const fixtures: Record<string, unknown> = {
      'deal.created': { dealId: 'd', createdBy: 'u', address: '1 Main', propertyType: 'office' },
      'deal.updated': { dealId: 'd', changed: { price: { from: 1, to: 2 } } },
      'deal.status_changed': { dealId: 'd', status: 'CLOSED' },
      'member.invited': {
        dealId: 'd',
        email: 'a@b.com',
        role: 'BUYER',
        side: 'buy',
        invitedBy: 'u',
        token: 't',
      },
      'member.joined': { dealId: 'd', userId: 'u', role: 'BUYER', side: 'buy' },
      'member.role_changed': { dealId: 'd', userId: 'u', from: 'BUYER', to: 'BUYER_AGENT' },
      'member.removed': { dealId: 'd', userId: 'u', removedBy: 'admin' },
      'member.invite_declined': { dealId: 'd', email: 'a@b.com', role: 'BUYER', invitedBy: 'u' },
      'stage.advanced': { dealId: 'd', from: 2, to: 3, firmNow: true },
      'stage.updated': { dealId: 'd', n: 3, changed: { notes: { from: null, to: 'x' } } },
      'handshake.requested': {
        dealId: 'd',
        hsId: 'h',
        action: 'advance_stage',
        payload: {},
        initiatedBy: 'u',
        initiatedSide: 'sell',
        approverIds: ['b1'],
      },
      'handshake.approved': {
        dealId: 'd',
        hsId: 'h',
        action: 'advance_stage',
        payload: {},
        initiatedBy: 'u',
        initiatedSide: 'sell',
      },
      'handshake.rejected': {
        dealId: 'd',
        hsId: 'h',
        reason: 'not yet',
        initiatedBy: 'u',
        initiatedSide: 'sell',
      },
      'checklist.item_added': { dealId: 'd', n: 3, itemId: 'i', title: 'Phase I' },
      'checklist.item_toggled': { dealId: 'd', n: 3, itemId: 'i', done: true },
      'checklist.item_removed': { dealId: 'd', n: 3, itemId: 'i' },
      'payment.recorded': {
        dealId: 'd',
        payId: 'p',
        kind: 'earnest_money',
        amount: 50000,
        method: 'wire',
        payer: 'buyer',
        payee: 'escrow',
        recordedBy: 'u',
        scope: 'deal_wide',
      },
      'payment.confirmed': {
        dealId: 'd',
        payId: 'p',
        kind: 'earnest_money',
        amount: 50000,
        confirmedBy: 'admin',
      },
      'payment.voided': { dealId: 'd', payId: 'p', reason: 'dup' },
    };
    for (const [type, schema] of Object.entries(dealEventSchemas)) {
      expect(() => schema.parse(fixtures[type]), type).not.toThrow();
    }
  });
});
