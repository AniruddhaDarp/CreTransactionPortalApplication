import type { AuthzContext, Side } from '@cre/authz';
import type { DealMeta, Membership } from './repo.js';

/** Build the authorization context for a caller acting on a deal. */
export function buildCtx(deal: DealMeta, m: Membership, targetSide?: Side): AuthzContext {
  return {
    role: m.role,
    side: m.side,
    status: m.status,
    isAdmin: m.role === 'SELLER_AGENT' && m.userId === deal.createdBy,
    isFirm: deal.firm,
    currentStage: deal.currentStage,
    targetSide,
  };
}
