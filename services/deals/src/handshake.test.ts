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
    const { hs, events } = await initiate({
      deal: deal(),
      authz: authz(),
      action: 'advance_stage',
      payload: {},
      actorId: 'admin',
    });
    const event = events[0]!;
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

  it('side-private delete_document is approved by the other lead on the initiating side', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        member({ userId: 'buyer', role: 'BUYER', side: 'buy' }),
        member({ userId: 'bagent', role: 'BUYER_AGENT', side: 'buy' }),
        member({ userId: 'sagent', role: 'SELLER_AGENT', side: 'sell' }),
      ],
    });
    ddb.on(TransactWriteCommand).resolves({});
    const { hs, events } = await initiate({
      deal: deal(),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      action: 'delete_document',
      payload: { docId: 'doc1', scope: 'side_private:buy' },
      actorId: 'buyer',
    });
    expect(hs.status).toBe('pending');
    const requested = events.find((e) => e.type === 'handshake.requested')!;
    expect(requested.detail.approverIds).toEqual(['bagent']);
  });

  it('side-private delete_document with no other same-side lead self-approves', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        member({ userId: 'buyer', role: 'BUYER', side: 'buy' }),
        member({ userId: 'sagent', role: 'SELLER_AGENT', side: 'sell' }),
      ],
    });
    ddb.on(TransactWriteCommand).resolves({});
    const { hs, events } = await initiate({
      deal: deal(),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      action: 'delete_document',
      payload: { docId: 'doc1', scope: 'side_private:buy' },
      actorId: 'buyer',
    });
    expect(hs.status).toBe('approved');
    expect(hs.sagaState).toBe('awaiting_document');
    expect(events.map((e) => e.type)).toEqual(['handshake.requested', 'handshake.approved']);
  });

  it('deal-wide delete_document of a category the sell side cannot see stays same-side', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        member({ userId: 'buyer', role: 'BUYER', side: 'buy' }),
        member({ userId: 'bagent', role: 'BUYER_AGENT', side: 'buy' }),
        member({ userId: 'sagent', role: 'SELLER_AGENT', side: 'sell' }),
      ],
    });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await initiate({
      deal: deal(),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      action: 'delete_document',
      payload: { docId: 'doc1', scope: 'deal_wide', category: 'Financing' },
      actorId: 'buyer',
    });
    const requested = events.find((e) => e.type === 'handshake.requested')!;
    expect(requested.detail.approverIds).toEqual(['bagent']); // buy-side co-lead, not the seller
  });

  it('deal-wide delete_document still needs a counterparty lead', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        member({ userId: 'buyer', role: 'BUYER', side: 'buy' }),
        member({ userId: 'sagent', role: 'SELLER_AGENT', side: 'sell' }),
        member({ userId: 'seller', role: 'SELLER', side: 'sell' }),
      ],
    });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await initiate({
      deal: deal(),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      action: 'delete_document',
      payload: { docId: 'doc1', scope: 'deal_wide' },
      actorId: 'buyer',
    });
    const requested = events.find((e) => e.type === 'handshake.requested')!;
    expect((requested.detail.approverIds as string[]).sort()).toEqual(['sagent', 'seller']);
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

  it('a same-side co-lead may approve a side-private delete_document', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal(),
      hs: hs({
        action: 'delete_document',
        initiatedBy: 'buyer',
        initiatedSide: 'buy',
        payload: { docId: 'doc1', scope: 'side_private:buy' },
      }),
      authz: authz({ role: 'BUYER_AGENT', side: 'buy', isAdmin: false }),
      actorId: 'bagent',
      decision: 'approve',
    });
    expect(events.map((e) => e.type)).toContain('handshake.approved');
  });

  it('the counterparty cannot approve a side-private delete_document', async () => {
    await expect(
      decide({
        deal: deal(),
        hs: hs({
          action: 'delete_document',
          initiatedBy: 'buyer',
          initiatedSide: 'buy',
          payload: { docId: 'doc1', scope: 'side_private:buy' },
        }),
        authz: authz({ role: 'SELLER_AGENT', side: 'sell', isAdmin: true }),
        actorId: 'sagent',
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

  it('approving a confirm_payment flips the PAY# row (guarded on recorded) and emits payment.confirmed', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'buyer' }] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal(),
      hs: hs({ action: 'confirm_payment', payload: { payId: 'p1', kind: 'earnest_money', amount: 50000 } }),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      actorId: 'buyer',
      decision: 'approve',
    });
    expect(events.map((e) => e.type)).toEqual(['handshake.approved', 'payment.confirmed']);
    expect(events[1]!.detail).toMatchObject({ payId: 'p1', confirmedBy: 'buyer', amount: 50000 });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const upd = items.find((i) => i.Update?.Key?.SK === 'PAY#p1')!.Update!;
    expect(upd.ConditionExpression).toContain(':recorded');
    expect(upd.ExpressionAttributeValues![':confirmed']).toBe('confirmed');
  });

  it('approving a void_payment marks the row void with the reason and blocks a double-void', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'buyer' }] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal(),
      hs: hs({ action: 'void_payment', payload: { payId: 'p2', reason: 'entered twice' } }),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      actorId: 'buyer',
      decision: 'approve',
    });
    expect(events.map((e) => e.type)).toEqual(['handshake.approved', 'payment.voided']);
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const upd = items.find((i) => i.Update?.Key?.SK === 'PAY#p2')!.Update!;
    expect(upd.ConditionExpression).toContain('<> :voidcmp');
    expect(upd.ExpressionAttributeValues![':reason']).toBe('entered twice');
  });

  it('approving a close_deal marks the deal CLOSED and completes the final milestone', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ userId: 'buyer' }] });
    ddb.on(TransactWriteCommand).resolves({});
    const { events } = await decide({
      deal: deal({ currentStage: 6, firm: true }),
      hs: hs({ action: 'close_deal', payload: { reason: 'funded' } }),
      authz: authz({ role: 'BUYER', side: 'buy', isAdmin: false }),
      actorId: 'buyer',
      decision: 'approve',
    });
    expect(events.map((e) => e.type)).toEqual(['handshake.approved', 'deal.status_changed']);
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const dealUpd = items.find((i) => i.Update?.Key?.SK === 'META')!.Update!;
    expect(dealUpd.ExpressionAttributeValues![':s']).toBe('CLOSED');
    const stageUpd = items.find((i) => i.Update?.Key?.SK === 'STAGE#6')!.Update!;
    expect(stageUpd.ExpressionAttributeValues![':done']).toBe('completed');
  });

  it('pre-flights a confirm_payment with a missing payId at initiate time (400)', async () => {
    await expect(
      initiate({
        deal: deal(),
        authz: authz(),
        action: 'confirm_payment',
        payload: {},
        actorId: 'admin',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
