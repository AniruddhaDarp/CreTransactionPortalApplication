import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Scope } from '@cre/authz';
import { docClient } from '@cre/platform';

/** One immutable audit row. Written once; never updated or deleted. */
export interface AuditRow {
  dealId: string;
  eventId: string;
  occurredAt: string;
  actorId?: string;
  detailType: string;
  action: string;
  targetType: string;
  targetId?: string;
  scope: Scope;
  summary: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export function tableName(): string {
  const t = process.env.AUDIT_TABLE;
  if (!t) throw new Error('AUDIT_TABLE env var is not set');
  return t;
}

/** Where the `member.*` projection lives — a separate, mutable table so the
 *  audit-log table's IAM role can be `PutItem`-only. */
export function membershipTableName(): string {
  const t = process.env.AUDIT_MEMBERSHIP_TABLE;
  if (!t) throw new Error('AUDIT_MEMBERSHIP_TABLE env var is not set');
  return t;
}

const rowKey = (dealId: string, occurredAt: string, eventId: string) => ({
  PK: `DEAL#${dealId}`,
  SK: `AUDIT#${occurredAt}#${eventId}`,
});

const KEY_ATTRS = new Set(['PK', 'SK']);
function strip<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

/**
 * Append one row. The SK is deterministic (`occurredAt` + `eventId` both come
 * from the event envelope), so `attribute_not_exists(SK)` makes a redelivered
 * SQS message a no-op. There is no update or delete path — by design and by IAM.
 */
export async function putEvent(row: AuditRow): Promise<void> {
  try {
    await docClient().send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...rowKey(row.dealId, row.occurredAt, row.eventId), ...row },
        ConditionExpression: 'attribute_not_exists(SK)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return; // already recorded
    throw err;
  }
}

export interface QueryOpts {
  from?: string; // ISO timestamp lower bound (inclusive)
  to?: string; // ISO timestamp upper bound (inclusive)
  limit?: number;
  cursor?: string; // opaque base64 of the LastEvaluatedKey
}

export interface QueryPage {
  rows: AuditRow[];
  nextCursor?: string;
}

const enc = (k: Record<string, unknown> | undefined) =>
  k ? Buffer.from(JSON.stringify(k)).toString('base64') : undefined;
const dec = (c: string | undefined) =>
  c ? (JSON.parse(Buffer.from(c, 'base64').toString()) as Record<string, unknown>) : undefined;

/** Newest-first page of a deal's audit rows, optionally bounded by a time range. */
export async function queryDeal(dealId: string, opts: QueryOpts = {}): Promise<QueryPage> {
  // '￿' as an upper-bound suffix so a date-only `to` still includes that
  // whole day's timestamped rows.
  const HI = '￿';
  const values: Record<string, unknown> = { ':pk': `DEAL#${dealId}` };
  let keyExpr = 'PK = :pk AND begins_with(SK, :sk)';
  values[':sk'] = 'AUDIT#';
  if (opts.from && opts.to) {
    keyExpr = 'PK = :pk AND SK BETWEEN :lo AND :hi';
    values[':lo'] = `AUDIT#${opts.from}`;
    values[':hi'] = `AUDIT#${opts.to}${HI}`;
    delete values[':sk'];
  } else if (opts.from) {
    keyExpr = 'PK = :pk AND SK >= :lo';
    values[':lo'] = `AUDIT#${opts.from}`;
    delete values[':sk'];
  } else if (opts.to) {
    keyExpr = 'PK = :pk AND SK <= :hi';
    values[':hi'] = `AUDIT#${opts.to}${HI}`;
    delete values[':sk'];
  }

  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: keyExpr,
      ExpressionAttributeValues: values,
      ScanIndexForward: false, // newest first
      Limit: opts.limit,
      ExclusiveStartKey: dec(opts.cursor),
    }),
  );
  return {
    rows: (r.Items ?? []).map((i) => strip<AuditRow>(i)),
    nextCursor: enc(r.LastEvaluatedKey),
  };
}

/** Read the whole deal partition (used by export; capped by the caller). */
export async function scanDeal(dealId: string, hardCap: number): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryDeal(dealId, { cursor, limit: 1000 });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor && rows.length < hardCap);
  return rows.slice(0, hardCap);
}

export async function getRow(
  dealId: string,
  occurredAt: string,
  eventId: string,
): Promise<AuditRow | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: rowKey(dealId, occurredAt, eventId) }),
  );
  return r.Item ? strip<AuditRow>(r.Item) : undefined;
}
