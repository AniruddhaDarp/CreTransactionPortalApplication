import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './consumer.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const ddb = mockClient(DynamoDBDocumentClient);
process.env.CHAT_TABLE = 'chat-test';
beforeEach(() => ddb.reset());

function sqs(records: Array<{ type: string; env: Record<string, unknown> }>) {
  return {
    Records: records.map((r, i) => ({
      messageId: `msg-${i}`,
      body: JSON.stringify({ 'detail-type': r.type, detail: r.env }),
    })),
  } as never;
}
const env = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: 'c1',
  dealId: 'd1',
  actorId: 'admin',
  detail: {},
  ...over,
});

describe('chat consumer', () => {
  it('member.joined upserts a MEMBERVIEW row with a version guard', async () => {
    ddb.on(UpdateCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    await handler(
      sqs([{ type: 'member.joined', env: env({ detail: { userId: 'u2', role: 'BUYER', side: 'buy' } }) }]),
      {} as never,
      () => {},
    );
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual({ PK: 'DEAL#d1', SK: 'MEMBERVIEW#u2' });
    expect(upd.ConditionExpression).toContain('#version <= :version');
    // must NOT try to SET key attributes — DynamoDB rejects that
    expect(upd.UpdateExpression).not.toMatch(/\b(PK|SK)\s*=/);
  });

  it('a projection ConditionalCheckFailed (stale event) is swallowed', async () => {
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' }),
    );
    ddb.on(PutCommand).resolves({});
    const res = await handler(
      sqs([{ type: 'member.role_changed', env: env({ detail: { userId: 'u2', to: 'BUYER_AGENT' } }) }]),
      {} as never,
      () => {},
    );
    expect((res as { batchItemFailures: unknown[] }).batchItemFailures).toHaveLength(0);
  });

  it('stage.advanced writes a deduped FEED item', async () => {
    ddb.on(PutCommand).resolves({});
    await handler(
      sqs([{ type: 'stage.advanced', env: env({ detail: { from: 2, to: 3, firmNow: true } }) }]),
      {} as never,
      () => {},
    );
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect((put.Item as Record<string, unknown>).SK).toMatch(/^FEED#2026-01-01/);
    expect(put.ConditionExpression).toContain('attribute_not_exists(SK)');
    expect((put.Item as Record<string, unknown>).summary).toContain('now firm');
  });

  it('reports only the failed record for retry', async () => {
    ddb.on(UpdateCommand).callsFake((input) => {
      if ((input.Key as { SK: string }).SK === 'MEMBERVIEW#bad') throw new Error('boom');
      return {};
    });
    ddb.on(PutCommand).resolves({});
    const res = (await handler(
      sqs([
        { type: 'member.joined', env: env({ detail: { userId: 'ok', role: 'BUYER', side: 'buy' } }) },
        { type: 'member.joined', env: env({ detail: { userId: 'bad', role: 'BUYER', side: 'buy' } }) },
      ]),
      {} as never,
      () => {},
    )) as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['msg-1']);
  });
});
