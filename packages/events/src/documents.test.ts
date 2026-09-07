import { describe, expect, it } from 'vitest';
import { documentEventSchemas } from './documents.js';

describe('document event schemas', () => {
  it('has all fifteen event types', () => {
    expect(Object.keys(documentEventSchemas)).toHaveLength(15);
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
      'signature.requested': {
        dealId: 'd',
        docId: 'x',
        envId: 'env1',
        version: 2,
        scope: 'deal_wide',
        provider: 'fake',
        recipientUserIds: ['u1', 'u2'],
        createdBy: 'u9',
      },
      'signature.recipient_completed': {
        dealId: 'd',
        docId: 'x',
        envId: 'env1',
        userId: 'u1',
        scope: 'deal_wide',
      },
      'signature.completed': {
        dealId: 'd',
        docId: 'x',
        envId: 'env1',
        signedVersion: 3,
        scope: 'deal_wide',
      },
      'signature.declined': {
        dealId: 'd',
        docId: 'x',
        envId: 'env1',
        userId: 'u2',
        reason: 'wrong counterparty',
        scope: 'deal_wide',
        createdBy: 'u9',
      },
      'signature.voided': { dealId: 'd', docId: 'x', envId: 'env1', scope: 'deal_wide' },
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
