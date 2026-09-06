import type { AuthzContext } from '@cre/authz';
import { HttpError, publish, type RequestContext } from '@cre/platform';
import type { MemberView } from './repo.js';

export const BUS = () => process.env.EVENT_BUS_NAME ?? '';

export const param = (ctx: RequestContext, name: string): string => {
  const v = ctx.pathParams[name];
  if (!v) throw new HttpError(400, `missing path parameter: ${name}`);
  return v;
};

/** Minimal authz context — chat actions only care about role / side / status. */
export function authzCtx(mv: MemberView): AuthzContext {
  return {
    role: mv.role,
    side: mv.side,
    status: mv.status,
    isAdmin: false,
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
      service: 'chat',
      type: e.type,
      correlationId,
      actorId,
      dealId,
      detail: e.detail,
    })),
  );
}
