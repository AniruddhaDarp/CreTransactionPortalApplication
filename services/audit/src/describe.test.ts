import { describe, expect, it } from 'vitest';
import { summarize } from './describe.js';

describe('summarize', () => {
  it('describes a member.joined', () => {
    const d = summarize('member.joined', { userId: 'u1', role: 'BUYER', side: 'buy' });
    expect(d).toMatchObject({ action: 'member.joined', targetType: 'member', targetId: 'u1' });
    expect(d.summary).toBe('BUYER joined (buy)');
  });

  it('describes a handshake.approved with its action', () => {
    expect(summarize('handshake.approved', { hsId: 'h1', action: 'advance_stage' }).summary).toBe(
      'Handshake approved: advance_stage',
    );
  });

  it('describes a document.accessed with mode + actor', () => {
    const d = summarize('document.accessed', { docId: 'x', n: 2, mode: 'downloaded', by: 'u9' });
    expect(d.targetType).toBe('document');
    expect(d.summary).toBe('Document downloaded (v2) by u9');
  });

  it('renders deal.updated field diffs', () => {
    const d = summarize('deal.updated', { dealId: 'd1', changed: { price: { from: 100, to: 200 } } });
    expect(d.summary).toContain('price: 100 → 200');
  });

  it('falls back to the detail-type for unknown events', () => {
    expect(summarize('mystery.event', {})).toEqual({
      action: 'mystery.event',
      targetType: 'event',
      summary: 'mystery.event',
    });
  });
});
