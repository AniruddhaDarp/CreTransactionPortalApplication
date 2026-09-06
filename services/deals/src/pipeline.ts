export interface StageDef {
  n: number;
  key: string;
  name: string;
}

/** The fixed, forward-only commercial-purchase pipeline. */
export const STAGES: readonly StageDef[] = [
  { n: 1, key: 'psa_negotiation', name: 'Offer Accepted / PSA Negotiation' },
  { n: 2, key: 'attorney_review', name: 'Attorney Review' },
  { n: 3, key: 'due_diligence', name: 'Due Diligence' },
  { n: 4, key: 'financing', name: 'Financing' },
  { n: 5, key: 'title_survey', name: 'Title & Survey' },
  { n: 6, key: 'closing', name: 'Closing' },
];

export const LAST_STAGE = STAGES.length; // 6
/** Completing this stage flips the deal's `firm` flag. */
export const ATTORNEY_REVIEW_STAGE = 2;

/** Default checklist items materialized the first time a stage's list is read. */
export const CHECKLIST_TEMPLATES: Record<number, readonly string[]> = {
  1: ['Draft PSA', 'Negotiate business terms', 'Post earnest-money deposit', 'Execute PSA'],
  2: [
    'Buyer counsel reviews contract',
    'Seller counsel reviews contract',
    'Finalize reps & warranties',
    'Confirm proration mechanics',
  ],
  3: [
    'Order Phase I environmental',
    'Property condition assessment',
    'Review leases & estoppels',
    'Review service contracts',
    'Financial / rent-roll review',
    'Zoning confirmation',
  ],
  4: [
    'Submit loan application',
    'Order lender appraisal',
    'Clear underwriting conditions',
    'Obtain clear-to-close',
  ],
  5: [
    'Order title commitment',
    'Order ALTA survey',
    'Review title exceptions',
    'Resolve / insure over defects',
  ],
  6: [
    'Prepare settlement statement',
    'Wire funds to escrow',
    'Execute & record deed',
    'Post-closing: tenant notices & deposit transfers',
  ],
};

export function stageDef(n: number): StageDef {
  const s = STAGES[n - 1];
  if (!s) throw new Error(`invalid stage number: ${n}`);
  return s;
}
