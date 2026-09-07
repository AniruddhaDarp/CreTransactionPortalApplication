import {
  can,
  capabilitiesFor,
  inviteActionFor,
  inviteLimits,
  sideOf,
  type Role,
} from '@cre/authz';
import { roleSchema, sideSchema } from '@cre/events';
import { HttpError, parseBody, router, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import { buildCtx } from './context.js';
import * as handshake from './handshake.js';
import { handshakeRoutes } from './handshakes.js';
import { paymentRoutes } from './payments.js';
import type { DealMeta } from './repo.js';
import * as repo from './repo.js';
import { emit, param, requireMember, WEB_ORIGIN } from './shared.js';
import { stageRoutes } from './stages.js';

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const PROPERTY_TYPES = [
  'office',
  'retail',
  'industrial',
  'multifamily',
  'land',
  'residential',
] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const createDealSchema = z.object({
  address: z.string().min(3).max(200),
  propertyType: z.enum(PROPERTY_TYPES),
  label: z.string().max(80).optional(),
  price: z.number().positive(),
  earnestMoney: z.number().nonnegative().optional(),
  targetClosingDate: isoDate.optional(),
  description: z.string().max(2000).optional(),
});

const patchDealSchema = z
  .object({
    address: z.string().min(3).max(200),
    propertyType: z.enum(PROPERTY_TYPES),
    label: z.string().max(80),
    description: z.string().max(2000),
  })
  .partial();

const statusSchema = z.object({
  status: z.enum(['CLOSED', 'CANCELLED']),
  reason: z.string().max(500).optional(),
});

const termsSchema = z
  .object({ price: z.number().positive().optional(), targetClosingDate: isoDate.optional() })
  .refine((v) => (v.price === undefined) !== (v.targetClosingDate === undefined), {
    message: 'provide exactly one of price or targetClosingDate',
  });

const inviteSchema = z
  .object({ email: z.string().email(), role: roleSchema, side: sideSchema.optional() })
  .refine((v) => v.role !== 'OTHER' || (v.side === 'buy' || v.side === 'sell'), {
    message: 'an OTHER invitation needs side "buy" or "sell"',
  });

const memberPatchSchema = z.object({ role: roleSchema });

// --- helpers ---------------------------------------------------------------

function diff(before: DealMeta, patch: Record<string, unknown>) {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const prev = before as unknown as Record<string, unknown>;
  for (const [k, to] of Object.entries(patch)) {
    const from = prev[k] ?? null;
    if (from !== to) changed[k] = { from, to };
  }
  return changed;
}

// --- routes --------------------------------------------------------------

const dealRoutes: Record<string, RouteHandler> = {
  'POST /v1/deals': async (ctx) => {
    const input = parseBody(createDealSchema, ctx.body ?? {});
    const dealId = crypto.randomUUID();
    const { deal, membership } = await repo.createDeal({ dealId, ...input, createdBy: ctx.userId });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'deal.created',
        detail: {
          dealId,
          createdBy: ctx.userId,
          address: input.address,
          propertyType: input.propertyType,
        },
      },
      {
        type: 'member.joined',
        detail: { dealId, userId: ctx.userId, role: 'SELLER_AGENT', side: 'sell' },
      },
    ]);
    return { status: 201, body: { ...deal, membership } };
  },

  'GET /v1/deals': async (ctx) => ({ body: { deals: await repo.listMyDeals(ctx.userId) } }),

  'GET /v1/deals/{dealId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    return {
      body: { ...deal, membership, capabilities: capabilitiesFor(buildCtx(deal, membership)) },
    };
  },

  'PATCH /v1/deals/{dealId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    if (!can('editDealFields', buildCtx(deal, membership))) {
      throw new HttpError(403, 'only the deal admin may edit these fields');
    }
    const patch = parseBody(patchDealSchema, ctx.body ?? {});
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'no fields to update');
    const changed = diff(deal, patch);
    const updated = await repo.updateDealFields(deal.dealId, patch);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      { type: 'deal.updated', detail: { dealId: deal.dealId, changed } },
    ]);
    return { body: updated };
  },

  'POST /v1/deals/{dealId}/status': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    if (!can('changeDealStatus', authz)) {
      throw new HttpError(403, 'not allowed to change this deal’s status');
    }
    if (deal.status !== 'ACTIVE') throw new HttpError(409, `deal is already ${deal.status}`);
    const { status, reason } = parseBody(statusSchema, ctx.body ?? {});

    if (authz.isFirm) {
      // firm deal: closing/cancelling needs the counterparty's approval
      const { hs, event } = await handshake.initiate({
        deal,
        authz,
        action: status === 'CLOSED' ? 'close_deal' : 'cancel_deal',
        payload: { reason },
        actorId: ctx.userId,
      });
      await emit(deal.dealId, ctx.correlationId, ctx.userId, [event]);
      return {
        status: 202,
        body: { handshakeId: hs.hsId, action: hs.action, status: 'pending' },
      };
    }

    const updated = await repo.setDealStatus(
      deal.dealId,
      status,
      status === 'CLOSED' ? new Date().toISOString().slice(0, 10) : undefined,
    );
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      { type: 'deal.status_changed', detail: { dealId: deal.dealId, status, reason } },
    ]);
    return { body: updated };
  },

  'POST /v1/deals/{dealId}/terms': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    const input = parseBody(termsSchema, ctx.body ?? {});

    if (input.price !== undefined) {
      // a price change is always a handshake
      const { hs, event } = await handshake.initiate({
        deal,
        authz,
        action: 'edit_price',
        payload: { price: input.price },
        actorId: ctx.userId,
      });
      await emit(deal.dealId, ctx.correlationId, ctx.userId, [event]);
      return { status: 202, body: { handshakeId: hs.hsId, action: 'edit_price', status: 'pending' } };
    }

    // targetClosingDate: admin-unilateral pre-firm, handshake once firm
    if (deal.firm) {
      const { hs, event } = await handshake.initiate({
        deal,
        authz,
        action: 'edit_dates',
        payload: { targetClosingDate: input.targetClosingDate },
        actorId: ctx.userId,
      });
      await emit(deal.dealId, ctx.correlationId, ctx.userId, [event]);
      return { status: 202, body: { handshakeId: hs.hsId, action: 'edit_dates', status: 'pending' } };
    }
    if (!can('editDates', authz)) throw new HttpError(403, 'not allowed to change the closing date');
    const updated = await repo.updateDealFields(deal.dealId, {
      targetClosingDate: input.targetClosingDate,
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'deal.updated',
        detail: {
          dealId: deal.dealId,
          changed: {
            targetClosingDate: {
              from: deal.targetClosingDate ?? null,
              to: input.targetClosingDate,
            },
          },
        },
      },
    ]);
    return { body: updated };
  },

  'GET /v1/deals/{dealId}/dashboard': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const members = await repo.listMembers(deal.dealId);
    const daysToClosing = deal.targetClosingDate
      ? Math.ceil((Date.parse(deal.targetClosingDate) - Date.now()) / 86_400_000)
      : null;
    return {
      body: {
        deal,
        members,
        milestone: { currentStage: deal.currentStage, firm: deal.firm, status: deal.status },
        daysToClosing,
        activityFeed: [], // populated once the Chat service lands (Module 6)
      },
    };
  },

  'GET /v1/deals/{dealId}/members': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    return { body: { members: await repo.listMembers(deal.dealId) } };
  },

  'GET /v1/deals/{dealId}/invites': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    if (!can('inviteSellSide', authz) && !can('inviteBuySide', authz)) {
      throw new HttpError(403, 'not allowed to view invitations');
    }
    const invites = (await repo.listInvites(deal.dealId)).filter((i) => i.status === 'pending');
    return { body: { invites } };
  },

  'POST /v1/deals/{dealId}/invites': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const input = parseBody(inviteSchema, ctx.body ?? {});
    const email = input.email.toLowerCase();
    const targetSide = input.role === 'OTHER' ? input.side! : sideOf(input.role);
    const authz = buildCtx(deal, membership, targetSide);

    if (!can(inviteActionFor(input.role), authz)) {
      throw new HttpError(403, `not allowed to invite a ${input.role}`);
    }
    if (targetSide === 'buy') {
      const limit = inviteLimits(await repo.listBuySideRoster(deal.dealId), input.role);
      if (!limit.ok) throw new HttpError(409, limit.reason ?? 'buy-side limit reached');
    }
    const dupe = (await repo.listInvites(deal.dealId)).some(
      (i) => i.status === 'pending' && i.email === email,
    );
    if (dupe) throw new HttpError(409, 'a pending invitation already exists for that email');

    const token = crypto.randomUUID();
    const now = new Date();
    await repo.putInvite({
      dealId: deal.dealId,
      token,
      email,
      role: input.role,
      side: targetSide,
      invitedBy: ctx.userId,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    });
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'member.invited',
        detail: {
          dealId: deal.dealId,
          email,
          role: input.role,
          side: targetSide,
          invitedBy: ctx.userId,
          token,
        },
      },
    ]);
    return {
      status: 201,
      body: {
        token,
        acceptUrl: `${WEB_ORIGIN()}/accept/${deal.dealId}/${token}`,
        email,
        role: input.role,
        side: targetSide,
      },
    };
  },

  'DELETE /v1/deals/{dealId}/invites/{token}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const invite = await repo.getInvite(deal.dealId, param(ctx, 'token'));
    if (!invite || invite.status !== 'pending') {
      throw new HttpError(404, 'no pending invitation with that token');
    }
    if (!can(inviteActionFor(invite.role), buildCtx(deal, membership, invite.side))) {
      throw new HttpError(403, 'not allowed to revoke this invitation');
    }
    await repo.revokeInvite(deal.dealId, invite.token);
    return { body: { revoked: true } };
  },

  'GET /v1/deals/{dealId}/invites/{token}': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const invite = await repo.getInvite(dealId, param(ctx, 'token'));
    if (!invite) throw new HttpError(404, 'invitation not found');
    if (String(ctx.claims.email ?? '').toLowerCase() !== invite.email) {
      throw new HttpError(403, 'this invitation is for a different email address');
    }
    const deal = await repo.getDeal(dealId);
    return {
      body: {
        dealId,
        dealAddress: deal?.address ?? null,
        role: invite.role,
        side: invite.side,
        status: invite.status,
        expired: Date.parse(invite.expiresAt) < Date.now(),
      },
    };
  },

  'POST /v1/deals/{dealId}/invites/{token}/accept': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const invite = await repo.getInvite(dealId, param(ctx, 'token'));
    if (!invite) throw new HttpError(404, 'invitation not found');
    if (String(ctx.claims.email ?? '').toLowerCase() !== invite.email) {
      throw new HttpError(403, 'this invitation is for a different email address');
    }
    const existing = await repo.getMembership(dealId, ctx.userId);
    if (existing && existing.status === 'active') return { body: existing };
    if (invite.status === 'revoked') throw new HttpError(409, 'this invitation was revoked');
    if (invite.status === 'accepted') throw new HttpError(409, 'this invitation was already used');
    if (Date.parse(invite.expiresAt) < Date.now()) throw new HttpError(410, 'this invitation has expired');

    const membership = await repo.acceptInvite({
      dealId,
      token: invite.token,
      userId: ctx.userId,
      role: invite.role,
      side: invite.side,
      invitedBy: invite.invitedBy,
    });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'member.joined',
        detail: { dealId, userId: ctx.userId, role: invite.role, side: invite.side },
      },
    ]);
    return { status: 201, body: membership };
  },

  'PATCH /v1/deals/{dealId}/members/{userId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const targetUserId = param(ctx, 'userId');
    const target = await repo.getMembership(deal.dealId, targetUserId);
    if (!target || target.status !== 'active') throw new HttpError(404, 'no such active member');
    if (targetUserId === deal.createdBy) {
      throw new HttpError(409, 'the deal creator’s role cannot be changed');
    }
    const { role: newRole } = parseBody(memberPatchSchema, ctx.body ?? {});
    if (newRole === 'OTHER') throw new HttpError(400, 'cannot change a member to OTHER');
    const newSide = sideOf(newRole);
    const okCurrent = can('changeMemberRole', buildCtx(deal, membership, target.side));
    const okNew = can('changeMemberRole', buildCtx(deal, membership, newSide));
    if (!okCurrent || !okNew) throw new HttpError(403, 'not allowed to change this member’s role');
    if (newSide === 'buy') {
      const limit = inviteLimits(await repo.listBuySideRoster(deal.dealId), newRole);
      if (!limit.ok) throw new HttpError(409, limit.reason ?? 'buy-side limit reached');
    }
    const updated = await repo.updateMemberRole(deal.dealId, targetUserId, newRole, newSide);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'member.role_changed',
        detail: { dealId: deal.dealId, userId: targetUserId, from: target.role, to: newRole as Role },
      },
    ]);
    return { body: updated };
  },

  'DELETE /v1/deals/{dealId}/members/{userId}': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const targetUserId = param(ctx, 'userId');
    if (targetUserId === deal.createdBy) throw new HttpError(409, 'the deal creator cannot be removed');
    if (targetUserId === ctx.userId) throw new HttpError(409, 'you cannot remove yourself');
    const target = await repo.getMembership(deal.dealId, targetUserId);
    if (!target || target.status !== 'active') throw new HttpError(404, 'no such active member');
    if (!can('removeMember', buildCtx(deal, membership, target.side))) {
      throw new HttpError(403, 'not allowed to remove this member');
    }
    await repo.removeMember(deal.dealId, targetUserId);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'member.removed',
        detail: { dealId: deal.dealId, userId: targetUserId, removedBy: ctx.userId },
      },
    ]);
    return { body: { removed: true } };
  },
};

export const handler = router({
  ...dealRoutes,
  ...stageRoutes,
  ...handshakeRoutes,
  ...paymentRoutes,
});
