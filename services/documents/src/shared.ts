import type { AuthzContext } from '@cre/authz';
import { HttpError, publish, type RequestContext } from '@cre/platform';
import type { Viewer } from './scope.js';

export const BUS = () => process.env.EVENT_BUS_NAME ?? '';

export const param = (ctx: RequestContext, name: string): string => {
  const v = ctx.pathParams[name];
  if (!v) throw new HttpError(400, `missing path parameter: ${name}`);
  return v;
};

/**
 * The Documents service only has the local `MEMBERVIEW` projection (role / side /
 * status), not the deal record, so it can't know `isFirm` / `currentStage` or
 * which SELLER_AGENT is the creator. For the capabilities this service checks
 * (`deleteDocument`, `promoteDocument`, `createDocRequest`) only `isAdmin`
 * matters, and treating any SELLER_AGENT as admin is a safe over-approximation:
 * the delete handshake is re-authorized authoritatively by the Deals consumer
 * (which does have the deal) before anything is archived.
 */
export function authzCtx(v: Viewer): AuthzContext {
  return {
    role: v.role,
    side: v.side,
    status: v.status,
    isAdmin: v.role === 'SELLER_AGENT',
    isFirm: false,
    currentStage: 1,
  };
}

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
      service: 'documents',
      type: e.type,
      correlationId,
      actorId,
      dealId,
      detail: e.detail,
    })),
  );
}
