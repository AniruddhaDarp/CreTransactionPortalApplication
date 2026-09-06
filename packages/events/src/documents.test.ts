import { describe, expect, it } from 'vitest';
import { documentEventSchemas } from './documents.js';

describe('document event schemas', () => {
  it('has all ten event types', () => {
    expect(Object.keys(documentEventSchemas)).toHaveLength(10);
  });

  it('every entry parses its fixture', () => {
    const fixtures: Record<string, unknown> = {
      'document.uploaded': { dealId: 'd', docId: 'x', category: 'Title', scope: 'deal_wide', uploadedBy: 'u' },
      'document.versioned': { dealId: 'd', docId: 'x', n: 2, scope: 'side_private:buy' },
      'document.promoted': { dealId: 'd', docId: 'x', scope: 'deal_wide' },
      'document.archived': { dealId: 'd', docId: 'x', hsId: 'h', scope: 'deal_wide' },
      'document.accessed': {
        dealId: 'd',
        docId: 'x',
        n: 1,
        mode: 'downloaded',
        by: 'u',
        scope: 'deal_wide',
      },
      'document.delete_requested': {
        dealId: 'd',
        docId: 'x',
        requestedBy: 'u',
        requesterRole: 'BUYER',
        requesterSide: 'buy',
      },
      'docrequest.created': { dealId: 'd', reqId: 'r', category: 'Financing', scope: 'deal_wide', createdBy: 'u' },
      'docrequest.fulfilled': {
        dealId: 'd',
        reqId: 'r',
        fulfilledDocId: 'x',
        scope: 'deal_wide',
        createdBy: 'u',
      },
      'docrequest.declined': {
        dealId: 'd',
        reqId: 'r',
        reason: 'wrong doc',
        scope: 'deal_wide',
        createdBy: 'u',
      },
      'docrequest.cancelled': { dealId: 'd', reqId: 'r', scope: 'side_private:buy' },
    };
    for (const [type, schema] of Object.entries(documentEventSchemas)) {
      expect(() => schema.parse(fixtures[type]), type).not.toThrow();
    }
  });

  it('rejects an unknown category', () => {
    expect(() =>
      documentEventSchemas['document.uploaded'].parse({
        dealId: 'd',
        docId: 'x',
        category: 'Blueprints',
        scope: 'deal_wide',
        uploadedBy: 'u',
      }),
    ).toThrow();
  });
});
