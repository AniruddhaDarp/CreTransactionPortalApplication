import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '@cre/platform';

export interface Profile {
  userId: string;
  email: string;
  name: string;
  company?: string;
  industryRole?: string;
  phone?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProfilePatch = Pick<Profile, 'name' | 'company' | 'industryRole' | 'phone'>;

function tableName(): string {
  const t = process.env.ACCOUNTS_TABLE;
  if (!t) throw new Error('ACCOUNTS_TABLE env var is not set');
  return t;
}

const key = (userId: string) => ({ PK: `USER#${userId}`, SK: 'PROFILE' });

const PROFILE_FIELDS = [
  'userId',
  'email',
  'name',
  'company',
  'industryRole',
  'phone',
  'createdAt',
  'updatedAt',
] as const;

/** Drop DynamoDB key attributes (`PK`, `SK`, `GSI1PK`) from an item. */
function toProfile(item: Record<string, unknown>): Profile {
  const out: Record<string, unknown> = {};
  for (const f of PROFILE_FIELDS) {
    if (item[f] !== undefined) out[f] = item[f];
  }
  return out as unknown as Profile;
}

export async function getProfile(userId: string): Promise<Profile | undefined> {
  const res = await docClient().send(
    new GetCommand({ TableName: tableName(), Key: key(userId), ConsistentRead: false }),
  );
  return res.Item ? toProfile(res.Item) : undefined;
}

/** Idempotent create — throws `ConditionalCheckFailedException` if it already exists. */
export async function createProfile(input: {
  userId: string;
  email: string;
  name: string;
}): Promise<Profile> {
  const now = new Date().toISOString();
  const item = {
    ...key(input.userId),
    GSI1PK: `EMAIL#${input.email.toLowerCase()}`,
    userId: input.userId,
    email: input.email,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return toProfile(item);
}

export async function updateProfile(
  userId: string,
  patch: Partial<ProfilePatch>,
): Promise<Profile> {
  const sets = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`#${field} = :${field}`);
    names[`#${field}`] = field;
    values[`:${field}`] = value;
  }

  const res = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: key(userId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return toProfile(res.Attributes ?? {});
}
