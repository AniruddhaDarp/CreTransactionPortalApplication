import { describe, expect, it } from 'vitest';
import type { Role } from './roles.js';
import { canSee, visibleScopes } from './scope.js';

const m = (role: Role, side: 'buy' | 'sell' | 'neutral', status = 'active' as const) => ({
  role,
  side,
  status,
});

describe('visibleScopes', () => {
  it('gives an active deal-wide member exactly deal_wide + their own side', () => {
    expect([...visibleScopes(m('BUYER', 'buy'))].sort()).toEqual(
      ['deal_wide', 'side_private:buy'].sort(),
    );
    expect([...visibleScopes(m('SELLER', 'sell'))].sort()).toEqual(
      ['deal_wide', 'side_private:sell'].sort(),
    );
  });

  it('adds the agent channel for agents and the attorney channel for attorneys', () => {
    expect(visibleScopes(m('BUYER_AGENT', 'buy')).has('channel:agent')).toBe(true);
    expect(visibleScopes(m('SELLER_ATTORNEY', 'sell')).has('channel:attorney')).toBe(true);
    expect(visibleScopes(m('BUYER_AGENT', 'buy')).has('channel:attorney')).toBe(false);
  });

  it('limits TITLE_AGENT to deal_wide', () => {
    expect([...visibleScopes(m('TITLE_AGENT', 'neutral'))]).toEqual(['deal_wide']);
  });

  it('gives OTHER deal_wide + its own side, no channels', () => {
    expect([...visibleScopes(m('OTHER', 'buy'))].sort()).toEqual(
      ['deal_wide', 'side_private:buy'].sort(),
    );
  });

  it('gives a non-active member nothing', () => {
    expect(visibleScopes(m('BUYER', 'buy', 'removed' as unknown as 'active')).size).toBe(0);
  });

  it('canSee is a membership of visibleScopes', () => {
    expect(canSee(m('SELLER', 'sell'), 'side_private:buy')).toBe(false);
    expect(canSee(m('SELLER', 'sell'), 'side_private:sell')).toBe(true);
  });
});
