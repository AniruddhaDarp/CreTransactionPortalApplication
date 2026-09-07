import { can } from '@cre/authz';
import { HttpError, parseBody, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import { buildCtx } from './context.js';
import * as handshake from './handshake.js';
import * as repo from './repo.js';
import { emit, param, requireMember } from './shared.js';

/**
 * Payments (Module 11, stretch) — *recording* money movements, not moving them.
 * A deal lead records a payment (`status: recorded`); the same call opens a
 * `confirm_payment` handshake so the counterparty lead confirms it happened
 * (`status: confirmed`). Voiding a payment — `recorded` or `confirmed` — always
 * goes through a `void_payment` handshake. Payments are `deal_wide`: every
 * active member can list them.
 */

const KINDS = [
  'earnest_money',
  'additional_deposit',
  'closing_funds',
  'extension_fee',
  'other',
] as const;
const METHODS = ['wire', 'check', 'ach', 'other'] as const;
const PARTIES = ['buyer', 'seller', 'escrow', 'lender', 'other'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const recordSchema = z.object({
  kind: z.enum(KINDS),
  amount: z.number().positive(),
  method: z.enum(METHODS),
  payer: z.enum(PARTIES).optional(),
  payee: z.enum(PARTIES).optional(),
  reference: z.string().max(120).optional(),
  paidOn: isoDate,
  note: z.string().max(1000).optional(),
});

const voidSchema = z.object({ reason: z.string().max(500).optional() });

async function assertNoPendingHs(dealId: string, hsId: string | undefined, label: string) {
  if (!hsId) return;
  const existing = await repo.getHandshake(dealId, hsId);
  if (existing && existing.status === 'pending') {
    throw new HttpError(409, `a ${label} handshake is already pending for this payment`);
  }
}

export const paymentRoutes: Record<string, RouteHandler> = {
  'GET /v1/deals/{dealId}/payments': async (ctx) => {
    const { deal } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    return { body: { payments: await repo.listPayments(deal.dealId) } };
  },

  'POST /v1/deals/{dealId}/payments': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    if (!can('recordPayment', authz)) throw new HttpError(403, 'not allowed to record payments');
    if (deal.status !== 'ACTIVE') throw new HttpError(409, `deal is ${deal.status}`);

    const input = parseBody(recordSchema, ctx.body ?? {});
    const payer = input.payer ?? 'buyer';
    const payee = input.payee ?? 'escrow';
    const payId = crypto.randomUUID();
    const now = new Date().toISOString();
    const payment: repo.Payment = {
      dealId: deal.dealId,
      payId,
      kind: input.kind,
      amount: input.amount,
      method: input.method,
      payer,
      payee,
      reference: input.reference,
      paidOn: input.paidOn,
      note: input.note,
      status: 'recorded',
      recordedBy: ctx.userId,
      recordedAt: now,
    };
    await repo.putPayment(payment);

    // Open the confirm handshake. If the counterparty side isn't on the deal yet
    // this throws 409 and leaves an unconfirmed `recorded` payment — POST
    // .../confirm re-opens the handshake once they join (see docs/02-design.md §17).
    const { hs, event } = await handshake.initiate({
      deal,
      authz,
      action: 'confirm_payment',
      payload: { payId, kind: input.kind, amount: input.amount },
      actorId: ctx.userId,
    });
    await repo.setPaymentHs(deal.dealId, payId, 'confirmHsId', hs.hsId);

    await emit(deal.dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'payment.recorded',
        detail: {
          dealId: deal.dealId,
          payId,
          kind: input.kind,
          amount: input.amount,
          method: input.method,
          payer,
          payee,
          recordedBy: ctx.userId,
          scope: 'deal_wide',
        },
      },
      event,
    ]);
    return { status: 201, body: { ...payment, confirmHsId: hs.hsId } };
  },

  'POST /v1/deals/{dealId}/payments/{payId}/confirm': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    if (!can('recordPayment', authz)) throw new HttpError(403, 'not allowed to confirm payments');

    const payId = param(ctx, 'payId');
    const pay = await repo.getPayment(deal.dealId, payId);
    if (!pay) throw new HttpError(404, 'payment not found');
    if (pay.status !== 'recorded') throw new HttpError(409, `payment is already ${pay.status}`);
    await assertNoPendingHs(deal.dealId, pay.confirmHsId, 'confirmation');

    const { hs, event } = await handshake.initiate({
      deal,
      authz,
      action: 'confirm_payment',
      payload: { payId, kind: pay.kind, amount: pay.amount },
      actorId: ctx.userId,
    });
    await repo.setPaymentHs(deal.dealId, payId, 'confirmHsId', hs.hsId);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [event]);
    return { status: 202, body: { handshakeId: hs.hsId, action: 'confirm_payment', status: 'pending' } };
  },

  'POST /v1/deals/{dealId}/payments/{payId}/void': async (ctx) => {
    const { deal, membership } = await requireMember(param(ctx, 'dealId'), ctx.userId);
    const authz = buildCtx(deal, membership);
    if (!can('voidPayment', authz)) throw new HttpError(403, 'not allowed to void payments');

    const payId = param(ctx, 'payId');
    const pay = await repo.getPayment(deal.dealId, payId);
    if (!pay) throw new HttpError(404, 'payment not found');
    if (pay.status === 'void') throw new HttpError(409, 'payment is already void');
    await assertNoPendingHs(deal.dealId, pay.voidHsId, 'void');

    const { reason } = parseBody(voidSchema, ctx.body ?? {});
    const { hs, event } = await handshake.initiate({
      deal,
      authz,
      action: 'void_payment',
      payload: { payId, reason },
      actorId: ctx.userId,
    });
    await repo.setPaymentHs(deal.dealId, payId, 'voidHsId', hs.hsId);
    await emit(deal.dealId, ctx.correlationId, ctx.userId, [event]);
    return { status: 202, body: { handshakeId: hs.hsId, action: 'void_payment', status: 'pending' } };
  },
};
