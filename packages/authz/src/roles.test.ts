import { describe, expect, it } from 'vitest';
import { isAgent, isAttorney, isBuySideLead, ROLE_SIDE, sideOf } from './roles.js';

describe('roles', () => {
  it('maps roles to their fixed side', () => {
    expect(ROLE_SIDE.BUYER).toBe('buy');
    expect(ROLE_SIDE.LENDER).toBe('buy');
    expect(ROLE_SIDE.SELLER_AGENT).toBe('sell');
    expect(ROLE_SIDE.TITLE_AGENT).toBe('neutral');
  });

  it('resolves OTHER only with an explicit side', () => {
    expect(sideOf('OTHER', 'buy')).toBe('buy');
    expect(() => sideOf('OTHER')).toThrow();
  });

  it('classifies agents and attorneys without catching TITLE_AGENT', () => {
    expect(isAgent('BUYER_AGENT')).toBe(true);
    expect(isAgent('SELLER_AGENT')).toBe(true);
    expect(isAgent('TITLE_AGENT')).toBe(false);
    expect(isAttorney('SELLER_ATTORNEY')).toBe(true);
    expect(isAttorney('LENDER')).toBe(false);
  });

  it('treats BUYER and BUYER_AGENT as buy-side leads', () => {
    expect(isBuySideLead('BUYER')).toBe(true);
    expect(isBuySideLead('BUYER_AGENT')).toBe(true);
    expect(isBuySideLead('BUYER_ATTORNEY')).toBe(false);
    expect(isBuySideLead('LENDER')).toBe(false);
  });
});
