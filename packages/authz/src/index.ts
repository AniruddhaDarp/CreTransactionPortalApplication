/**
 * @cre/authz — pure authorization library, bundled into every service.
 *
 * This module has **no I/O**. Services pass in a caller's membership plus a
 * resource descriptor and get a boolean. The full capability matrix
 * (`can(role, action, context)`) and scope resolution (`visibleScopes`,
 * `canSee`) land in Module 4 (Deals core); this skeleton fixes the shared
 * vocabulary the rest of the system builds on.
 */

export type Role =
  | 'SELLER_AGENT'
  | 'SELLER'
  | 'SELLER_ATTORNEY'
  | 'BUYER'
  | 'BUYER_AGENT'
  | 'BUYER_ATTORNEY'
  | 'LENDER'
  | 'TITLE_AGENT'
  | 'OTHER';

export type Side = 'buy' | 'sell' | 'neutral';

/** Visibility scope for a thread, document, or audit entry. */
export type Scope =
  | 'deal_wide'
  | 'side_private:buy'
  | 'side_private:sell'
  | 'channel:agent'
  | 'channel:attorney';

/** Fixed side for every role except OTHER, which is assigned a side on invite. */
export const ROLE_SIDE: Record<Exclude<Role, 'OTHER'>, Side> = {
  SELLER_AGENT: 'sell',
  SELLER: 'sell',
  SELLER_ATTORNEY: 'sell',
  BUYER: 'buy',
  BUYER_AGENT: 'buy',
  BUYER_ATTORNEY: 'buy',
  LENDER: 'buy',
  TITLE_AGENT: 'neutral',
};

export function sideOf(role: Role, otherSide?: Side): Side {
  if (role === 'OTHER') {
    if (!otherSide) throw new Error('OTHER role requires an explicit side');
    return otherSide;
  }
  return ROLE_SIDE[role];
}
