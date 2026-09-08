import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvite,
  createDeal,
  getDeal,
  listBuySideRoster,
  listMyDeals,
  listPayments,
  listPendingInvitesForEmail,
  putPayment,
} from './repo.js';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.DEALS_TABLE = 'deals-test';
beforeEach(() => ddb.reset());

describe('deals repo', () => {
  it('createDeal writes META + the creator MEMBER row with GSI1 keys, atomically', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const { deal, membership } = await createDeal({
      dealId: 'd1',
      address: '1 Market St',
      propertyType: 'office',
      price: 1_000_000,
      createdBy: 'u1',
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(8); // META + creator MEMBER + 6 STAGE rows
    expect((items[0]!.Put!.Item as Record<string, unknown>).SK).toBe('META');
    expect(items[0]!.Put!.ConditionExpression).toContain('attribute_not_exists');
    const member = items[1]!.Put!.Item as Record<string, unknown>;
    expect(member.SK).toBe('MEMBER#u1');
    expect(member.GSI1PK).toBe('USER#u1');
    expect(member.GSI1SK).toBe('DEAL#d1');
    const stageSks = items.slice(2).map((it) => (it.Put!.Item as Record<string, unknown>).SK);
    expect(stageSks).toEqual(['STAGE#1', 'STAGE#2', 'STAGE#3', 'STAGE#4', 'STAGE#5', 'STAGE#6']);
    expect((items[2]!.Put!.Item as Record<string, unknown>).status).toBe('in_progress');
    expect((items[3]!.Put!.Item as Record<string, unknown>).status).toBe('not_started');
    expect(deal.status).toBe('ACTIVE');
    expect(deal.currentStage).toBe(1);
    expect(membership.isAdmin).toBe(true);
  });

  it('getDeal strips DynamoDB key attributes', async () => {
    ddb.on(GetCommand).resolves({
      Item: { PK: 'DEAL#d1', SK: 'META', dealId: 'd1', address: '1 Market St', status: 'ACTIVE' },
    });
    const deal = await getDeal('d1');
    expect(deal).not.toHaveProperty('PK');
    expect(deal).toMatchObject({ dealId: 'd1', address: '1 Market St' });
  });

  it('listMyDeals queries GSI1 then batch-gets the deal metas', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { dealId: 'd1', userId: 'u1', role: 'BUYER', side: 'buy', status: 'active' },
        { dealId: 'd2', userId: 'u1', role: 'SELLER_AGENT', side: 'sell', status: 'removed' },
      ],
    });
    ddb.on(BatchGetCommand).resolves({
      Responses: { 'deals-test': [{ dealId: 'd1', address: '1 Market St', status: 'ACTIVE' }] },
    });
    const deals = await listMyDeals('u1');
    expect(deals).toHaveLength(1); // d2 filtered out (removed)
    expect(deals[0]).toMatchObject({ dealId: 'd1', myRole: 'BUYER' });
  });

  it('acceptInvite creates the member and flips the invite in one transaction', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const m = await acceptInvite({
      dealId: 'd1',
      token: 't1',
      userId: 'u2',
      role: 'BUYER_AGENT',
      side: 'buy',
      invitedBy: 'u1',
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]!.Put!.ConditionExpression).toContain('attribute_not_exists');
    expect(items[1]!.Update!.ConditionExpression).toContain(':pending');
    expect(m).toMatchObject({ userId: 'u2', role: 'BUYER_AGENT', status: 'active', isAdmin: false });
  });

  it('listBuySideRoster merges active buy-side members and pending buy-side invites', async () => {
    ddb.on(QueryCommand).callsFake((input) => {
      const sk = input.ExpressionAttributeValues![':sk'];
      if (sk === 'MEMBER#') {
        return {
          Items: [
            { dealId: 'd1', userId: 'u1', role: 'BUYER', side: 'buy', status: 'active' },
            { dealId: 'd1', userId: 'u9', role: 'SELLER', side: 'sell', status: 'active' },
          ],
        };
      }
      return {
        Items: [
          { dealId: 'd1', token: 't1', role: 'BUYER_AGENT', side: 'buy', status: 'pending' },
          { dealId: 'd1', token: 't2', role: 'BUYER_AGENT', side: 'buy', status: 'revoked' },
        ],
      };
    });
    const roster = await listBuySideRoster('d1');
    expect(roster).toEqual([
      { role: 'BUYER', status: 'active' },
      { role: 'BUYER_AGENT', status: 'invited' },
    ]);
  });

  it('listPendingInvitesForEmail queries GSI2 by lowercased email and keeps only pending', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { dealId: 'd1', token: 't1', email: 'me@x.com', role: 'BUYER', status: 'pending' },
        { dealId: 'd2', token: 't2', email: 'me@x.com', role: 'LENDER', status: 'accepted' },
      ],
    });
    const rows = await listPendingInvitesForEmail('ME@X.com');
    const call = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(call.IndexName).toBe('gsi2');
    expect(call.ExpressionAttributeValues![':pk']).toBe('EMAIL#me@x.com');
    expect(rows.map((r) => r.token)).toEqual(['t1']);
  });

  it('putPayment writes a PAY# item guarded against overwrite', async () => {
    ddb.on(PutCommand).resolves({});
    await putPayment({
      dealId: 'd1',
      payId: 'p1',
      kind: 'earnest_money',
      amount: 50_000,
      method: 'wire',
      payer: 'buyer',
      payee: 'escrow',
      paidOn: '2026-09-01',
      appliesToPrice: true,
      status: 'recorded',
      recordedBy: 'u1',
      recordedAt: 't',
    });
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect((put.Item as Record<string, unknown>).SK).toBe('PAY#p1');
    expect(put.ConditionExpression).toContain('attribute_not_exists');
  });

  it('listPayments strips keys and sorts by recordedAt', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { PK: 'DEAL#d1', SK: 'PAY#b', payId: 'b', recordedAt: '2026-02-01', status: 'recorded' },
        { PK: 'DEAL#d1', SK: 'PAY#a', payId: 'a', recordedAt: '2026-01-01', status: 'confirmed' },
      ],
    });
    const rows = await listPayments('d1');
    expect(rows.map((r) => r.payId)).toEqual(['a', 'b']);
    expect(rows[0]).not.toHaveProperty('PK');
  });
});
