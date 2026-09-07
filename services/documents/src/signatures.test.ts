import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from './scope.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('./repo.js');
vi.mock('./scope.js', async () => {
  const actual = await vi.importActual<typeof import('./scope.js')>('./scope.js');
  return { ...actual, requireViewer: vi.fn() };
});
vi.mock('./s3.js', () => ({
  s3Key: (d: string, id: string, n: number, f: string) => `${d}/${id}/v${n}/${f}`,
  putObject: vi.fn().mockResolvedValue(undefined),
  getObjectBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  presignPut: vi.fn(),
  presignGet: vi.fn(),
}));
vi.mock('@cre/platform', async () => {
  const actual = await vi.importActual<typeof import('@cre/platform')>('@cre/platform');
  return { ...actual, getMemberView: vi.fn() };
});

import { getMemberView } from '@cre/platform';
import { handler } from './api.js';
import { setProvider } from './provider/index.js';
import * as repo from './repo.js';
import { requireViewer } from './scope.js';

const eb = mockClient(EventBridgeClient);
process.env.EVENT_BUS_NAME = 'cre-portal-bus';
process.env.DOCUMENTS_TABLE = 'docs-test';

beforeEach(() => {
  vi.clearAllMocks();
  eb.reset();
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
  setProvider(undefined); // back to the default FakeProvider
  vi.mocked(getMemberView).mockResolvedValue({ role: 'BUYER', side: 'buy', status: 'active' } as never);
  vi.mocked(repo.getVersion).mockResolvedValue({ filename: 'psa.pdf', s3Key: 'd1/doc1/v1/psa.pdf' } as never);
  vi.mocked(repo.createEnvelope).mockResolvedValue(undefined);
  vi.mocked(repo.addVersion).mockResolvedValue({} as never);
  vi.mocked(repo.setEnvelopeStatus).mockResolvedValue(true);
  vi.mocked(repo.setRecipientOutcome).mockResolvedValue(true);
});

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  userId: 'u1',
  role: 'BUYER',
  side: 'buy',
  status: 'active',
  ...over,
});
const doc = (over: Partial<repo.DocumentRow> = {}): repo.DocumentRow => ({
  dealId: 'd1',
  docId: 'doc1',
  category: 'Purchase Agreement',
  title: 'PSA',
  scope: 'deal_wide',
  currentVersion: 1,
  versionCount: 1,
  uploadedBy: 'u1',
  createdAt: 't',
  ...over,
});
const env = (over: Partial<repo.SignatureEnvelope> = {}): repo.SignatureEnvelope => ({
  dealId: 'd1',
  docId: 'doc1',
  envId: 'env1',
  version: 1,
  scope: 'deal_wide',
  provider: 'fake',
  providerEnvelopeId: 'fake-env1',
  subject: 'Sign the PSA',
  status: 'sent',
  createdBy: 'u1',
  createdAt: 't',
  ...over,
});

function ev(over: { routeKey: string; path?: Record<string, string>; body?: unknown; sub?: string }) {
  return {
    routeKey: over.routeKey,
    rawPath: '/',
    headers: {},
    body: over.body === undefined ? undefined : JSON.stringify(over.body),
    isBase64Encoded: false,
    pathParameters: over.path ?? {},
    queryStringParameters: {},
    requestContext: {
      requestId: 'r1',
      http: { method: over.routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: over.sub ?? 'u1', email: 'u1@x.com' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };
const types = () =>
  eb.commandCalls(PutEventsCommand).flatMap((c) => c.args[0].input.Entries!.map((x) => x.DetailType));

const CREATE = 'POST /v1/deals/{dealId}/documents/{docId}/signature';
const SIGN = 'POST /v1/deals/{dealId}/documents/{docId}/signature/{envId}/sign';
const VOID = 'POST /v1/deals/{dealId}/documents/{docId}/signature/{envId}/void';

describe('POST …/signature (create)', () => {
  it('creates an envelope and emits signature.requested', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    const r = await run(
      ev({ routeKey: CREATE, path: { dealId: 'd1', docId: 'doc1' }, body: { signerUserIds: ['u1', 'u2'] } }),
    );
    expect(r.statusCode).toBe(201);
    expect(vi.mocked(repo.createEnvelope)).toHaveBeenCalledOnce();
    const [savedEnv, savedRcpts] = vi.mocked(repo.createEnvelope).mock.calls[0]!;
    expect(savedEnv).toMatchObject({ provider: 'fake', status: 'sent', createdBy: 'u1' });
    expect(savedRcpts.map((x) => x.userId)).toEqual(['u1', 'u2']);
    expect(types()).toContain('signature.requested');
  });

  it('400s when a chosen signer cannot see the document', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc({ category: 'Financing' }));
    vi.mocked(getMemberView).mockResolvedValue({ role: 'SELLER_AGENT', side: 'sell', status: 'active' } as never);
    const r = await run(
      ev({ routeKey: CREATE, path: { dealId: 'd1', docId: 'doc1' }, body: { signerUserIds: ['seller'] } }),
    );
    expect(r.statusCode).toBe(400);
    expect(vi.mocked(repo.createEnvelope)).not.toHaveBeenCalled();
  });

  it('403s an OTHER contributor', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'OTHER' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    const r = await run(
      ev({ routeKey: CREATE, path: { dealId: 'd1', docId: 'doc1' }, body: { signerUserIds: ['u1'] } }),
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('POST …/sign', () => {
  it('records a recipient, then completes + versions when the last signer signs', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer());
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env());
    vi.mocked(repo.listRecipients)
      .mockResolvedValueOnce([{ userId: 'u1', status: 'sent', routingOrder: 1 }] as never) // pre-check
      .mockResolvedValueOnce([{ userId: 'u1', status: 'completed', routingOrder: 1 }] as never) // remaining
      .mockResolvedValue([{ userId: 'u1', status: 'completed', routingOrder: 1 }] as never); // completeEnvelope
    const r = await run(ev({ routeKey: SIGN, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' } }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).status).toBe('completed');
    expect(vi.mocked(repo.addVersion)).toHaveBeenCalledOnce();
    expect(types()).toEqual(
      expect.arrayContaining(['signature.recipient_completed', 'document.versioned', 'signature.completed']),
    );
  });

  it('stays pending while other signers remain', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer());
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env());
    vi.mocked(repo.listRecipients)
      .mockResolvedValueOnce([
        { userId: 'u1', status: 'sent', routingOrder: 1 },
        { userId: 'u2', status: 'sent', routingOrder: 1 },
      ] as never)
      .mockResolvedValueOnce([
        { userId: 'u1', status: 'completed', routingOrder: 1 },
        { userId: 'u2', status: 'sent', routingOrder: 1 },
      ] as never);
    const r = await run(ev({ routeKey: SIGN, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' } }));
    expect(JSON.parse(r.body).status).toBe('recipient_completed');
    expect(vi.mocked(repo.addVersion)).not.toHaveBeenCalled();
    expect(types()).not.toContain('signature.completed');
  });

  it('declining kills the envelope and emits signature.declined', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer());
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env());
    vi.mocked(repo.listRecipients).mockResolvedValue([
      { userId: 'u1', status: 'sent', routingOrder: 1 },
    ] as never);
    const r = await run(
      ev({ routeKey: SIGN, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' }, body: { decline: true, reason: 'no' } }),
    );
    expect(JSON.parse(r.body).status).toBe('declined');
    expect(types()).toContain('signature.declined');
  });

  it('409s in docusign mode (signing happens on the platform)', async () => {
    setProvider({ name: 'docusign' } as never);
    vi.mocked(requireViewer).mockResolvedValue(viewer());
    const r = await run(ev({ routeKey: SIGN, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' } }));
    expect(r.statusCode).toBe(409);
  });

  it('403s a non-signer', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ userId: 'nobody' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env());
    vi.mocked(repo.listRecipients).mockResolvedValue([
      { userId: 'u1', status: 'sent', routingOrder: 1 },
    ] as never);
    const r = await run(
      ev({ routeKey: SIGN, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' }, sub: 'nobody' }),
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('POST …/void', () => {
  it('lets the requester void a sent envelope', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer());
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env({ createdBy: 'u1' }));
    const r = await run(
      ev({ routeKey: VOID, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' }, body: { reason: 'wrong doc' } }),
    );
    expect(JSON.parse(r.body).status).toBe('voided');
    expect(types()).toContain('signature.voided');
  });

  it('403s a non-requester who is not a lead', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ userId: 'u2', role: 'BUYER_ATTORNEY' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getEnvelope).mockResolvedValue(env({ createdBy: 'u1' }));
    const r = await run(
      ev({ routeKey: VOID, path: { dealId: 'd1', docId: 'doc1', envId: 'env1' }, sub: 'u2' }),
    );
    expect(r.statusCode).toBe(403);
  });
});
