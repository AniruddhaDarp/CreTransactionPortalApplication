import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { decide, initiate } from './handshake.js';
import type { DealMeta, Handshake, Membership } from './repo.js';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.DEALS_TABLE = 'deals-test';
beforeEach(() => ddb.reset());

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

const authz = (over: Record<string, unknown> = {}) => ({
  role: 'SELLER_AGENT' as const,
  side: 'sell' as const,
  isAdmin: true,
  isFirm: false,
  currentStage: 1,
  status: 'active' as const,
  ...over,
});

const member = (over: Partial<Membership>): Membership => ({
  dealId: 'd1',
  userId: 'x',
  role: 'BUYER',
  side: 'buy',
  status: 'active',
  isAdmin: false,
  joinedAt: 't',
  ...over,
});

describe('handshake.initiate', () => {
  it('advance_stage by the admin: pending HS + approver pointers for the buy-side leads', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        member({ userId: 'buyer', role: 'BUYER' }),
        member({ userId: 'bagent', role: 'BUYER_AGENT' }),
        member({ userId: 'lender', role: 'LENDER' }),
      ],
    });
    ddb.on(TransactWriteCommand).resolves({});
    const { hs, event } = await initiate({
      deal: deal(),
      authz: authz(),
      action: 'advance_stage',
      payload: {},
      actorId: 'admin',
    });
    expect(hs.status).toBe('pending');
    expect(event.type).toBe('handshake.requested');
    expect((event.detail.approverIds as string[]).sort()).toEqual(['bagent', 'buyer']);
    // HS item + 2 approver pointers
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(3);
  });

  it('409s an advance with no buy-side lead present', async () => {
    ddb.on(QueryCommand).resolves({ Items: [member({ userId: 'seller', role: 'SELLER', side: 'sell' })] });
    await expect(
      initiate({ deal: deal(), authz: authz(), action: 'advance_stage', payload: {}, actorId: 'admin' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('403s an initiator who lacks the capability', async () => {
    await expect(
      initiate({
        deal: deal(),
        authz: authz({ role: 'BUYER_ATTORNEY', side: 'buy', isAdmin: false }),
        action: 'advance_stage',
        payload: {},
        actorId: 'x',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('409s an advance past the final stage', async () => {
    await expect(
      initiate({
        deal: deal({ currentStage: 6 }),
        authz: authz({ currentStage: 6 }),
        action: 'advance_stage',
        payload: {},
        actorId: 'admin',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

const hs = (over: Partial<Handshake> = {}): Handshake => ({
  dealId: 'd1',
  hsId: 'h1',
  action: 'advance_stage',
  payload: {},
  initiatedBy: 'admin',
  initiatedSide: 'sell',
  status: 'pending',
  createdAt: 't',
  ...over,
});

describe('handshake.decide', () => {
  it('approve by a buy-side lead advances the stage and emits stage.advanced', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'buyer' }, { userId: 'bagent' }] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal({ currentStage: 2 }),
      hs: hs(),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      actorId: 'buyer',
      decision: 'approve',
    });
    expect(events.map((e) => e.type)).toEqual(['handshake.approved', 'stage.advanced']);
    expect(events[1]!.detail).toMatchObject({ from: 2, to: 3, firmNow: true });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    // HS decide + 3 effects (stage from, stage to, meta) + 2 APPR deletes
    expect(items).toHaveLength(6);
  });

  it('403s an approve from someone who is not a counterparty lead', async () => {
    await expect(
      decide({
        deal: deal(),
        hs: hs(),
        authz: authz({ role: 'BUYER_ATTORNEY', side: 'buy', isAdmin: false }),
        actorId: 'x',
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets the initiator withdraw (reject) their own handshake', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'buyer' }] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal(),
      hs: hs(),
      authz: authz(), // the admin/initiator
      actorId: 'admin',
      decision: 'reject',
      reason: 'not yet',
    });
    expect(events[0]!.type).toBe('handshake.rejected');
  });

  it('409s a decision on an already-decided handshake', async () => {
    await expect(
      decide({
        deal: deal(),
        hs: hs({ status: 'completed' }),
        authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
        actorId: 'buyer',
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
