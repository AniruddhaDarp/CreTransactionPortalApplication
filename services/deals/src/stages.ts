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

const newItemSchema = z.object({
  title: z.string().min(1).max(200),
  assigneeUserId: z.string().max(80).optional(),
  dueDate: isoDate.optional(),
});

const itemPatchSchema = z
  .object({
    title: z.string().min(1).max(200),
    assigneeUserId: z.string().max(80),
    dueDate: isoDate,
    done: z.boolean(),
  })
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

  'GET /v1/deals/{dealId}/stages/{n}/checklist': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const items = await repo.materializeChecklist(deal.dealId, stageNum(ctx));
    return { body: { items } };
  },

  'POST /v1/deals/{dealId}/stages/{n}/checklist': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    assertActive(deal);
    const n = stageNum(ctx);
    if (!can('editChecklist', buildCtx(deal, membership))) {
      throw new HttpError(403, 'not allowed to edit the checklist');
    }
    const input = parseBody(newItemSchema, ctx.body ?? {});
    const itemId = crypto.randomUUID();
    await repo.putChecklistItem({
      dealId: deal.dealId,
      n,
      itemId,
      title: input.title,
      assigneeUserId: input.assigneeUserId,
      dueDate: input.dueDate,
      done: false,
      fromTemplate: false,
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      { type: 'checklist.item_added', detail: { dealId: deal.dealId, n, itemId, title: input.title } },
    ]);
    return { status: 201, body: { itemId, title: input.title } };
  },

  'PATCH /v1/deals/{dealId}/stages/{n}/checklist/{itemId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    assertActive(deal);
    const n = stageNum(ctx);
    const itemId = param(ctx, 'itemId');
    if (!can('editChecklist', buildCtx(deal, membership))) {
      throw new HttpError(403, 'not allowed to edit the checklist');
    }
    const patch = parseBody(itemPatchSchema, ctx.body ?? {});
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'nothing to update');
    const dbPatch: Record<string, unknown> = { ...patch };
    if (patch.done === true) {
      dbPatch.doneBy = ctx.userId;
      dbPatch.doneAt = new Date().toISOString();
    } else if (patch.done === false) {
      dbPatch.doneBy = undefined;
      dbPatch.doneAt = undefined;
    }
    const updated = await repo.updateChecklistItem(deal.dealId, n, itemId, dbPatch);
    if (patch.done !== undefined) {
      await emit(deal.dealId, ctx.correlationId, ctx.userId, [
        {
          type: 'checklist.item_toggled',
          detail: { dealId: deal.dealId, n, itemId, done: patch.done },
        },
      ]);
    }
    return { body: updated };
  },

  'DELETE /v1/deals/{dealId}/stages/{n}/checklist/{itemId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    assertActive(deal);
    const n = stageNum(ctx);
    const itemId = param(ctx, 'itemId');
    if (!can('editChecklist', buildCtx(deal, membership))) {
      throw new HttpError(403, 'not allowed to edit the checklist');
    }
    await repo.deleteChecklistItem(deal.dealId, n, itemId);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      { type: 'checklist.item_removed', detail: { dealId: deal.dealId, n, itemId } },
    ]);
    return { body: { removed: true } };
  },
};
