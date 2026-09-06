import { describe, expect, it } from 'vitest';
import { canSeeDocument, categoryVisible } from './documents.js';
import type { Role } from './roles.js';

describe('document category matrix', () => {
  it('hides Financing / Appraisal from the sell side', () => {
    expect(categoryVisible('SELLER_AGENT', 'sell', 'Financing', 'deal_wide')).toBe(false);
    expect(categoryVisible('SELLER', 'sell', 'Appraisal', 'deal_wide')).toBe(false);
    expect(categoryVisible('BUYER', 'buy', 'Financing', 'deal_wide')).toBe(true);
  });

  it('shows Inspection to the sell side only when the doc is deal-wide', () => {
    expect(categoryVisible('SELLER_AGENT', 'sell', 'Inspection', 'deal_wide')).toBe(true);
    expect(categoryVisible('SELLER_AGENT', 'sell', 'Inspection', 'side_private:sell')).toBe(false);
    expect(categoryVisible('BUYER_AGENT', 'buy', 'Inspection', 'side_private:buy')).toBe(true);
  });

  it('gives LENDER the financing docs but not the inspection report', () => {
    expect(categoryVisible('LENDER', 'buy', 'Financing', 'deal_wide')).toBe(true);
    expect(categoryVisible('LENDER', 'buy', 'Appraisal', 'deal_wide')).toBe(true);
    expect(categoryVisible('LENDER', 'buy', 'Inspection', 'deal_wide')).toBe(false);
  });

  it('limits TITLE_AGENT to title/contract/closing categories', () => {
    expect(categoryVisible('TITLE_AGENT', 'neutral', 'Title', 'deal_wide')).toBe(true);
    expect(categoryVisible('TITLE_AGENT', 'neutral', 'Purchase Agreement', 'deal_wide')).toBe(true);
    expect(categoryVisible('TITLE_AGENT', 'neutral', 'Financing', 'deal_wide')).toBe(false);
  });

  it('canSeeDocument combines scope AND category', () => {
    const sellAgent = { role: 'SELLER_AGENT' as Role, side: 'sell' as const, status: 'active' as const };
    // scope OK but category hidden
    expect(canSeeDocument(sellAgent, 'deal_wide', 'Financing')).toBe(false);
    // category OK but scope not visible
    expect(canSeeDocument(sellAgent, 'side_private:buy', 'Title')).toBe(false);
    // both OK
    expect(canSeeDocument(sellAgent, 'deal_wide', 'Title')).toBe(true);
  });
});
