import { isAgent, isAttorney, type MembershipStatus, type Role, type Scope, type Side } from './roles.js';

export interface ScopeMembership {
  role: Role;
  side: Side;
  status: MembershipStatus;
}

/**
 * The set of visibility scopes an active member can see. Drives filtering of
 * every thread / document / audit list from Module 6 onward.
 *
 * - every active member sees `deal_wide`
 * - buy/sell members also see their own `side_private:*`
 * - the two agents also see `channel:agent`; the two attorneys `channel:attorney`
 * - `TITLE_AGENT` (neutral) sees `deal_wide` only
 * - `OTHER` sees `deal_wide` (read) + its own side's `side_private:*`, no channels
 */
export function visibleScopes(m: ScopeMembership): Set<Scope> {
  const scopes = new Set<Scope>();
  if (m.status !== 'active') return scopes;

  scopes.add('deal_wide');
  if (m.side === 'buy') scopes.add('side_private:buy');
  if (m.side === 'sell') scopes.add('side_private:sell');
  if (isAgent(m.role)) scopes.add('channel:agent');
  if (isAttorney(m.role)) scopes.add('channel:attorney');
  return scopes;
}

export function canSee(m: ScopeMembership, resourceScope: Scope): boolean {
  return visibleScopes(m).has(resourceScope);
}
