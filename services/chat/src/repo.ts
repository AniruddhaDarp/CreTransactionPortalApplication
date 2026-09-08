import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Role, Scope, Side } from '@cre/authz';
import { docClient } from '@cre/platform';

export type MemberStatus = 'invited' | 'active' | 'removed';

export interface MemberView {
  dealId: string;
  userId: string;
  role: Role;
  side: Side;
  status: MemberStatus;
  version: string;
}

export interface Thread {
  dealId: string;
  threadId: string;
  subject: string;
  scope: Scope;
  stageTag?: number;
  createdBy: string;
  createdAt: string;
  convertedFrom?: Scope;
  deletedAt?: string;
}

export interface Message {
  dealId: string;
  threadId: string;
  msgId: string;
  authorId: string;
  body: string;
  mentions: string[];
  attachments: Array<{ docId: string; title?: string }>;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  history?: Array<{ body: string; at: string }>;
  system?: boolean;
}

export interface Receipt {
  msgId: string;
  userId: string;
  deliveredAt?: string;
  readAt?: string;
}

export interface FeedItem {
  dealId: string;
  kind: string;
  summary: string;
  actorId?: string;
  createdAt: string;
}

export function tableName(): string {
  const t = process.env.CHAT_TABLE;
  if (!t) throw new Error('CHAT_TABLE env var is not set');
  return t;
}

const memberViewKey = (d: string, u: string) => ({ PK: `DEAL#${d}`, SK: `MEMBERVIEW#${u}` });
const dealMetaKey = (d: string) => ({ PK: `DEAL#${d}`, SK: 'DEALMETA' });
const threadKey = (d: string, t: string) => ({ PK: `DEAL#${d}`, SK: `THREAD#${t}` });
const msgSk = (t: string, ts: string, m: string) => `MSG#${t}#${ts}#${m}`;
const rcptKey = (d: string, m: string, u: string) => ({ PK: `DEAL#${d}`, SK: `RCPT#${m}#${u}` });
const readKey = (d: string, t: string, u: string) => ({ PK: `DEAL#${d}`, SK: `READ#${t}#${u}` });

const KEY_ATTRS = new Set(['PK', 'SK']);
function clean<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

// --- membership projection (written by the consumer) --------------------

export async function getMemberView(dealId: string, userId: string): Promise<MemberView | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: memberViewKey(dealId, userId) }),
  );
  return r.Item ? clean<MemberView>(r.Item) : undefined;
}

export async function listMemberViews(dealId: string): Promise<MemberView[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'MEMBERVIEW#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<MemberView>(i));
}

/** Upsert a projection row, guarded so out-of-order `member.*` events converge. */
export async function upsertMemberView(
  dealId: string,
  userId: string,
  patch: { role?: Role; side?: Side; status?: MemberStatus; version: string },
): Promise<void> {
  const sets = [
    '#version = :version',
    'dealId = if_not_exists(dealId, :dealId)',
    'userId = if_not_exists(userId, :userId)',
  ];
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = {
    ':version': patch.version,
    ':dealId': dealId,
    ':userId': userId,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'version' || v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: memberViewKey(dealId, userId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_not_exists(#version) OR #version <= :version',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return; // stale event
    throw err;
  }
}

// --- deal lifecycle projection (written by the consumer) ---------------

export async function setDealStatus(dealId: string, status: string): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...dealMetaKey(dealId), dealId, status },
    }),
  );
}

/** `ACTIVE` unless a `deal.status_changed` has landed here saying otherwise. */
export async function getDealStatus(dealId: string): Promise<string> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: dealMetaKey(dealId) }),
  );
  return String((r.Item as { status?: string } | undefined)?.status ?? 'ACTIVE');
}

// --- threads ----------------------------------------------------------

export async function putThread(thread: Thread): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...threadKey(thread.dealId, thread.threadId), ...thread },
    }),
  );
}

export async function getThread(dealId: string, threadId: string): Promise<Thread | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: threadKey(dealId, threadId) }),
  );
  return r.Item ? clean<Thread>(r.Item) : undefined;
}

export async function listThreads(dealId: string): Promise<Thread[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'THREAD#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Thread>(i));
}

export async function archiveThread(dealId: string, threadId: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: threadKey(dealId, threadId),
      UpdateExpression: 'SET deletedAt = if_not_exists(deletedAt, :now)',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }),
  );
}

export async function convertThread(
  dealId: string,
  threadId: string,
  toScope: Scope,
  fromScope: Scope,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: threadKey(dealId, threadId),
      UpdateExpression: 'SET #scope = :to, convertedFrom = :from',
      ExpressionAttributeNames: { '#scope': 'scope' },
      ExpressionAttributeValues: { ':to': toScope, ':from': fromScope, ':cur': fromScope },
      ConditionExpression: '#scope = :cur',
    }),
  );
}

// --- messages -------------------------------------------------------

export async function postMessage(
  msg: Message,
  recipientUserIds: string[],
): Promise<void> {
  const items = [
    {
      Put: {
        TableName: tableName(),
        Item: {
          PK: `DEAL#${msg.dealId}`,
          SK: msgSk(msg.threadId, msg.createdAt, msg.msgId),
          ...msg,
        },
      },
    },
    ...recipientUserIds.map((uid) => ({
      Put: {
        TableName: tableName(),
        Item: { ...rcptKey(msg.dealId, msg.msgId, uid), msgId: msg.msgId, userId: uid },
      },
    })),
  ];
  await docClient().send(new TransactWriteCommand({ TransactItems: items }));
}

export async function listMessages(
  dealId: string,
  threadId: string,
  afterTs?: string,
): Promise<Message[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: afterTs
        ? 'PK = :pk AND SK BETWEEN :lo AND :hi'
        : 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: afterTs
        ? {
            ':pk': `DEAL#${dealId}`,
            // '~' (0x7E) sorts after every character used in an ISO timestamp or a UUID
            ':lo': `MSG#${threadId}#${afterTs}#`,
            ':hi': `MSG#${threadId}#~`,
          }
        : { ':pk': `DEAL#${dealId}`, ':prefix': `MSG#${threadId}#` },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Message>(i));
}

export async function getMessage(
  dealId: string,
  threadId: string,
  msgId: string,
): Promise<Message | undefined> {
  // SK contains a timestamp we don't have; scan the thread's messages for the id.
  const all = await listMessages(dealId, threadId);
  return all.find((m) => m.msgId === msgId);
}

export async function editMessage(
  dealId: string,
  threadId: string,
  msg: Message,
  newBody: string,
): Promise<Message> {
  const now = new Date().toISOString();
  const history = [...(msg.history ?? []), { body: msg.body, at: msg.editedAt ?? msg.createdAt }];
  const r = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: `DEAL#${dealId}`, SK: msgSk(threadId, msg.createdAt, msg.msgId) },
      UpdateExpression: 'SET body = :b, editedAt = :at, history = :h',
      ExpressionAttributeValues: { ':b': newBody, ':at': now, ':h': history },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return clean<Message>(r.Attributes ?? {});
}

export async function softDeleteMessage(
  dealId: string,
  threadId: string,
  msg: Message,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { PK: `DEAL#${dealId}`, SK: msgSk(threadId, msg.createdAt, msg.msgId) },
      UpdateExpression: 'SET deletedAt = :at',
      ExpressionAttributeValues: { ':at': new Date().toISOString() },
    }),
  );
}

// --- receipts + read markers -------------------------------------

export async function listReceipts(dealId: string, msgId: string): Promise<Receipt[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': `RCPT#${msgId}#` },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Receipt>(i));
}

/** Stamp `deliveredAt` for a user on messages they just fetched (best-effort). */
export async function markDelivered(dealId: string, userId: string, msgIds: string[]): Promise<void> {
  await Promise.all(
    msgIds.map((m) =>
      docClient()
        .send(
          new UpdateCommand({
            TableName: tableName(),
            Key: rcptKey(dealId, m, userId),
            UpdateExpression: 'SET deliveredAt = if_not_exists(deliveredAt, :now)',
            ExpressionAttributeValues: { ':now': new Date().toISOString() },
            ConditionExpression: 'attribute_exists(SK)',
          }),
        )
        .catch(() => undefined),
    ),
  );
}

export async function markRead(
  dealId: string,
  threadId: string,
  userId: string,
  msgIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...readKey(dealId, threadId, userId), threadId, userId, lastReadTs: now },
    }),
  );
  await Promise.all(
    msgIds.map((m) =>
      docClient()
        .send(
          new UpdateCommand({
            TableName: tableName(),
            Key: rcptKey(dealId, m, userId),
            UpdateExpression:
              'SET readAt = if_not_exists(readAt, :now), deliveredAt = if_not_exists(deliveredAt, :now)',
            ExpressionAttributeValues: { ':now': now },
            ConditionExpression: 'attribute_exists(SK)',
          }),
        )
        .catch(() => undefined),
    ),
  );
}

export async function getReadMarker(
  dealId: string,
  threadId: string,
  userId: string,
): Promise<string | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: readKey(dealId, threadId, userId) }),
  );
  return r.Item ? String((r.Item as { lastReadTs?: string }).lastReadTs ?? '') || undefined : undefined;
}

// --- activity feed (written by the consumer) --------------------

export async function putFeedItem(
  dealId: string,
  eventId: string,
  occurredAt: string,
  item: Omit<FeedItem, 'dealId' | 'createdAt'>,
): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: `DEAL#${dealId}`,
          SK: `FEED#${occurredAt}#${eventId}`,
          dealId,
          createdAt: occurredAt,
          ...item,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return; // duplicate delivery
    throw err;
  }
}

export async function listFeed(dealId: string, limit = 50): Promise<FeedItem[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'FEED#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []).map((i) => clean<FeedItem>(i));
}
