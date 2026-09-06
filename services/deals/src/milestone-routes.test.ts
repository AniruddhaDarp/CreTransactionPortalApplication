import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './deals.js';
import type { DealMeta, Membership } from './repo.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.mock('./repo.js');
vi.mock('./handshake.js');
import * as handshake from './handshake.js';
import * as repo from './repo.js';

const eb = mockClient(EventBridgeClient);
process.env.EVENT_BUS_NAME = 'cre-portal-bus';

beforeEach(() => {
  vi.clearAllMocks();
  eb.reset();
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
});

const deal = (over: Partial<DealMeta> = {}): DealMeta => ({
  dealId: 'd1',
  address: '1 Market St',
  propertyType: 'office',
  price: 1_000_000,
  status: 'ACTIVE',
  currentStage: 1,
  firm: false,
  createdBy: 'admin',
  createdAt: 't',
  updatedAt: 't',
  ...over,
});
const member = (over: Partial<Membership> = {}): Membership => ({
  dealId: 'd1',
  userId: 'admin',
  role: 'SELLER_AGENT',
  side: 'sell',
  status: 'active',
  isAdmin: true,
  joinedAt: 't',
  ...over,
});

function event(over: { routeKey: string; path?: Record<string, string>; body?: unknown; sub?: string }) {
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
      authorizer: { jwt: { claims: { sub: over.sub ?? 'admin', email: 'a@x.com' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };
const detailTypes = () =>
  eb.commandCalls(PutEventsCommand).flatMap((c) => c.args[0].input.Entries!.map((x) => x.DetailType));

describe('GET /v1/deals/{dealId}/stages', () => {
  it('returns the 6-stage pipeline', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.listStages).mockResolvedValue([]);
    const res = await run(event({ routeKey: 'GET /v1/deals/{dealId}/stages', path: { dealId: 'd1' } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).currentStage).toBe(1);
  });
});

describe('POST /v1/deals/{dealId}/advance', () => {
  it('202s with a pending handshake id', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(handshake.initiate).mockResolvedValue({
      hs: { hsId: 'h9', action: 'advance_stage' } as never,
      event: { type: 'handshake.requested', detail: {} },
    });
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/advance', path: { dealId: 'd1' } }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ handshakeId: 'h9', status: 'pending' });
    expect(detailTypes()).toContain('handshake.requested');
  });
});

describe('checklist', () => {
  it('403s an OTHER member adding an item', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(
      member({ userId: 'insp', role: 'OTHER', side: 'buy', isAdmin: false }),
    );
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/stages/{n}/checklist',
        path: { dealId: 'd1', n: '3' },
        sub: 'insp',
        body: { title: 'Extra check' },
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('toggling done publishes checklist.item_toggled and stamps doneBy', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.updateChecklistItem).mockResolvedValue({ itemId: 't0', done: true } as never);
    const res = await run(
      event({
        routeKey: 'PATCH /v1/deals/{dealId}/stages/{n}/checklist/{itemId}',
        path: { dealId: 'd1', n: '3', itemId: 't0' },
        body: { done: true },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(detailTypes()).toContain('checklist.item_toggled');
    const patch = vi.mocked(repo.updateChecklistItem).mock.calls[0]![3] as Record<string, unknown>;
    expect(patch.doneBy).toBe('admin');
  });
});

describe('PATCH /v1/deals/{dealId}/stages/{n}', () => {
  it('400s a target-date change once the deal is firm', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal({ firm: true, currentStage: 4 }));
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(
      event({
        routeKey: 'PATCH /v1/deals/{dealId}/stages/{n}',
        path: { dealId: 'd1', n: '5' },
        body: { targetDate: '2026-12-01' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/deals/{dealId}/status when firm', () => {
  it('opens a close_deal handshake instead of closing directly', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal({ firm: true, currentStage: 4 }));
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(handshake.initiate).mockResolvedValue({
      hs: { hsId: 'h5', action: 'close_deal' } as never,
      event: { type: 'handshake.requested', detail: {} },
    });
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/status',
        path: { dealId: 'd1' },
        body: { status: 'CLOSED' },
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).action).toBe('close_deal');
  });
});
