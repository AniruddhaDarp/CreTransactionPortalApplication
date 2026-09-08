import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from './scope.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('./repo.js');
vi.mock('./scope.js', async () => {
  const actual = await vi.importActual<typeof import('./scope.js')>('./scope.js');
  return { ...actual, requireViewer: vi.fn() };
});
vi.mock('./s3.js', () => ({
  s3Key: (d: string, id: string, n: number, f: string) => `${d}/${id}/v${n}/${f}`,
  presignPut: vi.fn().mockResolvedValue('https://s3.example/put'),
  presignGet: vi.fn().mockResolvedValue('https://s3.example/get'),
}));

import { HttpError } from '@cre/platform';
import * as repo from './repo.js';
import { requireViewer } from './scope.js';
import { handler } from './api.js';

const eb = mockClient(EventBridgeClient);
process.env.EVENT_BUS_NAME = 'cre-portal-bus';
process.env.DOCUMENTS_TABLE = 'docs-test';

beforeEach(() => {
  vi.clearAllMocks();
  eb.reset();
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
  vi.mocked(repo.getDealStatus).mockResolvedValue('ACTIVE');
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
  category: 'Financing',
  title: 'Loan package',
  scope: 'deal_wide',
  currentVersion: 1,
  versionCount: 1,
  uploadedBy: 'u1',
  createdAt: 't',
  ...over,
});

function event(over: {
  routeKey: string;
  path?: Record<string, string>;
  body?: unknown;
  sub?: string;
}) {
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

describe('membership gate', () => {
  it('propagates the 403 from requireViewer when the caller is not synced', async () => {
    vi.mocked(requireViewer).mockRejectedValue(new HttpError(403, 'not an active member'));
    const r = await run(event({ routeKey: 'GET /v1/deals/{dealId}/documents', path: { dealId: 'd1' } }));
    expect(r.statusCode).toBe(403);
  });
});

describe('category matrix on list', () => {
  it('hides Financing / Appraisal documents from sell-side members', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'SELLER_AGENT', side: 'sell' }));
    vi.mocked(repo.listDocuments).mockResolvedValue([
      doc({ docId: 'fin', category: 'Financing' }),
      doc({ docId: 'app', category: 'Appraisal' }),
      doc({ docId: 'psa', category: 'Purchase Agreement' }),
    ]);
    const r = await run(
      event({ routeKey: 'GET /v1/deals/{dealId}/documents', path: { dealId: 'd1' } }),
    );
    expect(r.statusCode).toBe(200);
    const ids = JSON.parse(r.body).documents.map((d: repo.DocumentRow) => d.docId);
    expect(ids).toEqual(['psa']);
  });

  it('lets a buy-side member see Financing', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'LENDER', side: 'buy' }));
    vi.mocked(repo.listDocuments).mockResolvedValue([doc({ docId: 'fin', category: 'Financing' })]);
    const r = await run(
      event({ routeKey: 'GET /v1/deals/{dealId}/documents', path: { dealId: 'd1' } }),
    );
    expect(JSON.parse(r.body).documents.map((d: repo.DocumentRow) => d.docId)).toEqual(['fin']);
  });
});

describe('upload', () => {
  it('creates the row, emits document.uploaded, and returns a presigned PUT url', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT', side: 'buy' }));
    vi.mocked(repo.createDocument).mockResolvedValue();
    const r = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/documents',
        path: { dealId: 'd1' },
        body: {
          category: 'Financing',
          title: 'Term sheet',
          scope: 'side_private:buy',
          filename: 'ts.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body).uploadUrl).toBe('https://s3.example/put');
    expect(repo.createDocument).toHaveBeenCalledOnce();
    expect(types()).toContain('document.uploaded');
  });

  it('409s any write once the deal is CLOSED (read-only room)', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT', side: 'buy' }));
    vi.mocked(repo.getDealStatus).mockResolvedValue('CLOSED');
    const r = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/documents',
        path: { dealId: 'd1' },
        body: {
          category: 'Disclosure',
          title: 'x',
          scope: 'deal_wide',
          filename: 'x.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(r.statusCode).toBe(409);
  });

  it('403s when a sell-side member tries to write into the buy-side private scope', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'SELLER_AGENT', side: 'sell' }));
    const r = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/documents',
        path: { dealId: 'd1' },
        body: {
          category: 'Disclosure',
          title: 'x',
          scope: 'side_private:buy',
          filename: 'x.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(r.statusCode).toBe(403);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });
});

describe('delete saga', () => {
  it('a buy-side lead DELETE emits document.delete_requested and returns 202 (no archive yet)', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    const r = await run(
      event({
        routeKey: 'DELETE /v1/deals/{dealId}/documents/{docId}',
        path: { dealId: 'd1', docId: 'doc1' },
      }),
    );
    expect(r.statusCode).toBe(202);
    expect(types()).toEqual(['document.delete_requested']);
    expect(repo.archiveDocument).not.toHaveBeenCalled();
  });

  it('403s a role that is neither admin nor a buy-side lead', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_ATTORNEY', side: 'buy' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    const r = await run(
      event({
        routeKey: 'DELETE /v1/deals/{dealId}/documents/{docId}',
        path: { dealId: 'd1', docId: 'doc1' },
      }),
    );
    expect(r.statusCode).toBe(403);
    expect(types()).toEqual([]);
  });
});

describe('promote', () => {
  it('moves a side-private doc to deal-wide and emits document.promoted', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT', side: 'buy' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc({ scope: 'side_private:buy' }));
    vi.mocked(repo.promoteDocument).mockResolvedValue(doc({ scope: 'deal_wide' }));
    const r = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/documents/{docId}/promote',
        path: { dealId: 'd1', docId: 'doc1' },
      }),
    );
    expect(r.statusCode).toBe(200);
    expect(types()).toContain('document.promoted');
  });

  it('409s when the document is already deal-wide', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER_AGENT', side: 'buy' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc({ scope: 'deal_wide' }));
    const r = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/documents/{docId}/promote',
        path: { dealId: 'd1', docId: 'doc1' },
      }),
    );
    expect(r.statusCode).toBe(409);
  });
});

describe('access logging', () => {
  it('download presigns the version and emits document.accessed with mode=downloaded', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.getDocument).mockResolvedValue(doc());
    vi.mocked(repo.getVersion).mockResolvedValue({
      dealId: 'd1',
      docId: 'doc1',
      n: 1,
      s3Key: 'd1/doc1/v1/loan.pdf',
      filename: 'loan.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'u1',
      uploadedAt: 't',
    });
    const r = await run(
      event({
        routeKey: 'GET /v1/deals/{dealId}/documents/{docId}/versions/{n}/download',
        path: { dealId: 'd1', docId: 'doc1', n: '1' },
      }),
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).url).toBe('https://s3.example/get');
    const c = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(c.DetailType).toBe('document.accessed');
    expect(JSON.parse(c.Detail!).detail.mode).toBe('downloaded');
  });
});
