import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow } from './repo.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.mock('./repo.js');

import * as repo from './repo.js';
import { handler } from './api.js';

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  userId: 'u1',
  notifId: 'e1',
  occurredAt: '2026-03-03T10:00:00.000Z',
  type: 'mention',
  title: 'You were mentioned',
  sourceEventId: 'e1',
  ...over,
});

function event(over: { routeKey: string; body?: unknown; query?: Record<string, string>; sub?: string }) {
  return {
    routeKey: over.routeKey,
    rawPath: '/',
    headers: {},
    isBase64Encoded: false,
    body: over.body === undefined ? undefined : JSON.stringify(over.body),
    pathParameters: {},
    queryStringParameters: over.query ?? {},
    requestContext: {
      requestId: 'r1',
      http: { method: over.routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: over.sub ?? 'u1' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };

beforeEach(() => vi.clearAllMocks());

describe('GET /v1/notifications', () => {
  it('returns the rows with a composite id + an unread count', async () => {
    vi.mocked(repo.listForUser).mockResolvedValue([
      row({ sourceEventId: 'a' }),
      row({ sourceEventId: 'b', readAt: '2026-03-03T11:00:00.000Z' }),
    ]);
    const r = await run(event({ routeKey: 'GET /v1/notifications' }));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0].id).toBe('2026-03-03T10:00:00.000Z#a');
  });
});

describe('POST /v1/notifications/read', () => {
  it('marks a single notification read by its composite id', async () => {
    vi.mocked(repo.markRead).mockResolvedValue();
    const r = await run(
      event({ routeKey: 'POST /v1/notifications/read', body: { id: '2026-03-03T10:00:00.000Z#a' } }),
    );
    expect(r.statusCode).toBe(200);
    expect(repo.markRead).toHaveBeenCalledWith('u1', '2026-03-03T10:00:00.000Z', 'a');
  });

  it('marks everything read', async () => {
    vi.mocked(repo.markAllRead).mockResolvedValue(4);
    const r = await run(event({ routeKey: 'POST /v1/notifications/read', body: { all: true } }));
    expect(JSON.parse(r.body).marked).toBe(4);
  });

  it('400s when neither id nor all is given', async () => {
    const r = await run(event({ routeKey: 'POST /v1/notifications/read', body: {} }));
    expect(r.statusCode).toBe(400);
  });

  it('400s on a malformed id', async () => {
    const r = await run(event({ routeKey: 'POST /v1/notifications/read', body: { id: 'nope' } }));
    expect(r.statusCode).toBe(400);
  });
});
