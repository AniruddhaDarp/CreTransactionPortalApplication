import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpError, parseBody, router } from './http.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

function event(overrides: Partial<{ routeKey: string; sub: string; body: string }> = {}) {
  const { routeKey = 'GET /v1/me', sub = 'user-123', body } = overrides;
  return {
    routeKey,
    rawPath: '/v1/me',
    headers: { 'x-correlation-id': 'cid-abc' },
    body,
    isBase64Encoded: false,
    pathParameters: {},
    queryStringParameters: {},
    requestContext: {
      requestId: 'req-1',
      http: { method: routeKey.split(' ')[0] },
      authorizer: { jwt: { claims: sub ? { sub } : {} } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe('router', () => {
  it('dispatches by routeKey and returns JSON with the correlation id', async () => {
    const handler = router({
      'GET /v1/me': async (ctx) => ({ body: { userId: ctx.userId } }),
    });
    const res = await handler(event());
    expect(res).toMatchObject({
      statusCode: 200,
      headers: { 'x-correlation-id': 'cid-abc', 'content-type': 'application/json' },
    });
    expect(JSON.parse((res as { body: string }).body)).toEqual({ userId: 'user-123' });
  });

  it('401s when the JWT has no sub', async () => {
    const handler = router({ 'GET /v1/me': async () => ({}) });
    const res = await handler(event({ sub: '' }));
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });

  it('404s an unknown route', async () => {
    const handler = router({ 'GET /v1/me': async () => ({}) });
    const res = await handler(event({ routeKey: 'DELETE /v1/me' }));
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });

  it('400s an unparseable body', async () => {
    const handler = router({ 'PUT /v1/me': async () => ({}) });
    const res = await handler(event({ routeKey: 'PUT /v1/me', body: '{not json' }));
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it('maps a thrown HttpError to its status', async () => {
    const handler = router({
      'GET /v1/me': async () => {
        throw new HttpError(403, 'nope');
      },
    });
    const res = await handler(event());
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(JSON.parse((res as { body: string }).body)).toMatchObject({ error: 'nope' });
  });

  it('maps an unexpected throw to 500 without leaking the message', async () => {
    const handler = router({
      'GET /v1/me': async () => {
        throw new Error('secret db string');
      },
    });
    const res = await handler(event());
    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect((res as { body: string }).body).not.toContain('secret db string');
  });
});

describe('parseBody', () => {
  const schema = z.object({ company: z.string().min(1) });

  it('returns parsed data on success', () => {
    expect(parseBody(schema, { company: 'Acme' })).toEqual({ company: 'Acme' });
  });

  it('throws HttpError(400) on failure', () => {
    expect(() => parseBody(schema, { company: '' })).toThrow(HttpError);
  });
});
