import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './deals.js';
import type { DealMeta, Invite, Membership } from './repo.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.mock('./repo.js');
import * as repo from './repo.js';

const eb = mockClient(EventBridgeClient);
process.env.EVENT_BUS_NAME = 'cre-portal-bus';
process.env.WEB_ORIGIN = 'https://spa.example.com';

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

function event(over: {
  routeKey: string;
  path?: Record<string, string>;
  body?: unknown;
  sub?: string;
  email?: string;
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
      authorizer: { jwt: { claims: { sub: over.sub ?? 'admin', email: over.email ?? 'admin@x.com' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };
const body = (r: { body: string }) => JSON.parse(r.body);
const detailTypes = () =>
  eb.commandCalls(PutEventsCommand).flatMap((c) => c.args[0].input.Entries!.map((x) => x.DetailType));

describe('POST /v1/deals', () => {
  it('creates a deal and publishes deal.created + member.joined', async () => {
    vi.mocked(repo.createDeal).mockResolvedValue({ deal: deal(), membership: member() });
    const res = await run(
      event({ routeKey: 'POST /v1/deals', body: { address: '1 Market St', propertyType: 'office', price: 1000000 } }),
    );
    expect(res.statusCode).toBe(201);
    expect(detailTypes()).toEqual(expect.arrayContaining(['deal.created', 'member.joined']));
  });

  it('rejects an invalid property type', async () => {
    const res = await run(
      event({ routeKey: 'POST /v1/deals', body: { address: '1 Market St', propertyType: 'castle', price: 1 } }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/deals/{dealId}', () => {
  it('403s a non-member', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(undefined);
    expect((await run(event({ routeKey: 'GET /v1/deals/{dealId}', path: { dealId: 'd1' }, sub: 'stranger' }))).statusCode).toBe(403);
  });

  it('returns the deal with a capabilities map for a member', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(event({ routeKey: 'GET /v1/deals/{dealId}', path: { dealId: 'd1' } }));
    expect(res.statusCode).toBe(200);
    expect(body(res).capabilities.editDealFields).toBe(true);
  });
});

describe('PATCH /v1/deals/{dealId}', () => {
  it('403s a member who is not a sell-side lead', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(
      member({ userId: 'u2', role: 'SELLER_ATTORNEY', isAdmin: false }),
    );
    const res = await run(
      event({ routeKey: 'PATCH /v1/deals/{dealId}', path: { dealId: 'd1' }, sub: 'u2', body: { label: 'x' } }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('lets a sell-side lead (incl. a plain SELLER) edit and publishes deal.updated', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(
      member({ userId: 'u3', role: 'SELLER', isAdmin: false }),
    );
    vi.mocked(repo.updateDealFields).mockResolvedValue(deal({ label: 'Seller-set' }));
    const res = await run(
      event({ routeKey: 'PATCH /v1/deals/{dealId}', path: { dealId: 'd1' }, sub: 'u3', body: { label: 'Seller-set' } }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('lets the admin edit and publishes deal.updated', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.updateDealFields).mockResolvedValue(deal({ label: 'Downtown' }));
    const res = await run(
      event({ routeKey: 'PATCH /v1/deals/{dealId}', path: { dealId: 'd1' }, body: { label: 'Downtown' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(detailTypes()).toContain('deal.updated');
  });
});

describe('POST /v1/deals/{dealId}/invites', () => {
  it('403s a buyer trying to invite a sell-side member', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member({ userId: 'b', role: 'BUYER', side: 'buy', isAdmin: false }));
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites',
        path: { dealId: 'd1' },
        sub: 'b',
        body: { email: 'x@y.com', role: 'SELLER_ATTORNEY' },
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('409s when the buy-side agent cap is reached', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member({ userId: 'b', role: 'BUYER', side: 'buy', isAdmin: false }));
    vi.mocked(repo.listBuySideRoster).mockResolvedValue([
      { role: 'BUYER_AGENT', status: 'active' },
      { role: 'BUYER_AGENT', status: 'active' },
    ]);
    vi.mocked(repo.listInvites).mockResolvedValue([]);
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites',
        path: { dealId: 'd1' },
        sub: 'b',
        body: { email: 'x@y.com', role: 'BUYER_AGENT' },
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it('admin invites a buyer: 201, writes the invite, publishes member.invited, returns an acceptUrl', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.listInvites).mockResolvedValue([]);
    vi.mocked(repo.putInvite).mockResolvedValue();
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites',
        path: { dealId: 'd1' },
        body: { email: 'Buyer@Example.com', role: 'BUYER' },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(body(res).acceptUrl).toMatch(/^https:\/\/spa\.example\.com\/accept\/d1\//);
    expect(body(res).email).toBe('buyer@example.com');
    expect(detailTypes()).toContain('member.invited');
  });
});

describe('POST /v1/deals/{dealId}/invites/{token}/accept', () => {
  const invite = (over: Partial<Invite> = {}): Invite => ({
    dealId: 'd1',
    token: 't1',
    email: 'buyer@example.com',
    role: 'BUYER',
    side: 'buy',
    invitedBy: 'admin',
    status: 'pending',
    createdAt: 't',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  });

  it('403s when the caller’s email does not match the invite', async () => {
    vi.mocked(repo.getInvite).mockResolvedValue(invite());
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/accept',
        path: { dealId: 'd1', token: 't1' },
        sub: 'someone',
        email: 'other@example.com',
      }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('joins the deal and publishes member.joined on a matching email', async () => {
    vi.mocked(repo.getInvite).mockResolvedValue(invite());
    vi.mocked(repo.getMembership).mockResolvedValue(undefined);
    vi.mocked(repo.acceptInvite).mockResolvedValue(member({ userId: 'buyer', role: 'BUYER', side: 'buy', isAdmin: false }));
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/accept',
        path: { dealId: 'd1', token: 't1' },
        sub: 'buyer',
        email: 'buyer@example.com',
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(detailTypes()).toContain('member.joined');
  });

  it('410s an expired invitation', async () => {
    vi.mocked(repo.getInvite).mockResolvedValue(
      invite({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    vi.mocked(repo.getMembership).mockResolvedValue(undefined);
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/accept',
        path: { dealId: 'd1', token: 't1' },
        sub: 'buyer',
        email: 'buyer@example.com',
      }),
    );
    expect(res.statusCode).toBe(410);
  });

  it('decline: 403 on a mismatched email, 200 + member.invite_declined on a match', async () => {
    vi.mocked(repo.getInvite).mockResolvedValue(invite());
    const wrong = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/decline',
        path: { dealId: 'd1', token: 't1' },
        sub: 'x',
        email: 'other@example.com',
      }),
    );
    expect(wrong.statusCode).toBe(403);

    vi.mocked(repo.revokeInvite).mockResolvedValue();
    const ok = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/decline',
        path: { dealId: 'd1', token: 't1' },
        sub: 'buyer',
        email: 'buyer@example.com',
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect(body(ok).status).toBe('declined');
    expect(detailTypes()).toContain('member.invite_declined');
  });

  it('decline: 409 when the invitation is not pending', async () => {
    vi.mocked(repo.getInvite).mockResolvedValue(invite({ status: 'accepted' }));
    const res = await run(
      event({
        routeKey: 'POST /v1/deals/{dealId}/invites/{token}/decline',
        path: { dealId: 'd1', token: 't1' },
        sub: 'buyer',
        email: 'buyer@example.com',
      }),
    );
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /v1/deals', () => {
  it('returns the caller’s deals plus their pending invitations (by email, expired dropped)', async () => {
    vi.mocked(repo.listMyDeals).mockResolvedValue([{ ...deal(), myRole: 'BUYER' } as never]);
    vi.mocked(repo.listPendingInvitesForEmail).mockResolvedValue([
      {
        dealId: 'd9',
        token: 'tok9',
        email: 'me@x.com',
        role: 'BUYER_ATTORNEY',
        side: 'buy',
        invitedBy: 'admin',
        status: 'pending',
        createdAt: 't',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      {
        dealId: 'dExpired',
        token: 'tokX',
        email: 'me@x.com',
        role: 'BUYER',
        side: 'buy',
        invitedBy: 'admin',
        status: 'pending',
        createdAt: 't',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    vi.mocked(repo.getDeal).mockResolvedValue(deal({ dealId: 'd9', address: '9 Elm' }));
    const res = await run(event({ routeKey: 'GET /v1/deals', sub: 'me', email: 'me@x.com' }));
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.deals).toHaveLength(1);
    expect(b.pendingInvites).toEqual([
      expect.objectContaining({ dealId: 'd9', token: 'tok9', role: 'BUYER_ATTORNEY', dealAddress: '9 Elm' }),
    ]);
  });
});

describe('DELETE /v1/deals/{dealId}/members/{userId}', () => {
  it('409s an attempt to remove the deal creator', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(
      event({
        routeKey: 'DELETE /v1/deals/{dealId}/members/{userId}',
        path: { dealId: 'd1', userId: 'admin' },
      }),
    );
    expect(res.statusCode).toBe(409);
  });
});
