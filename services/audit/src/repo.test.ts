import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { putEvent, queryDeal, rowCursor, scanDeal, type AuditRow } from './repo.js';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.AUDIT_TABLE = 'audit-test';

beforeEach(() => ddb.reset());

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  dealId: 'd1',
  eventId: 'e1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  detailType: 'deal.created',
  action: 'deal.created',
  targetType: 'deal',
  scope: 'deal_wide',
  summary: 'Deal created',
  correlationId: 'c1',
  ...over,
});

describe('putEvent', () => {
  it('writes with a deterministic SK and a not-exists guard', async () => {
    ddb.on(PutCommand).resolves({});
    await putEvent(row());
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect((input.Item as Record<string, string>).SK).toBe('AUDIT#2026-01-01T00:00:00.000Z#e1');
    expect(input.ConditionExpression).toBe('attribute_not_exists(SK)');
  });

  it('swallows a redelivered event (ConditionalCheckFailed)', async () => {
    ddb.on(PutCommand).rejects(
      Object.assign(new Error('dup'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(putEvent(row())).resolves.toBeUndefined();
  });

  it('rethrows any other error', async () => {
    ddb.on(PutCommand).rejects(new Error('throttled'));
    await expect(putEvent(row())).rejects.toThrow('throttled');
  });
});

describe('queryDeal', () => {
  it('scans newest-first and bounds an explicit time range', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    await queryDeal('d1', { from: '2026-01-01', to: '2026-02-01' });
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.KeyConditionExpression).toContain('BETWEEN');
    const v = input.ExpressionAttributeValues as Record<string, string>;
    expect(v[':lo']).toBe('AUDIT#2026-01-01');
    expect(v[':hi']!.startsWith('AUDIT#2026-02-01')).toBe(true);
  });

  it('round-trips an opaque cursor', async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: 'DEAL#d1', SK: 'AUDIT#x' } });
    const page = await queryDeal('d1', {});
    expect(page.nextCursor).toBeTruthy();
    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await queryDeal('d1', { cursor: page.nextCursor });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExclusiveStartKey).toEqual({
      PK: 'DEAL#d1',
      SK: 'AUDIT#x',
    });
  });
});

describe('rowCursor', () => {
  it('encodes a resume-after key derived purely from the row, usable as ExclusiveStartKey', async () => {
    const c = rowCursor(row({ occurredAt: '2026-05-05T12:00:00.000Z', eventId: 'evt-9' }));
    expect(typeof c).toBe('string');
    ddb.on(QueryCommand).resolves({ Items: [] });
    await queryDeal('d1', { cursor: c });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExclusiveStartKey).toEqual({
      PK: 'DEAL#d1',
      SK: 'AUDIT#2026-05-05T12:00:00.000Z#evt-9',
    });
  });
});

describe('scanDeal', () => {
  it('follows cursors and stops at the hard cap', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ ...row(), PK: 'DEAL#d1', SK: 'AUDIT#a' }], LastEvaluatedKey: { x: 1 } })
      .resolvesOnce({ Items: [{ ...row({ eventId: 'e2' }), PK: 'DEAL#d1', SK: 'AUDIT#b' }] });
    const rows = await scanDeal('d1', 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty('PK');
  });
});
