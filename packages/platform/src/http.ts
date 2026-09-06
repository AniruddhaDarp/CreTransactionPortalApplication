import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { ZodType } from 'zod';
import { createLogger, type Logger } from './logger.js';

/** Everything a route handler needs, derived from the API Gateway v2 event. */
export interface RequestContext {
  method: string;
  path: string;
  /** Cognito `sub` from the JWT authorizer (guaranteed non-empty). */
  userId: string;
  claims: Record<string, unknown>;
  correlationId: string;
  log: Logger;
  /** Parsed JSON body, or `undefined`. */
  body: unknown;
  pathParams: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type RouteResult = { status?: number; body?: unknown } | void;
export type RouteHandler = (ctx: RequestContext) => Promise<RouteResult>;

/**
 * Build a Lambda handler from a `{ "<METHOD> <path>": handler }` map keyed by
 * API Gateway v2 `routeKey`. Adds correlation-id handling, JWT-claims
 * extraction, JSON parsing, structured logs, and error -> response mapping.
 */
export function router(routes: Record<string, RouteHandler>) {
  return async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyResultV2> => {
    const correlationId =
      firstHeader(event, 'x-correlation-id') ?? event.requestContext.requestId;
    const routeKey = event.routeKey;
    const log = createLogger({ correlationId, routeKey });

    try {
      const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<
        string,
        unknown
      >;
      const userId = String(claims.sub ?? '');
      if (!userId) throw new HttpError(401, 'unauthenticated');

      const handler = routes[routeKey];
      if (!handler) throw new HttpError(404, `no route for ${routeKey}`);

      let body: unknown;
      if (event.body) {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      }

      const result = await handler({
        method: event.requestContext.http.method,
        path: event.rawPath,
        userId,
        claims,
        correlationId,
        log,
        body,
        pathParams: event.pathParameters ?? {},
        query: event.queryStringParameters ?? {},
      });

      const status = result?.status ?? 200;
      log.info('request ok', { status });
      return json(status, result?.body ?? {}, correlationId);
    } catch (err) {
      if (err instanceof HttpError) {
        log.warn('request rejected', { status: err.status, message: err.message });
        return json(err.status, { error: err.message, detail: err.detail }, correlationId);
      }
      const e = err as Error;
      log.error('unhandled error', { message: e.message, stack: e.stack });
      return json(500, { error: 'internal error' }, correlationId);
    }
  };
}

/** Validate `data` against `schema`, throwing `HttpError(400)` on failure. */
export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'validation failed', r.error.flatten());
  return r.data;
}

function firstHeader(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  name: string,
): string | undefined {
  const v = event.headers?.[name] ?? event.headers?.[name.toLowerCase()];
  return v?.split(',')[0]?.trim() || undefined;
}

function json(status: number, body: unknown, correlationId: string): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
    body: JSON.stringify(body),
  };
}
