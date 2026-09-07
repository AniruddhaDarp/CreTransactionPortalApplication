import { createSign } from 'node:crypto';
import type {
  CreateEnvelopeInput,
  CreateEnvelopeResult,
  ESignatureProvider,
  EnvelopeStatus,
  SignedPdf,
} from './types.js';

/**
 * Real DocuSign eSignature REST v2.1 integration, authenticated with the JWT
 * Grant (service integration) flow. Inert unless `ESIGN_PROVIDER=docusign` and
 * the `DOCUSIGN_*` env vars are set — mirrors the flag-gated SES path in
 * Notifications. Not exercised in the demo project (no DocuSign account), so it
 * carries no automated E2E; the JWT assembly and request shapes follow the
 * published API.
 */

interface Cfg {
  oauthBase: string; // account-d.docusign.com (demo) | account.docusign.com
  restBase: string; // https://demo.docusign.net
  integrationKey: string;
  userId: string;
  accountId: string;
  privateKey: string; // RSA PEM
}

function cfg(): Cfg {
  const c: Cfg = {
    oauthBase: process.env.DOCUSIGN_OAUTH_BASE ?? 'account-d.docusign.com',
    restBase: process.env.DOCUSIGN_REST_BASE ?? '',
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY ?? '',
    userId: process.env.DOCUSIGN_USER_ID ?? '',
    accountId: process.env.DOCUSIGN_ACCOUNT_ID ?? '',
    privateKey: process.env.DOCUSIGN_PRIVATE_KEY ?? '',
  };
  for (const [k, v] of Object.entries(c)) {
    if (!v) throw new Error(`DocuSign provider misconfigured: ${k} is unset`);
  }
  return c;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Build + RS256-sign the JWT assertion, then exchange it for an access token. */
async function accessToken(c: Cfg): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: c.integrationKey,
      sub: c.userId,
      aud: c.oauthBase,
      iat: now,
      exp: now + 3600,
      scope: 'signature impersonation',
    }),
  );
  const signature = b64url(
    createSign('RSA-SHA256').update(`${header}.${claims}`).sign(c.privateKey),
  );
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(`https://${c.oauthBase}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`DocuSign token exchange failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api(
  c: Cfg,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${c.restBase}/restapi/v2.1/accounts/${c.accountId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`DocuSign ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res;
}

const mapStatus = (s: string): EnvelopeStatus =>
  s === 'completed' ? 'completed' : s === 'declined' ? 'declined' : s === 'voided' ? 'voided' : 'sent';

export class DocusignProvider implements ESignatureProvider {
  readonly name = 'docusign' as const;

  async createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
    if (!input.documentBytes) throw new Error('DocuSign envelopes need the source document bytes');
    const c = cfg();
    const token = await accessToken(c);
    const signers = input.recipients.map((r, i) => {
      if (!r.email || !r.name) {
        throw new Error(`signer ${r.userId} is missing an email/name (required in docusign mode)`);
      }
      return {
        email: r.email,
        name: r.name,
        recipientId: String(i + 1),
        routingOrder: String(r.routingOrder),
        tabs: {
          signHereTabs: [
            { documentId: '1', pageNumber: '1', xPosition: '100', yPosition: String(600 + i * 40) },
          ],
        },
      };
    });
    const res = await api(c, token, 'POST', '/envelopes', {
      emailSubject: input.subject,
      emailBlurb: input.message,
      status: 'sent',
      customFields: {
        textCustomFields: [
          {
            name: 'creRef',
            value: JSON.stringify({ dealId: input.dealId, docId: input.docId, envId: input.envId }),
            show: 'false',
          },
        ],
      },
      documents: [
        {
          documentId: '1',
          name: input.filename,
          fileExtension: 'pdf',
          documentBase64: Buffer.from(input.documentBytes).toString('base64'),
        },
      ],
      recipients: { signers },
    });
    const env = (await res.json()) as { envelopeId: string; status: string };
    return { providerEnvelopeId: env.envelopeId, status: mapStatus(env.status) };
  }

  async getStatus(providerEnvelopeId: string): Promise<{ status: EnvelopeStatus }> {
    const c = cfg();
    const token = await accessToken(c);
    const res = await api(c, token, 'GET', `/envelopes/${providerEnvelopeId}`);
    const env = (await res.json()) as { status: string };
    return { status: mapStatus(env.status) };
  }

  async getSignedPdf(input: { providerEnvelopeId: string; filename: string }): Promise<SignedPdf> {
    const c = cfg();
    const token = await accessToken(c);
    const res = await fetch(
      `${c.restBase}/restapi/v2.1/accounts/${c.accountId}/envelopes/${input.providerEnvelopeId}/documents/combined`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`DocuSign document fetch failed (${res.status})`);
    const base = input.filename.replace(/\.pdf$/i, '');
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: 'application/pdf',
      filename: `${base}-signed.pdf`,
    };
  }

  async void(providerEnvelopeId: string, reason: string): Promise<void> {
    const c = cfg();
    const token = await accessToken(c);
    await api(c, token, 'PUT', `/envelopes/${providerEnvelopeId}`, {
      status: 'voided',
      voidedReason: reason || 'voided in the CRE portal',
    });
  }
}
