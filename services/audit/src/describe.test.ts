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

  it('describes payment lifecycle events', () => {
    const rec = summarize('payment.recorded', {
      payId: 'p1',
      kind: 'earnest_money',
      amount: 50000,
      method: 'wire',
      payer: 'buyer',
      payee: 'escrow',
    });
    expect(rec).toMatchObject({ action: 'payment.recorded', targetType: 'payment', targetId: 'p1' });
    expect(rec.summary).toContain('earnest_money $50000');
    expect(rec.summary).toContain('buyer → escrow');
    expect(summarize('payment.confirmed', { payId: 'p1', kind: 'earnest_money', amount: 50000 }).summary).toBe(
      'Payment confirmed — earnest_money $50000',
    );
    expect(summarize('payment.voided', { payId: 'p1', reason: 'dup' }).summary).toBe(
      'Payment voided — dup',
    );
  });

  it('describes e-signature lifecycle events', () => {
    expect(
      summarize('signature.requested', { envId: 'e1', provider: 'fake', recipientUserIds: ['a', 'b'] }).summary,
    ).toBe('Sent for signature (2 signer(s), via fake)');
    expect(summarize('signature.completed', { envId: 'e1', signedVersion: 3 }).summary).toBe(
      'Signature complete — signed copy saved as v3',
    );
    expect(summarize('signature.declined', { envId: 'e1', reason: 'wrong party' }).summary).toBe(
      'Signature declined — wrong party',
    );
    expect(summarize('signature.voided', { envId: 'e1' }).targetType).toBe('signature');
  });

  it('falls back to the detail-type for unknown events', () => {
    expect(summarize('mystery.event', {})).toEqual({
      action: 'mystery.event',
      targetType: 'event',
      summary: 'mystery.event',
    });
  });
});
