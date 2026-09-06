import { describe, expect, it } from 'vitest';
import { deriveScope, viewerScopes, type Viewer } from './scope.js';

describe('deriveScope', () => {
  it('takes the explicit scope from an event that carries one', () => {
    expect(deriveScope({ scope: 'side_private:buy' })).toBe('side_private:buy');
  });
  it('takes toScope from a thread.converted event', () => {
    expect(deriveScope({ toScope: 'side_private:sell' })).toBe('side_private:sell');
  });
  it('defaults deal-domain events (no scope field) to deal_wide', () => {
    expect(deriveScope({ userId: 'u1', role: 'BUYER' })).toBe('deal_wide');
  });
  it('ignores a garbage scope value rather than trusting it', () => {
    expect(deriveScope({ scope: 'everyone' })).toBe('deal_wide');
  });
});

describe('viewerScopes — no god view', () => {
  const v = (over: Partial<Viewer>): Viewer => ({
    userId: 'u',
    role: 'SELLER_AGENT',
    side: 'sell',
    status: 'active',
    ...over,
  });

  it('the sell-side admin cannot see buy-side-private or attorney-channel rows', () => {
    const s = viewerScopes(v({ role: 'SELLER_AGENT', side: 'sell' }));
    expect(s.has('deal_wide')).toBe(true);
    expect(s.has('side_private:sell')).toBe(true);
    expect(s.has('channel:agent')).toBe(true); // SELLER_AGENT is an agent
    expect(s.has('side_private:buy')).toBe(false);
    expect(s.has('channel:attorney')).toBe(false);
  });

  it('a buyer sees deal-wide + buy-private only', () => {
    const s = viewerScopes(v({ role: 'BUYER', side: 'buy' }));
    expect([...s].sort()).toEqual(['deal_wide', 'side_private:buy']);
  });

  it('an inactive member sees nothing', () => {
    expect(viewerScopes(v({ status: 'removed' })).size).toBe(0);
  });
});
