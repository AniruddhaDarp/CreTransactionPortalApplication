import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient } from '@cre/platform';

export interface NotificationRow {
  userId: string;
  notifId: string; // = the source eventId (SK is deterministic per user+event)
  occurredAt: string;
  type: string;
  title: string;
  dealId?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  readAt?: string;
  sourceEventId: string;
}

export interface Profile {
  userId: string;
  email: string;
  name: string;
}

export function tableName(): string {
  const t = process.env.NOTIFICATIONS_TABLE;
  if (!t) throw new Error('NOTIFICATIONS_TABLE env var is not set');
  return t;
}

const notifKey = (userId: string, occurredAt: string, eventId: string) => ({
  PK: `USER#${userId}`,
  SK: `NOTIF#${occurredAt}#${eventId}`,
});
const profileKey = (userId: string) => ({ PK: `USER#${userId}`, SK: 'PROFILE' });

const KEY_ATTRS = new Set(['PK', 'SK']);
function strip<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

/** One row per (recipient, source event). Deterministic SK → a redelivered
 *  event is absorbed by `attribute_not_exists`. */
export async function putNotification(row: NotificationRow): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...notifKey(row.userId, row.occurredAt, row.sourceEventId), ...row },
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export async function listForUser(userId: string, limit: number): Promise<NotificationRow[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'NOTIF#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (r.Items ?? []).map((i) => strip<NotificationRow>(i));
}

export async function markRead(userId: string, occurredAt: string, eventId: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: notifKey(userId, occurredAt, eventId),
      UpdateExpression: 'SET readAt = if_not_exists(readAt, :now)',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(SK)',
    }),
  );
}

/** Mark every currently-unread notification read. */
export async function markAllRead(userId: string): Promise<number> {
  const rows = await listForUser(userId, 500);
  const unread = rows.filter((n) => !n.readAt);
  const now = new Date().toISOString();
  await Promise.all(
    unread.map((n) =>
      docClient().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: notifKey(n.userId, n.occurredAt, n.sourceEventId),
          UpdateExpression: 'SET readAt = :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      ),
    ),
  );
  return unread.length;
}

export async function putProfile(p: Profile): Promise<void> {
  await docClient().send(
    new PutCommand({ TableName: tableName(), Item: { ...profileKey(p.userId), ...p } }),
  );
}

export async function getProfile(userId: string): Promise<Profile | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: profileKey(userId) }),
  );
  return r.Item ? strip<Profile>(r.Item) : undefined;
}
