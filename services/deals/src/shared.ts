import { HttpError, publish, type RequestContext } from '@cre/platform';
import type { DealMeta, Membership } from './repo.js';
import * as repo from './repo.js';

export const BUS = () => process.env.EVENT_BUS_NAME ?? '';
export const WEB_ORIGIN = () => process.env.WEB_ORIGIN ?? '';

export async function requireMember(
  dealId: string,
  userId: string,
): Promise<{ deal: DealMeta; membership: Membership }> {
  const deal = await repo.getDeal(dealId);
  if (!deal) throw new HttpError(404, 'deal not found');
  const membership = await repo.getMembership(dealId, userId);
  if (!membership || membership.status !== 'active') {
    throw new HttpError(403, 'not an active member of this deal');
  }
  return { deal, membership };
}

/** Reject a mutating request once the deal is CLOSED / CANCELLED (read-only record). */
export function assertActive(deal: DealMeta): void {
  if (deal.status !== 'ACTIVE') {
    throw new HttpError(409, `the deal is ${deal.status.toLowerCase()} — the workspace is read-only`);
  }
}

export const param = (ctx: RequestContext, name: string): string => {
  const v = ctx.pathParams[name];
  if (!v) throw new HttpError(400, `missing path parameter: ${name}`);
  return v;
};

export const stageNum = (ctx: RequestContext): number => {
  const n = Number(param(ctx, 'n'));
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new HttpError(400, 'stage must be 1..6');
  return n;
};

/** Publish `deals`-sourced events, filling in the common envelope fields. */
export async function emit(
  dealId: string,
  correlationId: string,
  actorId: string,
  events: Array<{ type: string; detail: Record<string, unknown> }>,
): Promise<void> {
  if (events.length === 0) return;
  await publish(
    BUS(),
    events.map((e) => ({
      service: 'deals',
      type: e.type,
      correlationId,
      actorId,
      dealId,
      detail: e.detail,
    })),
  );
}
