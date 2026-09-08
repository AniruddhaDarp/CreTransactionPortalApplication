/** Human-readable names for membership role tokens (e.g. BUYER_AGENT -> "Buyer's Agent"). Pure. */
const ROLE_LABELS: Record<string, string> = {
  SELLER: 'Seller',
  SELLER_AGENT: "Seller's Agent",
  SELLER_ATTORNEY: "Seller's Attorney",
  BUYER: 'Buyer',
  BUYER_AGENT: "Buyer's Agent",
  BUYER_ATTORNEY: "Buyer's Attorney",
  LENDER: 'Lender',
  TITLE_AGENT: 'Title Agent',
  OTHER: 'Third Party',
};

/** "BUYER_AGENT" -> "Buyer's Agent"; unknown tokens are title-cased; empty in, empty out. */
export function roleLabel(role: string | undefined | null): string {
  if (!role) return '';
  return (
    ROLE_LABELS[role] ??
    role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Whether a member (by side + role) is a participant of a thread/document scope —
 * the client-side mirror of `@cre/authz` `visibleScopes`. Used to limit who is
 * mentionable in a thread.
 */
export function memberInScope(side: string, role: string, scope: string): boolean {
  switch (scope) {
    case 'deal_wide':
      return true;
    case 'side_private:buy':
      return side === 'buy';
    case 'side_private:sell':
      return side === 'sell';
    case 'channel:agent':
      return role === 'BUYER_AGENT' || role === 'SELLER_AGENT';
    case 'channel:attorney':
      return role === 'BUYER_ATTORNEY' || role === 'SELLER_ATTORNEY';
    default:
      return true;
  }
}

/** Document categories the sell side (and title agent) can never see, even deal-wide. */
export const SELL_BLIND_CATEGORIES = ['Financing', 'Appraisal'];

/**
 * A `delete_document` handshake the counterparty side can't review — because the
 * document is side-private, or its category is hidden from them. Such deletes are
 * approved by the *initiating* side's own second lead, not the counterparty.
 */
export function isSameSideDelete(h: {
  action: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (h.action !== 'delete_document') return false;
  const scope = String(h.payload?.scope ?? '');
  const category = String(h.payload?.category ?? '');
  return scope.startsWith('side_private') || SELL_BLIND_CATEGORIES.includes(category);
}
