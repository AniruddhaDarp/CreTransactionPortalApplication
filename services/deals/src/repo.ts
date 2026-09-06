import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Role, Side } from '@cre/authz';
import { docClient } from '@cre/platform';

export type DealStatus = 'ACTIVE' | 'CLOSED' | 'CANCELLED';
export type MemberStatus = 'invited' | 'active' | 'removed';
export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export interface DealMeta {
  dealId: string;
  address: string;
  propertyType: string;
  label?: string;
  price: number;
  earnestMoney?: number;
  targetClosingDate?: string;
  actualClosingDate?: string;
  description?: string;
  status: DealStatus;
  currentStage: number;
  firm: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  dealId: string;
  userId: string;
  role: Role;
  side: Side;
  status: MemberStatus;
  isAdmin: boolean;
  invitedBy?: string;
  joinedAt: string;
}

export interface Invite {
  dealId: string;
  token: string;
  email: string;
  role: Role;
  side: Side;
  invitedBy: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
}

function table(): string {
  const t = process.env.DEALS_TABLE;
  if (!t) throw new Error('DEALS_TABLE env var is not set');
  return t;
}

const dealKey = (id: string) => ({ PK: `DEAL#${id}`, SK: 'META' });
const memberKey = (id: string, uid: string) => ({ PK: `DEAL#${id}`, SK: `MEMBER#${uid}` });
const inviteKey = (id: string, token: string) => ({ PK: `DEAL#${id}`, SK: `INVITE#${token}` });

const KEY_ATTRS = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK']);
function clean<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

// --- deals ---------------------------------------------------------------

export async function createDeal(input: {
  dealId: string;
  address: string;
  propertyType: string;
  label?: string;
  price: number;
  earnestMoney?: number;
  targetClosingDate?: string;
  description?: string;
  createdBy: string;
}): Promise<{ deal: DealMeta; membership: Membership }> {
  const now = new Date().toISOString();
  const deal: DealMeta = {
    dealId: input.dealId,
    address: input.address,
    propertyType: input.propertyType,
    label: input.label,
    price: input.price,
    earnestMoney: input.earnestMoney,
    targetClosingDate: input.targetClosingDate,
    description: input.description,
    status: 'ACTIVE',
    currentStage: 1,
    firm: false,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const membership: Membership = {
    dealId: input.dealId,
    userId: input.createdBy,
    role: 'SELLER_AGENT',
    side: 'sell',
    status: 'active',
    isAdmin: true,
    joinedAt: now,
  };
  await docClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: { ...dealKey(input.dealId), ...deal },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: table(),
            Item: {
              ...memberKey(input.dealId, input.createdBy),
              GSI1PK: `USER#${input.createdBy}`,
              GSI1SK: `DEAL#${input.dealId}`,
              ...membership,
            },
          },
        },
      ],
    }),
  );
  return { deal, membership };
}

export async function getDeal(dealId: string): Promise<DealMeta | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: table(), Key: dealKey(dealId) }));
  return r.Item ? clean<DealMeta>(r.Item) : undefined;
}

export async function updateDealFields(
  dealId: string,
  patch: Record<string, unknown>,
): Promise<DealMeta> {
  const sets = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  const r = await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: dealKey(dealId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return clean<DealMeta>(r.Attributes ?? {});
}

export async function setDealStatus(
  dealId: string,
  status: DealStatus,
  actualClosingDate?: string,
): Promise<DealMeta> {
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
    ':active': 'ACTIVE',
  };
  let expr = 'SET #status = :status, #updatedAt = :updatedAt';
  if (actualClosingDate) {
    names['#acd'] = 'actualClosingDate';
    values[':acd'] = actualClosingDate;
    expr += ', #acd = :acd';
  }
  const r = await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: dealKey(dealId),
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK) AND #status = :active',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return clean<DealMeta>(r.Attributes ?? {});
}

// --- memberships -------------------------------------------------------

export async function getMembership(
  dealId: string,
  userId: string,
): Promise<Membership | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: table(), Key: memberKey(dealId, userId) }),
  );
  return r.Item ? clean<Membership>(r.Item) : undefined;
}

export async function listMembers(dealId: string): Promise<Membership[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'MEMBER#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Membership>(i));
}

export async function listMyDeals(
  userId: string,
): Promise<Array<DealMeta & { myRole: Role }>> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'DEAL#' },
    }),
  );
  const memberships = (r.Items ?? [])
    .map((i) => clean<Membership>(i))
    .filter((m) => m.status !== 'removed');
  if (memberships.length === 0) return [];
  const batch = await docClient().send(
    new BatchGetCommand({
      RequestItems: { [table()]: { Keys: memberships.map((m) => dealKey(m.dealId)) } },
    }),
  );
  const byId = new Map(
    (batch.Responses?.[table()] ?? []).map((i) => {
      const d = clean<DealMeta>(i);
      return [d.dealId, d] as const;
    }),
  );
  return memberships.flatMap((m) => {
    const d = byId.get(m.dealId);
    return d ? [{ ...d, myRole: m.role }] : [];
  });
}

export async function updateMemberRole(
  dealId: string,
  userId: string,
  role: Role,
  side: Side,
): Promise<Membership> {
  const r = await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: memberKey(dealId, userId),
      UpdateExpression: 'SET #role = :role, #side = :side',
      ExpressionAttributeNames: { '#role': 'role', '#side': 'side', '#status': 'status' },
      ExpressionAttributeValues: { ':role': role, ':side': side, ':active': 'active' },
      ConditionExpression: '#status = :active',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return clean<Membership>(r.Attributes ?? {});
}

export async function removeMember(dealId: string, userId: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: memberKey(dealId, userId),
      UpdateExpression: 'SET #status = :removed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':removed': 'removed', ':active': 'active' },
      ConditionExpression: '#status = :active',
    }),
  );
}

// --- invitations -----------------------------------------------------

export async function putInvite(inv: Invite): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...inviteKey(inv.dealId, inv.token),
        GSI2PK: `EMAIL#${inv.email}`,
        GSI2SK: `INVITE#${inv.dealId}`,
        ...inv,
      },
    }),
  );
}

export async function getInvite(dealId: string, token: string): Promise<Invite | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: table(), Key: inviteKey(dealId, token) }),
  );
  return r.Item ? clean<Invite>(r.Item) : undefined;
}

export async function listInvites(dealId: string): Promise<Invite[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'INVITE#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Invite>(i));
}

export async function revokeInvite(dealId: string, token: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: table(),
      Key: inviteKey(dealId, token),
      UpdateExpression: 'SET #status = :revoked',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':pending': 'pending' },
      ConditionExpression: '#status = :pending',
    }),
  );
}

export async function acceptInvite(args: {
  dealId: string;
  token: string;
  userId: string;
  role: Role;
  side: Side;
  invitedBy: string;
}): Promise<Membership> {
  const membership: Membership = {
    dealId: args.dealId,
    userId: args.userId,
    role: args.role,
    side: args.side,
    status: 'active',
    isAdmin: false,
    invitedBy: args.invitedBy,
    joinedAt: new Date().toISOString(),
  };
  await docClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: {
              ...memberKey(args.dealId, args.userId),
              GSI1PK: `USER#${args.userId}`,
              GSI1SK: `DEAL#${args.dealId}`,
              ...membership,
            },
            ConditionExpression: 'attribute_not_exists(SK)',
          },
        },
        {
          Update: {
            TableName: table(),
            Key: inviteKey(args.dealId, args.token),
            UpdateExpression: 'SET #status = :accepted',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':accepted': 'accepted', ':pending': 'pending' },
            ConditionExpression: '#status = :pending',
          },
        },
      ],
    }),
  );
  return membership;
}

/** Buy-side roster used for the ≤2/≤2/≤7 limit check: active members + pending invites. */
export async function listBuySideRoster(
  dealId: string,
): Promise<Array<{ role: Role; status: MemberStatus }>> {
  const [members, invites] = await Promise.all([listMembers(dealId), listInvites(dealId)]);
  const out: Array<{ role: Role; status: MemberStatus }> = [];
  for (const m of members) if (m.side === 'buy') out.push({ role: m.role, status: m.status });
  for (const i of invites) {
    if (i.side === 'buy' && i.status === 'pending') out.push({ role: i.role, status: 'invited' });
  }
  return out;
}
