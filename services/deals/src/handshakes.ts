import { HttpError, parseBody, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import { buildCtx } from './context.js';
import * as handshake from './handshake.js';
import * as repo from './repo.js';
import { emit, param, requireMember } from './shared.js';

const rejectSchema = z.object({ reason: z.string().max(500).optional() });

export const handshakeRoutes: Record<string, RouteHandler> = {
  'GET /v1/deals/{dealId}/handshakes': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    return { body: { handshakes: await repo.listHandshakes(deal.dealId) } };
  },

  // "my pending approvals" across every deal (GSI1 by user) — no deal path param.
  'GET /v1/handshakes': async (ctx) => {
    return { body: { handshakes: await repo.listMyPendingApprovals(ctx.userId) } };
  },

  'POST /v1/deals/{dealId}/handshakes/{hsId}/approve': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const hs = await repo.getHandshake(deal.dealId, param(ctx, 'hsId'));
    if (!hs) throw new HttpError(404, 'handshake not found');
    const { events } = await handshake.decide({
      deal,
      hs,
      authz: buildCtx(deal, membership),
      actorId: ctx.userId,
      decision: 'approve',
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, events);
    return { body: { hsId: hs.hsId, status: 'approved' } };
  },

  'POST /v1/deals/{dealId}/handshakes/{hsId}/reject': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const hs = await repo.getHandshake(deal.dealId, param(ctx, 'hsId'));
    if (!hs) throw new HttpError(404, 'handshake not found');
    const { reason } = parseBody(rejectSchema, ctx.body ?? {});
    const { events } = await handshake.decide({
      deal,
      hs,
      authz: buildCtx(deal, membership),
      actorId: ctx.userId,
      decision: 'reject',
      reason,
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, events);
    return { body: { hsId: hs.hsId, status: 'rejected' } };
  },
};
