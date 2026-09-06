import type { Role, Scope, Side } from './roles.js';
import { canSee, type ScopeMembership } from './scope.js';

export type DocumentCategory =
  | 'Purchase Agreement'
  | 'Disclosure'
  | 'Inspection'
  | 'Title'
  | 'Financing'
  | 'Appraisal'
  | 'Closing'
  | 'Other';

export const DOCUMENT_CATEGORIES: readonly DocumentCategory[] = [
  'Purchase Agreement',
  'Disclosure',
  'Inspection',
  'Title',
  'Financing',
  'Appraisal',
  'Closing',
  'Other',
];

// The design §6 "starting matrix", keyed by role-group.
const HIDDEN_FROM_LENDER = new Set<DocumentCategory>(['Inspection']);
const HIDDEN_FROM_TITLE = new Set<DocumentCategory>(['Inspection', 'Financing', 'Appraisal']);
const HIDDEN_FROM_SELL = new Set<DocumentCategory>(['Financing', 'Appraisal']);

/**
 * Whether a role/side may see documents of `category` at `docScope` — the
 * category half of the check (combine with `canSee` for the scope half).
 */
export function categoryVisible(
  role: Role,
  side: Side,
  category: DocumentCategory,
  docScope: Scope,
): boolean {
  if (role === 'OTHER') return true; // scope-only; the scope check does the work
  if (role === 'TITLE_AGENT') return !HIDDEN_FROM_TITLE.has(category);
  if (role === 'LENDER') return !HIDDEN_FROM_LENDER.has(category);
  if (side === 'sell') {
    if (HIDDEN_FROM_SELL.has(category)) return false;
    if (category === 'Inspection' && docScope !== 'deal_wide') return false;
    return true;
  }
  return true; // buy-side, non-lender
}

/** Full document visibility: scope AND category. */
export function canSeeDocument(
  m: ScopeMembership,
  docScope: Scope,
  category: DocumentCategory,
): boolean {
  return canSee(m, docScope) && categoryVisible(m.role, m.side, category, docScope);
}
