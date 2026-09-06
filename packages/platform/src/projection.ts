import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from './ddb.js';

/**
 * Local `MEMBERVIEW#<userId>` membership projection, shared by every consumer
 * service. Fed from Deals' `member.*` events; the caller passes its own table
 * name. Upserts are guarded by a monotonic `version` (the event's `occurredAt`)
 * so out-of-order deliveries converge.
 */
export interface MemberViewRecord {
  dealId: string;
  userId: string;
  role: string;
  side: string;
  status: 'invited' | 'active' | 'removed';
  version: string;
}

const key = (dealId: string, userId: string) => ({
  PK: `DEAL#${dealId}`,
  SK: `MEMBERVIEW#${userId}`,
});

const KEY_ATTRS = new Set(['PK', 'SK']);
function strip<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

export async function getMemberView(
  table: string,
  dealId: string,
  userId: string,
): Promise<MemberViewRecord | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: table, Key: key(dealId, userId) }));
  return r.Item ? strip<MemberViewRecord>(r.Item) : undefined;
}

export async function listMemberViews(
  table: string,
  dealId: string,
): Promise<MemberViewRecord[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'MEMBERVIEW#' },
    }),
  );
  return (r.Items ?? []).map((i) => strip<MemberViewRecord>(i));
}

export async function upsertMemberView(
  table: string,
  dealId: string,
  userId: string,
  patch: { role?: string; side?: string; status?: MemberViewRecord['status']; version: string },
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
        TableName: table,
        Key: key(dealId, userId),
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
