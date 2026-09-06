import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './consumer.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const ddb = mockClient(DynamoDBDocumentClient);
const eb = mockClient(EventBridgeClient);
process.env.DOCUMENTS_TABLE = 'docs-test';
process.env.EVENT_BUS_NAME = 'cre-portal-bus';

beforeEach(() => {
  ddb.reset();
  eb.reset();
  ddb.on(UpdateCommand).resolves({});
  ddb.on(GetCommand).resolves({ Item: { PK: 'DEAL#d1', SK: 'DOC#doc9', scope: 'side_private:buy' } });
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
});

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
const call = (h = handler) => h;

describe('documents consumer', () => {
  it('member.joined upserts a MEMBERVIEW row without touching key attributes', async () => {
    await call()(
      sqs([
        { type: 'member.joined', env: env({ detail: { userId: 'u2', role: 'BUYER', side: 'buy' } }) },
      ]),
      {} as never,
      () => {},
    );
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual({ PK: 'DEAL#d1', SK: 'MEMBERVIEW#u2' });
    expect(upd.ConditionExpression).toContain('#version <= :version');
    expect(upd.UpdateExpression).not.toMatch(/\b(PK|SK)\s*=/);
  });

  it('a stale projection write (ConditionalCheckFailed) is swallowed', async () => {
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('stale'), { name: 'ConditionalCheckFailedException' }),
    );
    const res = (await call()(
      sqs([{ type: 'member.removed', env: env({ detail: { userId: 'u2' } }) }]),
      {} as never,
      () => {},
    )) as { batchItemFailures: unknown[] };
    expect(res.batchItemFailures).toHaveLength(0);
  });

  it('handshake.approved for delete_document archives the doc and emits document.archived', async () => {
    await call()(
      sqs([
        {
          type: 'handshake.approved',
          env: env({
            detail: { hsId: 'hs1', action: 'delete_document', payload: { docId: 'doc9' } },
          }),
        },
      ]),
      {} as never,
      () => {},
    );
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual({ PK: 'DEAL#d1', SK: 'DOC#doc9' });
    expect(upd.UpdateExpression).toContain('archivedAt');

    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry.DetailType).toBe('document.archived');
    expect(JSON.parse(entry.Detail!).detail).toMatchObject({
      docId: 'doc9',
      hsId: 'hs1',
      scope: 'side_private:buy',
    });
  });

  it('ignores handshake.approved for non-document actions', async () => {
    await call()(
      sqs([
        {
          type: 'handshake.approved',
          env: env({ detail: { hsId: 'hs2', action: 'advance_stage', payload: {} } }),
        },
      ]),
      {} as never,
      () => {},
    );
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it('reports only the failed record for retry', async () => {
    ddb.on(UpdateCommand).callsFake((input) => {
      if ((input.Key as { SK: string }).SK === 'MEMBERVIEW#bad') throw new Error('boom');
      return {};
    });
    const res = (await call()(
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
