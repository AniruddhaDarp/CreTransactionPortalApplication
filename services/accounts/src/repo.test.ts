import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProfile, getProfile, updateProfile } from './repo.js';

const ddb = mockClient(DynamoDBDocumentClient);
process.env.ACCOUNTS_TABLE = 'accounts-test';

beforeEach(() => ddb.reset());

describe('accounts repo', () => {
  it('getProfile reads by the profile key', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', email: 'a@b.com' } });
    expect(await getProfile('u1')).toMatchObject({ userId: 'u1' });
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({
      PK: 'USER#u1',
      SK: 'PROFILE',
    });
  });

  it('createProfile guards on attribute_not_exists and lowercases the email GSI key', async () => {
    ddb.on(PutCommand).resolves({});
    const p = await createProfile({ userId: 'u1', email: 'A@B.com', name: 'Ann' });
    const input = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    expect((input.Item as Record<string, unknown>).GSI1PK).toBe('EMAIL#a@b.com');
    expect(p.createdAt).toBe(p.updatedAt);
  });

  it('updateProfile only SETs provided fields and requires the row to exist', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { userId: 'u1', company: 'Acme' } });
    await updateProfile('u1', { company: 'Acme', phone: undefined });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toBe('SET #updatedAt = :updatedAt, #company = :company');
    expect(input.ConditionExpression).toContain('attribute_exists');
  });
});
