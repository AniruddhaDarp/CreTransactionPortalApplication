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
        'member.joined',
        'member.removed',
        'member.role_changed',
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
    };
    for (const [type, schema] of Object.entries(dealEventSchemas)) {
      expect(() => schema.parse(fixtures[type]), type).not.toThrow();
    }
  });
});
