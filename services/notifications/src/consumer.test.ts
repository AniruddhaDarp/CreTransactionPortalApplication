import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './consumer.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const ddb = mockClient(DynamoDBDocumentClient);
const eb = mockClient(EventBridgeClient);
const ses = mockClient(SESv2Client);

process.env.NOTIFICATIONS_TABLE = 'notif-test';
process.env.EVENT_BUS_NAME = 'cre-portal-bus';
process.env.WEB_ORIGIN = 'https://spa.example.com';
delete process.env.NOTIFY_EMAIL_FROM; // email disabled

beforeEach(() => {
  ddb.reset();
  eb.reset();
  ses.reset();
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
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
  occurredAt: '2026-02-02T00:00:00.000Z',
  correlationId: 'c1',
  dealId: 'd1',
  actorId: 'actor',
  detail: {},
  ...over,
});
const invoke = (e: never) => handler(e, {} as never, () => {});
const notifPuts = () =>
  ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>).filter((i) => String(i.SK).startsWith('NOTIF#'));

describe('notifications consumer', () => {
  it('account.created writes a profile row', async () => {
    await invoke(sqs([{ type: 'account.created', env: env({ dealId: undefined, detail: { userId: 'u9', email: 'a@b.com' } }) }]));
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, string>;
    expect(item.SK).toBe('PROFILE');
    expect(item.email).toBe('a@b.com');
  });

  it('member.joined updates the projection without touching key attrs', async () => {
    await invoke(sqs([{ type: 'member.joined', env: env({ detail: { userId: 'u2', role: 'BUYER', side: 'buy' } }) }]));
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual({ PK: 'DEAL#d1', SK: 'MEMBERVIEW#u2' });
    expect(upd.UpdateExpression).not.toMatch(/\b(PK|SK)\s*=/);
  });

  it('handshake.requested notifies each approver except the actor', async () => {
    await invoke(
      sqs([
        {
          type: 'handshake.requested',
          env: env({
            actorId: 'u1',
            detail: { hsId: 'h1', action: 'advance_stage', approverIds: ['u1', 'u2', 'u3'] },
          }),
        },
      ]),
    );
    const users = notifPuts().map((i) => i.userId).sort();
    expect(users).toEqual(['u2', 'u3']);
    expect(notifPuts()[0]!.type).toBe('handshake_pending');
  });

  it('stage.advanced broadcasts to every active member incl. the actor (removed excluded)', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { PK: 'DEAL#d1', SK: 'MEMBERVIEW#actor', userId: 'actor', role: 'SELLER_AGENT', side: 'sell', status: 'active' },
        { PK: 'DEAL#d1', SK: 'MEMBERVIEW#u2', userId: 'u2', role: 'BUYER', side: 'buy', status: 'active' },
        { PK: 'DEAL#d1', SK: 'MEMBERVIEW#u3', userId: 'u3', role: 'BUYER_AGENT', side: 'buy', status: 'removed' },
      ],
    });
    await invoke(sqs([{ type: 'stage.advanced', env: env({ detail: { from: 2, to: 3, firmNow: true } }) }]));
    const users = notifPuts().map((i) => i.userId).sort();
    expect(users).toEqual(['actor', 'u2']); // actor included for a broadcast; removed member excluded
  });

  it('a plain message (no mentions) produces no notification', async () => {
    await invoke(sqs([{ type: 'message.posted', env: env({ detail: { threadId: 't', mentions: [] } }) }]));
    expect(notifPuts()).toHaveLength(0);
  });

  it('email stays disabled: no SES call, no notification.emailed', async () => {
    await invoke(
      sqs([
        {
          type: 'docrequest.created',
          env: env({ actorId: 'x', detail: { reqId: 'r', category: 'Title', targetUserId: 'u2' } }),
        },
      ]),
    );
    expect(notifPuts().map((i) => i.userId)).toEqual(['u2']);
    expect(ses.calls()).toHaveLength(0);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it('reports only the failed record for retry', async () => {
    ddb.on(PutCommand).callsFake((input) => {
      if ((input.Item as { userId?: string }).userId === 'bad') throw new Error('boom');
      return {};
    });
    const res = (await invoke(
      sqs([
        { type: 'handshake.approved', env: env({ eventId: 'ok', detail: { hsId: 'h', action: 'x', initiatedBy: 'good' } }) },
        { type: 'handshake.approved', env: env({ eventId: 'bad', detail: { hsId: 'h', action: 'x', initiatedBy: 'bad' } }) },
      ]),
    )) as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['m-1']);
  });
});
