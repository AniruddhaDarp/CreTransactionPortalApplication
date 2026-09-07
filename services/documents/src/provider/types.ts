/**
 * E-signature provider seam (Module 12, stretch). The Documents service owns
 * signature envelopes; the actual signing platform is pluggable. `FakeProvider`
 * drives the demo end-to-end in-process; `DocusignProvider` is the real
 * eSignature REST integration, gated off unless `ESIGN_PROVIDER=docusign`.
 */

export type EnvelopeStatus = 'sent' | 'completed' | 'declined' | 'voided';

export interface ProviderRecipient {
  userId: string;
  /** Required by DocuSign; ignored by the fake provider. */
  email?: string;
  name?: string;
  routingOrder: number;
}

export interface CreateEnvelopeInput {
  /** Our envelope id — carried to the provider as a correlation ref. */
  envId: string;
  dealId: string;
  docId: string;
  subject: string;
  message?: string;
  filename: string;
  title: string;
  /** The source PDF bytes — required for DocuSign, unused by the fake provider. */
  documentBytes?: Uint8Array;
  recipients: ProviderRecipient[];
}

export interface CreateEnvelopeResult {
  providerEnvelopeId: string;
  status: EnvelopeStatus;
}

export interface SignedPdf {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface ESignatureProvider {
  readonly name: 'fake' | 'docusign';
  createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult>;
  /**
   * The provider's authoritative view of the envelope, or `null` when the
   * provider keeps no state of its own (the fake provider — our table is the
   * source of truth). Used by `GET …/signature` to reconcile real-mode
   * envelopes without a webhook.
   */
  getStatus(providerEnvelopeId: string): Promise<{ status: EnvelopeStatus } | null>;
  getSignedPdf(input: {
    providerEnvelopeId: string;
    envId: string;
    docId: string;
    filename: string;
    title: string;
    signerUserIds: string[];
  }): Promise<SignedPdf>;
  void(providerEnvelopeId: string, reason: string): Promise<void>;
}
