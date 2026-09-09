import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { HandshakeAction, Role, Side } from '@cre/authz';
import { docClient } from '@cre/platform';
import { STAGES } from './pipeline.js';

export type DealStatus = 'ACTIVE' | 'CLOSED' | 'CANCELLED';
export type MemberStatus = 'invited' | 'active' | 'removed';
export type InviteStatus = 'pending' | 'accepted' | 'revoked';
export type StageStatus = 'not_started' | 'in_progress' | 'completed';
export type HandshakeStatus = 'pending' | 'approved' | 'rejected' | 'completed';
export type PaymentStatus = 'recorded' | 'confirmed' | 'void';
export type PaymentKind =
  | 'earnest_money'
  | 'additional_deposit'
  | 'closing_funds'
  | 'extension_fee'
  | 'other';
export type PaymentMethod = 'wire' | 'check' | 'ach' | 'other';
export type PaymentParty = 'buyer' | 'seller' | 'escrow' | 'lender' | 'other';

export type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

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

export interface Stage {
  dealId: string;
  n: number;
  key: string;
  name: string;
  status: StageStatus;
  targetDate?: string;
  notes?: string;
  completedBy?: string;
  completedAt?: string;
}


export interface Handshake {
  dealId: string;
  hsId: string;
  action: HandshakeAction;
  payload: Record<string, unknown>;
  initiatedBy: string;
  initiatedSide: Side;
  status: HandshakeStatus;
  sagaState?: 'awaiting_document' | 'awaiting_thread';
  decidedBy?: string;
  decisionReason?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface Payment {
  dealId: string;
  payId: string;
  kind: PaymentKind;
  amount: number;
  method: PaymentMethod;
  payer: PaymentParty;
  payee: PaymentParty;
  reference?: string;
  paidOn: string;
  note?: string;
  /** Whether this payment counts toward the "paid so far vs. accepted price" tally. */
  appliesToPrice: boolean;
  status: PaymentStatus;
  recordedBy: string;
  recordedAt: string;
  confirmHsId?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  voidHsId?: string;
  voidedBy?: string;
  voidedAt?: string;
  voidReason?: string;
}

export function tableName(): string {
  const t = process.env.DEALS_TABLE;
  if (!t) throw new Error('DEALS_TABLE env var is not set');
  return t;
}

const dealKey = (id: string) => ({ PK: `DEAL#${id}`, SK: 'META' });
const memberKey = (id: string, uid: string) => ({ PK: `DEAL#${id}`, SK: `MEMBER#${uid}` });
const inviteKey = (id: string, token: string) => ({ PK: `DEAL#${id}`, SK: `INVITE#${token}` });
const stageKey = (id: string, n: number) => ({ PK: `DEAL#${id}`, SK: `STAGE#${n}` });
const hsKey = (id: string, hsId: string) => ({ PK: `DEAL#${id}`, SK: `HS#${hsId}` });
const apprKey = (id: string, hsId: string, uid: string) => ({
  PK: `DEAL#${id}`,
  SK: `APPR#${hsId}#${uid}`,
});
const payKey = (id: string, payId: string) => ({ PK: `DEAL#${id}`, SK: `PAY#${payId}` });

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
  const stageItems: TransactItem[] = STAGES.map((s) => ({
    Put: {
      TableName: tableName(),
      Item: {
        ...stageKey(input.dealId, s.n),
        dealId: input.dealId,
        n: s.n,
        key: s.key,
        name: s.name,
        status: s.n === 1 ? 'in_progress' : 'not_started',
      },
    },
  }));

  await docClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: { ...dealKey(input.dealId), ...deal },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: tableName(),
            Item: {
              ...memberKey(input.dealId, input.createdBy),
              GSI1PK: `USER#${input.createdBy}`,
              GSI1SK: `DEAL#${input.dealId}`,
              ...membership,
            },
          },
        },
        ...stageItems,
      ],
    }),
  );
  return { deal, membership };
}

export async function getDeal(dealId: string): Promise<DealMeta | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: tableName(), Key: dealKey(dealId) }));
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
      TableName: tableName(),
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
      TableName: tableName(),
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
    new GetCommand({ TableName: tableName(), Key: memberKey(dealId, userId) }),
  );
  return r.Item ? clean<Membership>(r.Item) : undefined;
}

export async function listMembers(dealId: string): Promise<Membership[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
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
      TableName: tableName(),
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
      RequestItems: { [tableName()]: { Keys: memberships.map((m) => dealKey(m.dealId)) } },
    }),
  );
  const byId = new Map(
    (batch.Responses?.[tableName()] ?? []).map((i) => {
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
      TableName: tableName(),
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
      TableName: tableName(),
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
      TableName: tableName(),
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
    new GetCommand({ TableName: tableName(), Key: inviteKey(dealId, token) }),
  );
  return r.Item ? clean<Invite>(r.Item) : undefined;
}

export async function listInvites(dealId: string): Promise<Invite[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'INVITE#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Invite>(i));
}

/** Pending invitations addressed to `email`, across every deal (GSI2 by email). */
export async function listPendingInvitesForEmail(email: string): Promise<Invite[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi2',
      KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
      ExpressionAttributeValues: { ':pk': `EMAIL#${email.toLowerCase()}`, ':sk': 'INVITE#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Invite>(i)).filter((i) => i.status === 'pending');
}

export async function revokeInvite(dealId: string, token: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
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
            TableName: tableName(),
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
            TableName: tableName(),
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

// --- stages ---------------------------------------------------------------

export async function listStages(dealId: string): Promise<Stage[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'STAGE#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Stage>(i)).sort((a, b) => a.n - b.n);
}

export async function getStage(dealId: string, n: number): Promise<Stage | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: stageKey(dealId, n) }),
  );
  return r.Item ? clean<Stage>(r.Item) : undefined;
}

export async function updateStageMeta(
  dealId: string,
  n: number,
  patch: { notes?: string; targetDate?: string },
): Promise<Stage> {
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  const r = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: stageKey(dealId, n),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return clean<Stage>(r.Attributes ?? {});
}

// --- handshakes ---------------------------------------------------------

export async function putHandshake(hs: Handshake, approverIds: string[]): Promise<void> {
  const items: TransactItem[] = [
    { Put: { TableName: tableName(), Item: { ...hsKey(hs.dealId, hs.hsId), ...hs } } },
    ...approverIds.map((uid) => ({
      Put: {
        TableName: tableName(),
        Item: {
          ...apprKey(hs.dealId, hs.hsId, uid),
          GSI1PK: `USER#${uid}`,
          GSI1SK: `APPR#${hs.createdAt}#${hs.hsId}`,
          dealId: hs.dealId,
          hsId: hs.hsId,
          userId: uid,
        },
      },
    })),
  ];
  await docClient().send(new TransactWriteCommand({ TransactItems: items }));
}

export async function getHandshake(dealId: string, hsId: string): Promise<Handshake | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: tableName(), Key: hsKey(dealId, hsId) }));
  return r.Item ? clean<Handshake>(r.Item) : undefined;
}

export async function listHandshakes(dealId: string): Promise<Handshake[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'HS#' },
    }),
  );
  return (r.Items ?? []).map((i) => clean<Handshake>(i));
}

export async function listApprovalPointers(
  dealId: string,
  hsId: string,
): Promise<Array<{ userId: string }>> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': `APPR#${hsId}#` },
    }),
  );
  return (r.Items ?? []).map((i) => ({ userId: String((i as { userId: string }).userId) }));
}

export function apprDeleteItems(
  dealId: string,
  hsId: string,
  userIds: string[],
): TransactItem[] {
  return userIds.map((uid) => ({
    Delete: { TableName: tableName(), Key: apprKey(dealId, hsId, uid) },
  }));
}

/** "My pending approvals" across all deals (GSI1 by user). */
export async function listMyPendingApprovals(userId: string): Promise<Handshake[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'APPR#' },
    }),
  );
  const pointers = (r.Items ?? []).map((i) => i as { dealId: string; hsId: string });
  if (pointers.length === 0) return [];
  const batch = await docClient().send(
    new BatchGetCommand({
      RequestItems: {
        [tableName()]: { Keys: pointers.map((p) => hsKey(p.dealId, p.hsId)) },
      },
    }),
  );
  return (batch.Responses?.[tableName()] ?? [])
    .map((i) => clean<Handshake>(i))
    .filter((hs) => hs.status === 'pending');
}

/**
 * Close a saga-backed handshake once its downstream effect has been confirmed
 * (e.g. the Documents service published `document.archived`). Idempotent: a
 * replayed `document.archived` finds the handshake already `completed` and the
 * conditional write is swallowed.
 */
export async function completeHandshakeSaga(dealId: string, hsId: string): Promise<void> {
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: hsKey(dealId, hsId),
        UpdateExpression: 'SET #status = :done REMOVE sagaState',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':done': 'completed', ':approved': 'approved' },
        ConditionExpression: '#status = :approved',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

export async function runTransaction(items: TransactItem[]): Promise<void> {
  await docClient().send(new TransactWriteCommand({ TransactItems: items }));
}

// --- payments (Module 11) ---------------------------------------------

export async function putPayment(p: Payment): Promise<void> {
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...payKey(p.dealId, p.payId), ...p },
      ConditionExpression: 'attribute_not_exists(SK)',
    }),
  );
}

export async function getPayment(dealId: string, payId: string): Promise<Payment | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: payKey(dealId, payId) }),
  );
  return r.Item ? clean<Payment>(r.Item) : undefined;
}

export async function listPayments(dealId: string): Promise<Payment[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'PAY#' },
    }),
  );
  return (r.Items ?? [])
    .map((i) => clean<Payment>(i))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Point the payment at the (re-)opened confirm or void handshake. */
export async function setPaymentHs(
  dealId: string,
  payId: string,
  field: 'confirmHsId' | 'voidHsId',
  hsId: string,
): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: payKey(dealId, payId),
      UpdateExpression: 'SET #f = :hs',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':hs': hsId },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

export const keys = { dealKey, stageKey, hsKey, payKey };
