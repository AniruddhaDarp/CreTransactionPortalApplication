import { can, isAgent, isAttorney, type Scope } from '@cre/authz';
import { HttpError, parseBody, router } from '@cre/platform';
import { z } from 'zod';
import * as repo from './repo.js';
import { assertCanSee, requireViewer, scopeParticipants, sideOfScope } from './scope.js';
import { authzCtx, emit, param } from './shared.js';

const scopeEnum = z.enum([
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
]);

const newThreadSchema = z.object({
  subject: z.string().min(1).max(160),
  scope: scopeEnum,
  stageTag: z.number().int().min(1).max(6).optional(),
});

const convertSchema = z.object({ toSide: z.enum(['buy', 'sell']) });

const newMessageSchema = z.object({
  body: z.string().min(1).max(8000),
  mentions: z.array(z.string().max(80)).max(20).optional(),
  attachments: z
    .array(z.object({ docId: z.string().max(80), title: z.string().max(200).optional() }))
    .max(10)
    .optional(),
});

const editMessageSchema = z.object({ body: z.string().min(1).max(8000) });

function assertCanCreate(mv: repo.MemberView, scope: Scope): void {
  const ctx = authzCtx(mv);
  if (scope === 'deal_wide') {
    if (!can('createThreadDealWide', ctx)) throw new HttpError(403, 'not allowed to start a deal-wide thread');
    return;
  }
  const side = sideOfScope(scope);
  if (side) {
    if (mv.side !== side) throw new HttpError(403, `only ${side}-side members can start a ${side} thread`);
    return;
  }
  if (scope === 'channel:agent' && !isAgent(mv.role)) {
    throw new HttpError(403, 'only an agent can start the agent channel');
  }
  if (scope === 'channel:attorney' && !isAttorney(mv.role)) {
    throw new HttpError(403, 'only an attorney can start the attorney channel');
  }
}

const maskBody = (m: repo.Message) => (m.deletedAt ? '[message removed]' : m.body);

export const handler = router({
  'POST /v1/deals/{dealId}/threads': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const mv = await requireViewer(dealId, ctx.userId);
    const input = parseBody(newThreadSchema, ctx.body ?? {});
    assertCanCreate(mv, input.scope);
    const thread: repo.Thread = {
      dealId,
      threadId: crypto.randomUUID(),
      subject: input.subject,
      scope: input.scope,
      stageTag: input.stageTag,
      createdBy: ctx.userId,
      createdAt: new Date().toISOString(),
    };
    await repo.putThread(thread);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'thread.created',
        detail: { dealId, threadId: thread.threadId, scope: thread.scope, subject: thread.subject },
      },
    ]);
    return { status: 201, body: thread };
  },

  'GET /v1/deals/{dealId}/threads': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const mv = await requireViewer(dealId, ctx.userId);
    const visible = (await repo.listThreads(dealId)).filter((t) => {
      try {
        assertCanSee(mv, t.scope);
        return true;
      } catch {
        return false;
      }
    });
    return { body: { threads: visible } };
  },

  'POST /v1/deals/{dealId}/threads/{threadId}/convert': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const mv = await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, param(ctx, 'threadId'));
    if (!thread) throw new HttpError(404, 'thread not found');
    if (thread.scope !== 'channel:agent' && thread.scope !== 'channel:attorney') {
      throw new HttpError(400, 'only agent/attorney channel threads can be converted');
    }
    if (thread.scope === 'channel:agent' && !isAgent(mv.role)) {
      throw new HttpError(403, 'only an agent may convert the agent channel');
    }
    if (thread.scope === 'channel:attorney' && !isAttorney(mv.role)) {
      throw new HttpError(403, 'only an attorney may convert the attorney channel');
    }
    const { toSide } = parseBody(convertSchema, ctx.body ?? {});
    if (toSide !== mv.side) throw new HttpError(403, 'you can only pull a thread onto your own side');
    const toScope: Scope = toSide === 'buy' ? 'side_private:buy' : 'side_private:sell';

    const others = (await repo.listMemberViews(dealId)).filter(
      (m) =>
        m.status === 'active' &&
        m.side !== toSide &&
        (thread.scope === 'channel:agent' ? isAgent(m.role) : isAttorney(m.role)),
    );
    await repo.convertThread(dealId, thread.threadId, toScope, thread.scope);

    const now = new Date().toISOString();
    await repo.postMessage(
      {
        dealId,
        threadId: thread.threadId,
        msgId: crypto.randomUUID(),
        authorId: ctx.userId,
        body: `Thread moved to ${toSide}-side private.`,
        mentions: [],
        attachments: [],
        createdAt: now,
        system: true,
      },
      [],
    );
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'thread.converted',
        detail: {
          dealId,
          threadId: thread.threadId,
          toScope,
          droppedUserId: others[0]?.userId,
        },
      },
    ]);
    return { body: { ...thread, scope: toScope, convertedFrom: thread.scope } };
  },

  'GET /v1/deals/{dealId}/threads/{threadId}/messages': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    const mv = await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    assertCanSee(mv, thread.scope);
    const msgs = await repo.listMessages(dealId, threadId, ctx.query.after);
    await repo.markDelivered(
      dealId,
      ctx.userId,
      msgs.filter((m) => m.authorId !== ctx.userId).map((m) => m.msgId),
    );
    return {
      body: {
        messages: msgs.map((m) => ({ ...m, body: maskBody(m), history: undefined })),
      },
    };
  },

  'POST /v1/deals/{dealId}/threads/{threadId}/messages': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    const mv = await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    assertCanSee(mv, thread.scope);
    if (mv.role === 'OTHER' && thread.scope !== `side_private:${mv.side}`) {
      throw new HttpError(403, 'this role can only post in its own side-private threads');
    }
    const input = parseBody(newMessageSchema, ctx.body ?? {});
    const participants = await scopeParticipants(dealId, thread.scope);
    const recipientIds = participants.map((p) => p.userId).filter((u) => u !== ctx.userId);

    const msg: repo.Message = {
      dealId,
      threadId,
      msgId: crypto.randomUUID(),
      authorId: ctx.userId,
      body: input.body,
      mentions: input.mentions ?? [],
      attachments: input.attachments ?? [],
      createdAt: new Date().toISOString(),
    };
    await repo.postMessage(msg, recipientIds);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'message.posted',
        detail: {
          dealId,
          threadId,
          msgId: msg.msgId,
          authorId: ctx.userId,
          scope: thread.scope,
          mentions: msg.mentions,
        },
      },
    ]);
    return { status: 201, body: { msgId: msg.msgId, createdAt: msg.createdAt } };
  },

  'PATCH /v1/deals/{dealId}/threads/{threadId}/messages/{msgId}': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    const msg = await repo.getMessage(dealId, threadId, param(ctx, 'msgId'));
    if (!msg || msg.deletedAt) throw new HttpError(404, 'message not found');
    if (msg.authorId !== ctx.userId) throw new HttpError(403, 'only the author can edit a message');
    const { body } = parseBody(editMessageSchema, ctx.body ?? {});
    const updated = await repo.editMessage(dealId, threadId, msg, body);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'message.edited', detail: { dealId, threadId, msgId: msg.msgId, scope: thread.scope } },
    ]);
    return { body: { ...updated, history: undefined } };
  },

  'DELETE /v1/deals/{dealId}/threads/{threadId}/messages/{msgId}': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    const msg = await repo.getMessage(dealId, threadId, param(ctx, 'msgId'));
    if (!msg) throw new HttpError(404, 'message not found');
    if (msg.authorId !== ctx.userId) throw new HttpError(403, 'only the author can delete a message');
    await repo.softDeleteMessage(dealId, threadId, msg);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'message.deleted', detail: { dealId, threadId, msgId: msg.msgId, scope: thread.scope } },
    ]);
    return { body: { deleted: true } };
  },

  'POST /v1/deals/{dealId}/threads/{threadId}/read': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    const mv = await requireViewer(dealId, ctx.userId);
    const thread = await repo.getThread(dealId, threadId);
    if (!thread) throw new HttpError(404, 'thread not found');
    assertCanSee(mv, thread.scope);
    const msgs = await repo.listMessages(dealId, threadId);
    await repo.markRead(
      dealId,
      threadId,
      ctx.userId,
      msgs.map((m) => m.msgId),
    );
    return { body: { readTs: new Date().toISOString() } };
  },

  'GET /v1/deals/{dealId}/threads/{threadId}/messages/{msgId}/receipts': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const threadId = param(ctx, 'threadId');
    await requireViewer(dealId, ctx.userId);
    const msg = await repo.getMessage(dealId, threadId, param(ctx, 'msgId'));
    if (!msg) throw new HttpError(404, 'message not found');
    if (msg.authorId !== ctx.userId) throw new HttpError(403, 'only the author sees receipts');
    const receipts = await repo.listReceipts(dealId, msg.msgId);
    const rollup =
      receipts.length === 0
        ? 'sent'
        : receipts.every((r) => r.readAt)
          ? 'read'
          : receipts.every((r) => r.deliveredAt)
            ? 'received'
            : 'sent';
    return { body: { rollup, recipients: receipts } };
  },

  'GET /v1/deals/{dealId}/activity': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    await requireViewer(dealId, ctx.userId);
    return { body: { activity: await repo.listFeed(dealId) } };
  },
});
