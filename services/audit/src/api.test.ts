import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRow } from './repo.js';
import type { Viewer } from './scope.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('./repo.js');
vi.mock('./scope.js', async () => {
  const actual = await vi.importActual<typeof import('./scope.js')>('./scope.js');
  return { ...actual, requireViewer: vi.fn() };
});

import * as repo from './repo.js';
import { requireViewer } from './scope.js';
import { handler } from './api.js';

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  userId: 'u1',
  role: 'SELLER_AGENT',
  side: 'sell',
  status: 'active',
  ...over,
});

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  dealId: 'd1',
  eventId: `e${Math.random()}`,
  occurredAt: '2026-01-01T00:00:00.000Z',
  actorId: 'admin',
  detailType: 'deal.created',
  action: 'deal.created',
  targetType: 'deal',
  targetId: 'd1',
  scope: 'deal_wide',
  summary: 'Deal created',
  correlationId: 'c1',
  ...over,
});

function event(over: { routeKey: string; path?: Record<string, string>; query?: Record<string, string>; sub?: string }) {
  return {
    routeKey: over.routeKey,
    rawPath: '/',
    headers: {},
    isBase64Encoded: false,
    pathParameters: over.path ?? {},
    queryStringParameters: over.query ?? {},
    requestContext: {
      requestId: 'r1',
      http: { method: 'GET' },
      authorizer: { jwt: { claims: { sub: over.sub ?? 'u1', email: 'u1@x.com' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string; headers?: Record<string, string> };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUDIT_TABLE = 'audit-test';
  process.env.AUDIT_MEMBERSHIP_TABLE = 'audit-mv-test';
});

describe('GET /audit — scoped read', () => {
  it('never returns the counterparty side-private rows (no god view)', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'SELLER_AGENT', side: 'sell' }));
    vi.mocked(repo.queryDeal).mockResolvedValue({
      rows: [
        row({ scope: 'deal_wide', summary: 'visible' }),
        row({ scope: 'side_private:buy', summary: 'hidden from sell' }),
        row({ scope: 'channel:attorney', summary: 'hidden from agent' }),
        row({ scope: 'side_private:sell', summary: 'own side' }),
      ],
      nextCursor: undefined,
    });
    const r = await run(event({ routeKey: 'GET /v1/deals/{dealId}/audit', path: { dealId: 'd1' } }));
    expect(r.statusCode).toBe(200);
    const summaries = JSON.parse(r.body).events.map((e: AuditRow) => e.summary);
    expect(summaries).toEqual(['visible', 'own side']);
  });

  it('applies the action filter on top of scope', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.queryDeal).mockResolvedValue({
      rows: [
        row({ scope: 'deal_wide', detailType: 'deal.created' }),
        row({ scope: 'deal_wide', detailType: 'stage.advanced', action: 'stage.advanced' }),
      ],
      nextCursor: undefined,
    });
    const r = await run(
      event({
        routeKey: 'GET /v1/deals/{dealId}/audit',
        path: { dealId: 'd1' },
        query: { action: 'stage.advanced' },
      }),
    );
    const rows = JSON.parse(r.body).events;
    expect(rows).toHaveLength(1);
    expect(rows[0].detailType).toBe('stage.advanced');
  });

  it('403s when the caller is not an active member', async () => {
    const { HttpError } = await vi.importActual<typeof import('@cre/platform')>('@cre/platform');
    vi.mocked(requireViewer).mockRejectedValue(new HttpError(403, 'not a member'));
    const r = await run(event({ routeKey: 'GET /v1/deals/{dealId}/audit', path: { dealId: 'd1' } }));
    expect(r.statusCode).toBe(403);
  });
});

describe('GET /audit — pagination', () => {
  beforeEach(() => {
    vi.mocked(repo.rowCursor).mockImplementation((r) => `cur-${r.eventId}`);
  });
  const many = (n: number, over: Partial<AuditRow> = {}) =>
    Array.from({ length: n }, (_, i) =>
      row({ scope: 'deal_wide', eventId: `e${i}`, occurredAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, ...over }),
    );

  it('returns a resume cursor when the page fills, even with no DynamoDB LastEvaluatedKey', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.queryDeal).mockResolvedValue({ rows: many(40), nextCursor: undefined });
    const r = await run(
      event({ routeKey: 'GET /v1/deals/{dealId}/audit', path: { dealId: 'd1' }, query: { limit: '5' } }),
    );
    const body = JSON.parse(r.body);
    expect(body.events).toHaveLength(5);
    expect(typeof body.nextCursor).toBe('string'); // was `undefined` before the fix
  });

  it('keeps paging the partition when scope filtering empties a page', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.queryDeal)
      .mockResolvedValueOnce({ rows: many(3, { scope: 'side_private:sell' }), nextCursor: 'c1' }) // all filtered out
      .mockResolvedValueOnce({ rows: many(3, { scope: 'side_private:sell' }), nextCursor: 'c2' }) // filtered out
      .mockResolvedValueOnce({ rows: many(4, { scope: 'deal_wide' }), nextCursor: undefined }); // visible
    const r = await run(
      event({ routeKey: 'GET /v1/deals/{dealId}/audit', path: { dealId: 'd1' }, query: { limit: '5' } }),
    );
    const body = JSON.parse(r.body);
    expect(body.events).toHaveLength(4);
    expect(body.nextCursor).toBeUndefined(); // ran out
    expect(vi.mocked(repo.queryDeal)).toHaveBeenCalledTimes(3);
  });

  it('no cursor once the data is exhausted within one page', async () => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.queryDeal).mockResolvedValue({ rows: many(3), nextCursor: undefined });
    const r = await run(
      event({ routeKey: 'GET /v1/deals/{dealId}/audit', path: { dealId: 'd1' }, query: { limit: '50' } }),
    );
    const body = JSON.parse(r.body);
    expect(body.events).toHaveLength(3);
    expect(body.nextCursor).toBeUndefined();
  });
});

describe('GET /audit/export', () => {
  beforeEach(() => {
    vi.mocked(requireViewer).mockResolvedValue(viewer({ role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.scanDeal).mockResolvedValue([
      row({ scope: 'deal_wide', summary: 'plain' }),
      row({ scope: 'side_private:sell', summary: 'not for buyer' }),
      row({ scope: 'side_private:buy', summary: 'has, comma "quote"' }),
    ]);
  });

  it('csv: text/csv, attachment, scoped, and RFC-escaped', async () => {
    const r = await run(
      event({
        routeKey: 'GET /v1/deals/{dealId}/audit/export',
        path: { dealId: 'd1' },
        query: { format: 'csv' },
      }),
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers?.['content-type']).toContain('text/csv');
    expect(r.headers?.['content-disposition']).toContain('attachment; filename="audit-d1-');
    const lines = r.body.trim().split('\n');
    expect(lines[0]).toBe(
      'occurredAt,actorId,detailType,action,targetType,targetId,scope,summary,correlationId',
    );
    expect(r.body).toContain('"has, comma ""quote"""');
    expect(r.body).not.toContain('not for buyer'); // sell-private filtered out
  });

  it('json: application/json attachment with a scoped events array', async () => {
    const r = await run(
      event({
        routeKey: 'GET /v1/deals/{dealId}/audit/export',
        path: { dealId: 'd1' },
        query: { format: 'json' },
      }),
    );
    expect(r.headers?.['content-type']).toContain('application/json');
    const parsed = JSON.parse(r.body);
    expect(parsed.count).toBe(2);
    expect(parsed.events.map((e: AuditRow) => e.summary).sort()).toEqual([
      'has, comma "quote"',
      'plain',
    ]);
  });

  it('rejects an unknown format', async () => {
    const r = await run(
      event({
        routeKey: 'GET /v1/deals/{dealId}/audit/export',
        path: { dealId: 'd1' },
        query: { format: 'xml' },
      }),
    );
    expect(r.statusCode).toBe(400);
  });
});
