import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake.js';

describe('FakeProvider', () => {
  const p = new FakeProvider();

  it('creates an envelope in "sent" with a deterministic provider id', async () => {
    const r = await p.createEnvelope({
      envId: 'env-1',
      dealId: 'd1',
      docId: 'doc1',
      subject: 's',
      filename: 'psa.pdf',
      title: 'PSA',
      recipients: [{ userId: 'u1', routingOrder: 1 }],
    });
    expect(r).toEqual({ providerEnvelopeId: 'fake-env-1', status: 'sent' });
  });

  it('keeps no state of its own (getStatus is null)', async () => {
    expect(await p.getStatus('fake-env-1')).toBeNull();
  });

  it('synthesises a real, openable PDF as the signed copy', async () => {
    const signed = await p.getSignedPdf({
      envId: 'env-1',
      title: 'PSA',
      filename: 'psa.pdf',
      signerUserIds: ['u1', 'u2'],
    });
    expect(signed.contentType).toBe('application/pdf');
    expect(signed.filename).toBe('psa-signed.pdf');
    const head = Buffer.from(signed.bytes).toString('latin1');
    expect(head.startsWith('%PDF-1.')).toBe(true);
    expect(head.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(head).toContain('SIGNED COPY');
    expect(head).toContain('env-1');
  });
});
