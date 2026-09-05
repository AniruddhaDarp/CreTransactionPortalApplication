import { describe, expect, it } from 'vitest';
import { ROLE_SIDE, sideOf } from './index.js';

describe('@cre/authz vocabulary', () => {
  it('maps roles to their fixed side', () => {
    expect(ROLE_SIDE.BUYER).toBe('buy');
    expect(ROLE_SIDE.LENDER).toBe('buy');
    expect(ROLE_SIDE.SELLER_AGENT).toBe('sell');
    expect(ROLE_SIDE.TITLE_AGENT).toBe('neutral');
  });

  it('resolves OTHER to its assigned side', () => {
    expect(sideOf('OTHER', 'buy')).toBe('buy');
  });

  it('throws when OTHER has no assigned side', () => {
    expect(() => sideOf('OTHER')).toThrow();
  });
});
