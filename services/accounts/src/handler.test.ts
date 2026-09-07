import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './handler.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const ddb = mockClient(DynamoDBDocumentClient);
process.env.ACCOUNTS_TABLE = 'accounts-test';
beforeEach(() => ddb.reset());

function event(over: { routeKey?: string; body?: string; sub?: string } = {}) {
  const routeKey = over.routeKey ?? 'GET /v1/me';
  return {
    routeKey,
    rawPath: '/v1/me',
    headers: {},
    body: over.body,
    isBase64Encoded: false,
    pathParameters: {},
    queryStringParameters: {},
    requestContext: {
      requestId: 'r1',
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: { sub: over.sub ?? 'user-1' } } },
    },
  } as never;
}

const run = async (e: never) => (await handler(e)) as { statusCode: number; body: string };

describe('accounts handler', () => {
  it('GET /v1/me returns the profile', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'user-1', email: 'a@b.com', name: 'A' } });
    const res = await run(event());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ userId: 'user-1' });
  });

  it('GET /v1/me 404s before the profile is provisioned', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await run(event())).statusCode).toBe(404);
  });

  it('PUT /v1/me validates and updates', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { userId: 'user-1', company: 'Acme' } });
    const res = await run(event({ routeKey: 'PUT /v1/me', body: JSON.stringify({ company: 'Acme' }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).company).toBe('Acme');
  });

  it('PUT /v1/me rejects an over-long field', async () => {
    const res = await run(
      event({ routeKey: 'PUT /v1/me', body: JSON.stringify({ phone: 'x'.repeat(100) }) }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('PUT /v1/me 404s (not 500) when the profile row was never provisioned', async () => {
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('conditional failed'), { name: 'ConditionalCheckFailedException' }),
    );
    const res = await run(event({ routeKey: 'PUT /v1/me', body: JSON.stringify({ company: 'Acme' }) }));
    expect(res.statusCode).toBe(404);
  });
});
