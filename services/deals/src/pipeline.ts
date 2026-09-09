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

export function stageDef(n: number): StageDef {
  const s = STAGES[n - 1];
  if (!s) throw new Error(`invalid stage number: ${n}`);
  return s;
}
