import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { listForUser, markAllRead, putNotification, type NotificationRow } from './repo.js';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.NOTIFICATIONS_TABLE = 'notif-test';
beforeEach(() => ddb.reset());

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  userId: 'u1',
  notifId: 'e1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  type: 'mention',
  title: 'You were mentioned',
  sourceEventId: 'e1',
  ...over,
});

describe('putNotification', () => {
  it('uses a deterministic per-user SK and guards against redelivery', async () => {
    ddb.on(PutCommand).resolves({});
    await putNotification(row());
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect((input.Item as Record<string, string>).PK).toBe('USER#u1');
    expect((input.Item as Record<string, string>).SK).toBe('NOTIF#2026-01-01T00:00:00.000Z#e1');
    expect(input.ConditionExpression).toBe('attribute_not_exists(SK)');
  });

  it('swallows a duplicate delivery', async () => {
    ddb.on(PutCommand).rejects(
      Object.assign(new Error('dup'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(putNotification(row())).resolves.toBeUndefined();
  });
});

describe('listForUser', () => {
  it('queries the user partition newest-first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await listForUser('u1', 25);
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'USER#u1', ':sk': 'NOTIF#' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(25);
  });
});

describe('markAllRead', () => {
  it('stamps readAt on every currently-unread row and returns the count', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { ...row({ sourceEventId: 'a' }), PK: 'USER#u1', SK: 'NOTIF#t#a' },
        { ...row({ sourceEventId: 'b', readAt: '2026-01-02T00:00:00.000Z' }), PK: 'USER#u1', SK: 'NOTIF#t#b' },
        { ...row({ sourceEventId: 'c' }), PK: 'USER#u1', SK: 'NOTIF#t#c' },
      ],
    });
    ddb.on(UpdateCommand).resolves({});
    const n = await markAllRead('u1');
    expect(n).toBe(2);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(2);
  });
});
