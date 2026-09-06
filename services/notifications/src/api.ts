import { HttpError, parseBody, router } from '@cre/platform';
import { z } from 'zod';
import * as repo from './repo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const readSchema = z
  .object({ id: z.string().min(1).optional(), all: z.boolean().optional() })
  .refine((v) => Boolean(v.id) || v.all === true, { message: 'provide `id` or `all: true`' });

/** The client-facing id is the SK minus its `NOTIF#` prefix: `<occurredAt>#<eventId>`. */
const rowId = (n: repo.NotificationRow) => `${n.occurredAt}#${n.sourceEventId}`;

export const handler = router({
  'GET /v1/notifications': async (ctx) => {
    const limit = Math.min(Math.max(Number(ctx.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const rows = await repo.listForUser(ctx.userId, limit);
    return {
      body: {
        notifications: rows.map((n) => ({ ...n, id: rowId(n) })),
        unreadCount: rows.filter((n) => !n.readAt).length,
      },
    };
  },

  'POST /v1/notifications/read': async (ctx) => {
    const input = parseBody(readSchema, ctx.body ?? {});
    if (input.all) {
      const n = await repo.markAllRead(ctx.userId);
      return { body: { marked: n } };
    }
    const [occurredAt, eventId] = String(input.id).split('#');
    if (!occurredAt || !eventId) throw new HttpError(400, 'malformed notification id');
    await repo.markRead(ctx.userId, occurredAt, eventId);
    return { body: { marked: 1 } };
  },
});
