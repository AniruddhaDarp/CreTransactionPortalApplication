import type { MembershipStatus, Role, Scope, Side } from '@cre/authz';
import { visibleScopes } from '@cre/authz';
import { getMemberView, HttpError } from '@cre/platform';
import { membershipTableName } from './repo.js';

export interface Viewer {
  userId: string;
  role: Role;
  side: Side;
  status: MembershipStatus;
}

const KNOWN_SCOPES = new Set<Scope>([
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
]);

/**
 * Every auditable event now carries its own visibility scope: chat threads /
 * messages and every document / doc-request event include `scope` (or `toScope`
 * for a conversion); deal-, member-, stage- and handshake-domain events are
 * inherently `deal_wide`. The producer is authoritative — we never guess.
 */
export function deriveScope(detail: Record<string, unknown>): Scope {
  const s = (detail.scope ?? detail.toScope) as string | undefined;
  return s && KNOWN_SCOPES.has(s as Scope) ? (s as Scope) : 'deal_wide';
}

export async function requireViewer(dealId: string, userId: string): Promise<Viewer> {
  const mv = await getMemberView(membershipTableName(), dealId, userId);
  if (!mv || mv.status !== 'active') {
    throw new HttpError(403, 'not an active member of this deal (membership may not be synced yet)');
  }
  return { userId, role: mv.role as Role, side: mv.side as Side, status: mv.status };
}

/** The scopes this viewer's audit rows may include — no god view: the sell-side
 *  admin never receives `side_private:buy` or a channel they're not in. */
export function viewerScopes(v: Viewer): Set<Scope> {
  return visibleScopes({ role: v.role, side: v.side, status: v.status });
}
