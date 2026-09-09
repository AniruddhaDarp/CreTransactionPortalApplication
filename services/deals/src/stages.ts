import { can } from '@cre/authz';
import { HttpError, parseBody, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import { buildCtx } from './context.js';
import * as handshake from './handshake.js';
import * as repo from './repo.js';
import { assertActive, emit, param, requireMember, stageNum } from './shared.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const stagePatchSchema = z
  .object({ notes: z.string().max(2000), targetDate: isoDate })
  .partial();

export const stageRoutes: Record<string, RouteHandler> = {
  'GET /v1/deals/{dealId}/stages': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    return {
      body: {
        stages: await repo.listStages(deal.dealId),
        currentStage: deal.currentStage,
        firm: deal.firm,
      },
    };
  },

  'PATCH /v1/deals/{dealId}/stages/{n}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    assertActive(deal);
    const n = stageNum(ctx);
    if (!can('editStageMeta', buildCtx(deal, membership))) {
      throw new HttpError(403, 'not allowed to edit stage details');
    }
    const patch = parseBody(stagePatchSchema, ctx.body ?? {});
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'nothing to update');
    if (patch.targetDate !== undefined && deal.firm) {
      throw new HttpError(
        400,
        'the deal is firm — changing a target date requires a handshake (POST /v1/deals/{id}/terms)',
      );
    }
    const before = await repo.getStage(deal.dealId, n);
    const updated = await repo.updateStageMeta(deal.dealId, n, patch);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, to] of Object.entries(patch)) {
      changed[k] = { from: (before as Record<string, unknown> | undefined)?.[k] ?? null, to };
    }
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      { type: 'stage.updated', detail: { dealId: deal.dealId, n, changed } },
    ]);
    return { body: updated };
  },

  'POST /v1/deals/{dealId}/advance': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    assertActive(deal);
    const { hs, events } = await handshake.initiate({
      deal,
      authz: buildCtx(deal, membership),
      action: 'advance_stage',
      payload: {},
      actorId: ctx.userId,
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, events);
    return { status: 202, body: { handshakeId: hs.hsId, action: 'advance_stage', status: 'pending' } };
  },
};
