import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from './consumer.js';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.AUDIT_TABLE = 'audit-test';
process.env.AUDIT_MEMBERSHIP_TABLE = 'audit-mv-test';

beforeEach(() => {
  ddb.reset();
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
});

function sqs(records: Array<{ type: string; env: Record<string, unknown> }>) {
  return {
    Records: records.map((r, i) => ({
      messageId: `m-${i}`,
      body: JSON.stringify({ 'detail-type': r.type, detail: r.env }),
    })),
  } as never;
}
const env = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  occurredAt: '2026-01-02T03:04:05.000Z',
  correlationId: 'c1',
  dealId: 'd1',
  actorId: 'admin',
  detail: {},
  ...over,
});
const invoke = (e: never) => handler(e, {} as never, () => {});
const puts = () => ddb.commandCalls(PutCommand).map((c) => c.args[0].input);

describe('audit consumer', () => {
  it('records any deal-scoped event as one immutable row', async () => {
    await invoke(
      sqs([
        {
          type: 'document.uploaded',
          env: env({ detail: { dealId: 'd1', docId: 'x', category: 'Financing', scope: 'side_private:buy' } }),
        },
      ]),
    );
    const item = puts()[0]!.Item as Record<string, unknown>;
    expect(item.SK).toBe('AUDIT#2026-01-02T03:04:05.000Z#e1');
    expect(item.scope).toBe('side_private:buy');
    expect(item.detailType).toBe('document.uploaded');
    expect(String(item.summary)).toContain('Financing');
    expect(puts()[0]!.ConditionExpression).toBe('attribute_not_exists(SK)');
  });

  it('member.joined also upserts the projection (separate table, no key writes)', async () => {
    await invoke(
      sqs([
        { type: 'member.joined', env: env({ detail: { userId: 'u2', role: 'BUYER', side: 'buy' } }) },
      ]),
    );
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.TableName).toBe('audit-mv-test');
    expect(upd.Key).toEqual({ PK: 'DEAL#d1', SK: 'MEMBERVIEW#u2' });
    expect(upd.UpdateExpression).not.toMatch(/\b(PK|SK)\s*=/);
    // and it is still written to the audit log
    expect(puts().some((p) => (p.Item as Record<string, unknown>).detailType === 'member.joined')).toBe(
      true,
    );
  });

  it('skips events with no dealId (account.created)', async () => {
    await invoke(
      sqs([{ type: 'account.created', env: env({ dealId: undefined, detail: { userId: 'u1' } }) }]),
    );
    expect(puts()).toHaveLength(0);
  });

  it('reports only the failed record for retry', async () => {
    ddb.on(PutCommand).callsFake((input) => {
      if ((input.Item as { eventId: string }).eventId === 'bad') throw new Error('boom');
      return {};
    });
    const res = (await invoke(
      sqs([
        { type: 'deal.created', env: env({ eventId: 'ok', detail: { dealId: 'd1' } }) },
        { type: 'deal.created', env: env({ eventId: 'bad', detail: { dealId: 'd1' } }) },
      ]),
    )) as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['m-1']);
  });
});
