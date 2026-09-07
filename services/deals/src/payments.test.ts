import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './deals.js';
import type { DealMeta, Membership, Payment } from './repo.js';

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
  vi.mocked(handshake.initiate).mockResolvedValue({
    hs: { hsId: 'h1', action: 'confirm_payment' } as never,
    event: { type: 'handshake.requested', detail: {} },
  });
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
const payment = (over: Partial<Payment> = {}): Payment => ({
  dealId: 'd1',
  payId: 'p1',
  kind: 'earnest_money',
  amount: 50_000,
  method: 'wire',
  payer: 'buyer',
  payee: 'escrow',
  paidOn: '2026-09-01',
  status: 'recorded',
  recordedBy: 'admin',
  recordedAt: 't',
  confirmHsId: 'h0',
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

const REC = 'POST /v1/deals/{dealId}/payments';

describe('POST /v1/deals/{dealId}/payments', () => {
  const body = { kind: 'earnest_money', amount: 50_000, method: 'wire', paidOn: '2026-09-01' };

  it('records the payment, opens a confirm handshake, and emits payment.recorded', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(event({ routeKey: REC, path: { dealId: 'd1' }, body }));
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(repo.putPayment)).toHaveBeenCalledOnce();
    const stored = vi.mocked(repo.putPayment).mock.calls[0]![0];
    expect(stored).toMatchObject({ status: 'recorded', payer: 'buyer', payee: 'escrow', recordedBy: 'admin' });
    expect(vi.mocked(handshake.initiate).mock.calls[0]![0]).toMatchObject({ action: 'confirm_payment' });
    expect(vi.mocked(repo.setPaymentHs)).toHaveBeenCalledWith('d1', stored.payId, 'confirmHsId', 'h1');
    expect(detailTypes()).toEqual(expect.arrayContaining(['payment.recorded', 'handshake.requested']));
  });

  it('403s a non-lead (plain seller)', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(
      member({ userId: 'seller', role: 'SELLER', isAdmin: false }),
    );
    const res = await run(event({ routeKey: REC, path: { dealId: 'd1' }, sub: 'seller', body }));
    expect(res.statusCode).toBe(403);
    expect(vi.mocked(repo.putPayment)).not.toHaveBeenCalled();
  });

  it('409s when the deal is not ACTIVE', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal({ status: 'CLOSED' }));
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(event({ routeKey: REC, path: { dealId: 'd1' }, body }));
    expect(res.statusCode).toBe(409);
  });

  it('400s a non-positive amount', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    const res = await run(
      event({ routeKey: REC, path: { dealId: 'd1' }, body: { ...body, amount: 0 } }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/deals/{dealId}/payments/{payId}/confirm', () => {
  const rk = 'POST /v1/deals/{dealId}/payments/{payId}/confirm';

  it('re-opens the confirm handshake for a still-recorded payment', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(payment({ confirmHsId: undefined }));
    const res = await run(event({ routeKey: rk, path: { dealId: 'd1', payId: 'p1' } }));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).action).toBe('confirm_payment');
  });

  it('409s when a confirmation handshake is already pending', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(payment({ confirmHsId: 'hPending' }));
    vi.mocked(repo.getHandshake).mockResolvedValue({ status: 'pending' } as never);
    const res = await run(event({ routeKey: rk, path: { dealId: 'd1', payId: 'p1' } }));
    expect(res.statusCode).toBe(409);
  });

  it('409s a payment that is already confirmed', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(payment({ status: 'confirmed' }));
    const res = await run(event({ routeKey: rk, path: { dealId: 'd1', payId: 'p1' } }));
    expect(res.statusCode).toBe(409);
  });

  it('404s an unknown payment', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(undefined);
    const res = await run(event({ routeKey: rk, path: { dealId: 'd1', payId: 'zzz' } }));
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/deals/{dealId}/payments/{payId}/void', () => {
  const rk = 'POST /v1/deals/{dealId}/payments/{payId}/void';

  it('opens a void_payment handshake for a confirmed payment', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(payment({ status: 'confirmed' }));
    vi.mocked(handshake.initiate).mockResolvedValue({
      hs: { hsId: 'hv', action: 'void_payment' } as never,
      event: { type: 'handshake.requested', detail: {} },
    });
    const res = await run(
      event({ routeKey: rk, path: { dealId: 'd1', payId: 'p1' }, body: { reason: 'dup entry' } }),
    );
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).action).toBe('void_payment');
    expect(vi.mocked(handshake.initiate).mock.calls[0]![0]).toMatchObject({
      action: 'void_payment',
      payload: { payId: 'p1', reason: 'dup entry' },
    });
    expect(vi.mocked(repo.setPaymentHs)).toHaveBeenCalledWith('d1', 'p1', 'voidHsId', 'hv');
  });

  it('409s a payment that is already void', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.getMembership).mockResolvedValue(member());
    vi.mocked(repo.getPayment).mockResolvedValue(payment({ status: 'void' }));
    const res = await run(event({ routeKey: rk, path: { dealId: 'd1', payId: 'p1' } }));
    expect(res.statusCode).toBe(409);
  });
});
