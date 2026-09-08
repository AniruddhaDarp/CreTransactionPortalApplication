import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DocumentCategory, Scope } from '@cre/authz';
import { docClient } from '@cre/platform';

export type DocRequestStatus = 'open' | 'fulfilled' | 'declined' | 'cancelled';

export interface DocumentRow {
  dealId: string;
  docId: string;
  category: DocumentCategory;
  title: string;
  description?: string;
  scope: Scope;
  stageTag?: number;
  currentVersion: number;
  versionCount: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt?: string;
  archivedAt?: string;
}

export interface DocVersion {
  dealId: string;
  docId: string;
  n: number;
  s3Key: string;
  filename: string;
  contentType: string;
  uploadedBy: string;
  uploadedAt: string;
  note?: string;
}

export interface DocRequest {
  dealId: string;
  reqId: string;
  category: DocumentCategory;
  note?: string;
  targetUserId?: string;
  targetRole?: string;
  dueDate?: string;
  stageTag?: number;
  scope: Scope;
  status: DocRequestStatus;
  fulfilledDocId?: string;
  declineReason?: string;
  createdBy: string;
  createdAt: string;
  resolvedAt?: string;
}

export type SignatureStatus = 'sent' | 'completed' | 'declined' | 'voided';
export type RecipientStatus = 'sent' | 'completed' | 'declined';

export interface SignatureEnvelope {
  dealId: string;
  docId: string;
  envId: string;
  version: number;
  scope: Scope;
  provider: string;
  providerEnvelopeId: string;
  subject: string;
  message?: string;
  status: SignatureStatus;
  createdBy: string;
  createdAt: string;
  signedVersion?: number;
  completedAt?: string;
  declineReason?: string;
  voidReason?: string;
}

export interface SignatureRecipient {
  dealId: string;
  envId: string;
  userId: string;
  email?: string;
  name?: string;
  routingOrder: number;
  status: RecipientStatus;
  signedAt?: string;
  declineReason?: string;
}

export function tableName(): string {
  const t = process.env.DOCUMENTS_TABLE;
  if (!t) throw new Error('DOCUMENTS_TABLE env var is not set');
  return t;
}

const docKey = (d: string, id: string) => ({ PK: `DEAL#${d}`, SK: `DOC#${id}` });
const dealMetaKey = (d: string) => ({ PK: `DEAL#${d}`, SK: 'DEALMETA' });

export async function setDealStatus(dealId: string, status: string): Promise<void> {
  await docClient().send(
    new PutCommand({ TableName: tableName(), Item: { ...dealMetaKey(dealId), dealId, status } }),
  );
}

/** `ACTIVE` unless a `deal.status_changed` has landed here saying otherwise. */
export async function getDealStatus(dealId: string): Promise<string> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: dealMetaKey(dealId) }),
  );
  return String((r.Item as { status?: string } | undefined)?.status ?? 'ACTIVE');
}
const verKey = (d: string, id: string, n: number) => ({ PK: `DEAL#${d}`, SK: `DOCVER#${id}#${n}` });
const reqKey = (d: string, id: string) => ({ PK: `DEAL#${d}`, SK: `DOCREQ#${id}` });
const sigKey = (d: string, docId: string, envId: string) => ({
  PK: `DEAL#${d}`,
  SK: `SIG#${docId}#${envId}`,
});
const sigrKey = (d: string, envId: string, uid: string) => ({
  PK: `DEAL#${d}`,
  SK: `SIGR#${envId}#${uid}`,
});

const KEY_ATTRS = new Set(['PK', 'SK']);
function strip<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

// --- documents + versions ---------------------------------------------

export async function createDocument(doc: DocumentRow, version: DocVersion): Promise<void> {
  await docClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: { ...docKey(doc.dealId, doc.docId), ...doc },
            ConditionExpression: 'attribute_not_exists(SK)',
          },
        },
        {
          Put: {
            TableName: tableName(),
            Item: { ...verKey(doc.dealId, doc.docId, version.n), ...version },
          },
        },
      ],
    }),
  );
}

export async function getDocument(dealId: string, docId: string): Promise<DocumentRow | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: tableName(), Key: docKey(dealId, docId) }));
  return r.Item ? strip<DocumentRow>(r.Item) : undefined;
}

export async function listDocuments(dealId: string): Promise<DocumentRow[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'DOC#' },
    }),
  );
  return (r.Items ?? []).map((i) => strip<DocumentRow>(i));
}

export async function listVersions(dealId: string, docId: string): Promise<DocVersion[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': `DOCVER#${docId}#` },
    }),
  );
  return (r.Items ?? []).map((i) => strip<DocVersion>(i)).sort((a, b) => a.n - b.n);
}

export async function getVersion(
  dealId: string,
  docId: string,
  n: number,
): Promise<DocVersion | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: verKey(dealId, docId, n) }),
  );
  return r.Item ? strip<DocVersion>(r.Item) : undefined;
}

export async function addVersion(version: DocVersion): Promise<DocumentRow> {
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...verKey(version.dealId, version.docId, version.n), ...version },
    }),
  );
  const r = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: docKey(version.dealId, version.docId),
      UpdateExpression: 'SET currentVersion = :n, versionCount = :n, updatedAt = :ua',
      ExpressionAttributeValues: { ':n': version.n, ':ua': version.uploadedAt },
      ConditionExpression: 'attribute_exists(SK) AND attribute_not_exists(archivedAt)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip<DocumentRow>(r.Attributes ?? {});
}

export async function promoteDocument(dealId: string, docId: string): Promise<DocumentRow> {
  const r = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: docKey(dealId, docId),
      UpdateExpression: 'SET #scope = :wide, updatedAt = :ua',
      ExpressionAttributeNames: { '#scope': 'scope' },
      ExpressionAttributeValues: {
        ':wide': 'deal_wide',
        ':wide2': 'deal_wide',
        ':ua': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(SK) AND #scope <> :wide2',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip<DocumentRow>(r.Attributes ?? {});
}

export async function archiveDocument(dealId: string, docId: string): Promise<void> {
  await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: docKey(dealId, docId),
      UpdateExpression: 'SET archivedAt = if_not_exists(archivedAt, :now)',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(SK)',
    }),
  );
}

// --- signature envelopes (Module 12) ---------------------------------

export async function createEnvelope(
  env: SignatureEnvelope,
  recipients: SignatureRecipient[],
): Promise<void> {
  await docClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: { ...sigKey(env.dealId, env.docId, env.envId), ...env },
            ConditionExpression: 'attribute_not_exists(SK)',
          },
        },
        ...recipients.map((r) => ({
          Put: {
            TableName: tableName(),
            Item: { ...sigrKey(r.dealId, r.envId, r.userId), ...r },
          },
        })),
      ],
    }),
  );
}

export async function getEnvelope(
  dealId: string,
  docId: string,
  envId: string,
): Promise<SignatureEnvelope | undefined> {
  const r = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: sigKey(dealId, docId, envId) }),
  );
  return r.Item ? strip<SignatureEnvelope>(r.Item) : undefined;
}

export async function listEnvelopesForDoc(
  dealId: string,
  docId: string,
): Promise<SignatureEnvelope[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': `SIG#${docId}#` },
    }),
  );
  return (r.Items ?? [])
    .map((i) => strip<SignatureEnvelope>(i))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listEnvelopesForDeal(dealId: string): Promise<SignatureEnvelope[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'SIG#' },
    }),
  );
  return (r.Items ?? [])
    .map((i) => strip<SignatureEnvelope>(i))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listRecipients(
  dealId: string,
  envId: string,
): Promise<SignatureRecipient[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': `SIGR#${envId}#` },
    }),
  );
  return (r.Items ?? [])
    .map((i) => strip<SignatureRecipient>(i))
    .sort((a, b) => a.routingOrder - b.routingOrder);
}

/** Mark one recipient completed/declined — no-op (swallowed) if already terminal. */
export async function setRecipientOutcome(
  dealId: string,
  envId: string,
  userId: string,
  status: 'completed' | 'declined',
  declineReason?: string,
): Promise<boolean> {
  const sets = ['#s = :s', 'signedAt = :now'];
  const values: Record<string, unknown> = { ':s': status, ':now': new Date().toISOString(), ':sent': 'sent' };
  if (declineReason !== undefined) {
    sets.push('declineReason = :r');
    values[':r'] = declineReason;
  }
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: sigrKey(dealId, envId, userId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(SK) AND #s = :sent',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Advance the envelope from `sent` to a terminal status. Idempotent via the guard. */
export async function setEnvelopeStatus(
  dealId: string,
  docId: string,
  envId: string,
  patch: { status: SignatureStatus; signedVersion?: number; declineReason?: string; voidReason?: string },
): Promise<boolean> {
  const sets = ['#s = :s'];
  const values: Record<string, unknown> = { ':s': patch.status, ':sent': 'sent' };
  if (patch.status === 'completed') {
    sets.push('completedAt = :now', 'signedVersion = :sv');
    values[':now'] = new Date().toISOString();
    values[':sv'] = patch.signedVersion;
  }
  if (patch.declineReason !== undefined) {
    sets.push('declineReason = :dr');
    values[':dr'] = patch.declineReason;
  }
  if (patch.voidReason !== undefined) {
    sets.push('voidReason = :vr');
    values[':vr'] = patch.voidReason;
  }
  try {
    await docClient().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: sigKey(dealId, docId, envId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(SK) AND #s = :sent',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// --- document requests ---------------------------------------------

export async function putDocRequest(req: DocRequest): Promise<void> {
  await docClient().send(
    new PutCommand({ TableName: tableName(), Item: { ...reqKey(req.dealId, req.reqId), ...req } }),
  );
}

export async function getDocRequest(dealId: string, reqId: string): Promise<DocRequest | undefined> {
  const r = await docClient().send(new GetCommand({ TableName: tableName(), Key: reqKey(dealId, reqId) }));
  return r.Item ? strip<DocRequest>(r.Item) : undefined;
}

export async function listDocRequests(dealId: string): Promise<DocRequest[]> {
  const r = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':sk': 'DOCREQ#' },
    }),
  );
  return (r.Items ?? []).map((i) => strip<DocRequest>(i));
}

export async function resolveDocRequest(
  dealId: string,
  reqId: string,
  patch: { status: DocRequestStatus; fulfilledDocId?: string; declineReason?: string },
): Promise<DocRequest> {
  const sets = ['#status = :status', 'resolvedAt = :now'];
  const values: Record<string, unknown> = {
    ':status': patch.status,
    ':now': new Date().toISOString(),
    ':open': 'open',
  };
  if (patch.fulfilledDocId) {
    sets.push('fulfilledDocId = :fd');
    values[':fd'] = patch.fulfilledDocId;
  }
  if (patch.declineReason) {
    sets.push('declineReason = :dr');
    values[':dr'] = patch.declineReason;
  }
  const r = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: reqKey(dealId, reqId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ConditionExpression: '#status = :open',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip<DocRequest>(r.Attributes ?? {});
}
