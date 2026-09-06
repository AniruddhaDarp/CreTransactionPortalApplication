import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './api.js';
import type { MemberView, Message, Thread } from './repo.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.mock('./repo.js');
import * as repo from './repo.js';

const eb = mockClient(EventBridgeClient);
process.env.EVENT_BUS_NAME = 'cre-portal-bus';
beforeEach(() => {
  vi.clearAllMocks();
  eb.reset();
  eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
});

const mv = (over: Partial<MemberView> = {}): MemberView => ({
  dealId: 'd1',
  userId: 'u1',
  role: 'BUYER',
  side: 'buy',
  status: 'active',
  version: 'v1',
  ...over,
});
const thread = (over: Partial<Thread> = {}): Thread => ({
  dealId: 'd1',
  threadId: 't1',
  subject: 'General',
  scope: 'deal_wide',
  createdBy: 'admin',
  createdAt: 't',
  ...over,
});

function event(over: { routeKey: string; path?: Record<string, string>; body?: unknown; sub?: string; query?: Record<string, string> }) {
  return {
    routeKey: over.routeKey,
    rawPath: '/',
    headers: {},
    body: over.body === undefined ? undefined : JSON.stringify(over.body),
    isBase64Encoded: false,
    pathParameters: over.path ?? {},
    queryStringParameters: over.query ?? {},
    requestContext: {
      requestId: 'r1',
      http: { method: over.routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: over.sub ?? 'u1', email: 'u1@x.com' } } },
    },
  } as never;
}
const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };
const types = () => eb.commandCalls(PutEventsCommand).flatMap((c) => c.args[0].input.Entries!.map((x) => x.DetailType));

describe('threads', () => {
  it('403s when the caller has no synced membership', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(undefined);
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads', path: { dealId: 'd1' }, body: { subject: 'x', scope: 'deal_wide' } }));
    expect(res.statusCode).toBe(403);
  });

  it('lets a buyer open a deal-wide thread and emits thread.created', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv());
    vi.mocked(repo.putThread).mockResolvedValue();
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads', path: { dealId: 'd1' }, body: { subject: 'General', scope: 'deal_wide' } }));
    expect(res.statusCode).toBe(201);
    expect(types()).toContain('thread.created');
  });

  it('403s a non-agent trying to open the agent channel', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ role: 'BUYER' }));
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads', path: { dealId: 'd1' }, body: { subject: 'x', scope: 'channel:agent' } }));
    expect(res.statusCode).toBe(403);
  });

  it('403s opening the other side’s private thread', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ side: 'buy' }));
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads', path: { dealId: 'd1' }, body: { subject: 'x', scope: 'side_private:sell' } }));
    expect(res.statusCode).toBe(403);
  });

  it('filters GET /threads to what the caller can see', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ side: 'buy', role: 'BUYER' }));
    vi.mocked(repo.listThreads).mockResolvedValue([
      thread({ threadId: 'wide', scope: 'deal_wide' }),
      thread({ threadId: 'buy', scope: 'side_private:buy' }),
      thread({ threadId: 'sell', scope: 'side_private:sell' }),
      thread({ threadId: 'att', scope: 'channel:attorney' }),
    ]);
    const res = await run(event({ routeKey: 'GET /v1/deals/{dealId}/threads', path: { dealId: 'd1' } }));
    const ids = JSON.parse(res.body).threads.map((t: Thread) => t.threadId);
    expect(ids.sort()).toEqual(['buy', 'wide']);
  });
});

describe('messages', () => {
  it('403s an OTHER member posting in a deal-wide thread', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ role: 'OTHER', side: 'buy' }));
    vi.mocked(repo.getThread).mockResolvedValue(thread({ scope: 'deal_wide' }));
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads/{threadId}/messages', path: { dealId: 'd1', threadId: 't1' }, body: { body: 'hi' } }));
    expect(res.statusCode).toBe(403);
  });

  it('posts a message, freezing the recipient set, and emits message.posted', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ userId: 'author', role: 'BUYER', side: 'buy' }));
    vi.mocked(repo.getThread).mockResolvedValue(thread({ scope: 'deal_wide' }));
    vi.mocked(repo.listMemberViews).mockResolvedValue([
      mv({ userId: 'author', role: 'BUYER', side: 'buy' }),
      mv({ userId: 'seller', role: 'SELLER_AGENT', side: 'sell' }),
      mv({ userId: 'title', role: 'TITLE_AGENT', side: 'neutral' }),
    ]);
    vi.mocked(repo.postMessage).mockResolvedValue();
    const res = await run(event({ routeKey: 'POST /v1/deals/{dealId}/threads/{threadId}/messages', path: { dealId: 'd1', threadId: 't1' }, sub: 'author', body: { body: 'hello all' } }));
    expect(res.statusCode).toBe(201);
    const recipients = vi.mocked(repo.postMessage).mock.calls[0]![1];
    expect(recipients.sort()).toEqual(['seller', 'title']); // deal-wide minus the author
    expect(types()).toContain('message.posted');
  });

  it('rolls up receipts: read only when every recipient has read', async () => {
    vi.mocked(repo.getMemberView).mockResolvedValue(mv({ userId: 'author' }));
    vi.mocked(repo.getMessage).mockResolvedValue({ msgId: 'm1', authorId: 'author' } as Message);
    vi.mocked(repo.listReceipts).mockResolvedValue([
      { msgId: 'm1', userId: 'a', deliveredAt: 't', readAt: 't' },
      { msgId: 'm1', userId: 'b', deliveredAt: 't' },
    ]);
    const res = await run(event({ routeKey: 'GET /v1/deals/{dealId}/threads/{threadId}/messages/{msgId}/receipts', path: { dealId: 'd1', threadId: 't1', msgId: 'm1' }, sub: 'author' }));
    expect(JSON.parse(res.body).rollup).toBe('received');
  });
});
