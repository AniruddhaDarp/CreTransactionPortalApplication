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

export const ROLES: readonly Role[] = [
  'SELLER_AGENT',
  'SELLER',
  'SELLER_ATTORNEY',
  'BUYER',
  'BUYER_AGENT',
  'BUYER_ATTORNEY',
  'LENDER',
  'TITLE_AGENT',
  'OTHER',
];

export type Side = 'buy' | 'sell' | 'neutral';

export type MembershipStatus = 'invited' | 'active' | 'removed';

/** Visibility scope of a thread, document, or audit entry. */
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

export function sideOf(role: Role, assignedSide?: Side): Side {
  if (role === 'OTHER') {
    if (!assignedSide) throw new Error('OTHER role requires an explicit side');
    return assignedSide;
  }
  return ROLE_SIDE[role];
}

export const isAgent = (role: Role): boolean =>
  role === 'BUYER_AGENT' || role === 'SELLER_AGENT';

export const isAttorney = (role: Role): boolean =>
  role === 'BUYER_ATTORNEY' || role === 'SELLER_ATTORNEY';

/** Buyer or buyer's agent — either can act as the buy-side handshake lead. */
export const isBuySideLead = (role: Role): boolean =>
  role === 'BUYER' || role === 'BUYER_AGENT';
