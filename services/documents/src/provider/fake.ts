import type {
  CreateEnvelopeInput,
  CreateEnvelopeResult,
  ESignatureProvider,
  SignedPdf,
} from './types.js';
import { renderTextPdf } from './pdf.js';

/**
 * In-process e-signature provider for the demo. It holds no state of its own —
 * signing is driven by the `POST …/signature/{envId}/sign` route and our
 * DynamoDB rows are authoritative, so `getStatus` returns `null`. `getSignedPdf`
 * synthesises a one-page "signed copy" so the completed version is a real,
 * openable PDF.
 */
export class FakeProvider implements ESignatureProvider {
  readonly name = 'fake' as const;

  async createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
    return { providerEnvelopeId: `fake-${input.envId}`, status: 'sent' };
  }

  async getStatus(_providerEnvelopeId: string): Promise<null> {
    return null;
  }

  async getSignedPdf(input: {
    envId: string;
    title: string;
    filename: string;
    signerUserIds: string[];
  }): Promise<SignedPdf> {
    const bytes = renderTextPdf([
      'SIGNED COPY',
      '',
      `Document:  ${input.title}`,
      `Envelope:  ${input.envId}`,
      `Completed: ${new Date().toISOString()}`,
      '',
      'Signers:',
      ...input.signerUserIds.map((u) => `  - ${u}`),
      '',
      'This is a simulated signature produced by the demo e-signature',
      'provider (ESIGN_PROVIDER=fake). No legally binding signature was',
      'captured. Set ESIGN_PROVIDER=docusign for real envelopes.',
    ]);
    const base = input.filename.replace(/\.pdf$/i, '');
    return { bytes, contentType: 'application/pdf', filename: `${base}-signed.pdf` };
  }

  async void(): Promise<void> {
    /* nothing to do */
  }
}
