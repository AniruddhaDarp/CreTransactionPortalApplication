import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptInvite, createDeal, getDeal, listBuySideRoster, listMyDeals } from './repo.js';

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
    expect(items).toHaveLength(2);
    expect((items[0]!.Put!.Item as Record<string, unknown>).SK).toBe('META');
    expect(items[0]!.Put!.ConditionExpression).toContain('attribute_not_exists');
    const member = items[1]!.Put!.Item as Record<string, unknown>;
    expect(member.SK).toBe('MEMBER#u1');
    expect(member.GSI1PK).toBe('USER#u1');
    expect(member.GSI1SK).toBe('DEAL#d1');
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
});
