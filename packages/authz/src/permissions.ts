import {
  isAgent,
  isAttorney,
  isBuySideLead,
  isSellSideLead,
  ROLE_SIDE,
  type MembershipStatus,
  type Role,
  type Scope,
  type Side,
} from './roles.js';
import { canSeeDocument, type DocumentCategory } from './documents.js';

/**
 * Every authorization decision in the system. Actions in the "deal + membership"
 * group are fully implemented here (Module 4). Actions in the milestone /
 * communication / document groups carry a best-guess rule and a
 * `// refined in Module N` marker — the owning module tightens them.
 *
 * Handshake-gated actions (`editPurchasePrice`, `advanceMilestone`,
 * `deleteDocument`, and `editDates` / `changeDealStatus` once the deal is firm)
 * are never performed directly: `can()` answers "may this member *initiate* the
 * handshake", and the Deals service's handshake state machine gates execution.
 */
export type Action =
  // --- deal + membership (Module 4) ---
  | 'createDeal'
  | 'editDealFields'
  | 'editPurchasePrice'
  | 'editDates'
  | 'changeDealStatus'
  | 'inviteSellSide'
  | 'inviteBuySide'
  | 'inviteTitle'
  | 'inviteOther'
  | 'changeMemberRole'
  | 'removeMember'
  | 'viewAudit'
  // --- milestones (Module 5) ---
  | 'advanceMilestone'
  | 'editStageMeta'
  | 'editChecklist'
  // --- communication (refined in Module 6) ---
  | 'createThreadDealWide'
  | 'createThreadSidePrivate'
  | 'createChannelThread'
  | 'convertChannelThread'
  | 'deleteThread'
  | 'postMessage'
  // --- documents (refined in Module 7) ---
  | 'uploadDealWideDoc'
  | 'uploadSidePrivateDoc'
  | 'promoteDocument'
  | 'deleteDocument'
  | 'createDocRequest'
  | 'sendForSignature'
  // --- payments (Module 11, stretch) ---
  | 'recordPayment'
  | 'voidPayment';

export interface AuthzContext {
  role: Role;
  side: Side;
  /**
   * `role === 'SELLER_AGENT'` AND the deal's creator — the initial seat.
   * Informational only: authority is role-based (see `isSellSideLead` /
   * `isBuySideLead`), so a plain SELLER has the same rights as the SELLER_AGENT.
   */
  isAdmin: boolean;
  /** Attorney Review completed. */
  isFirm: boolean;
  /** 1..6 */
  currentStage: number;
  status: MembershipStatus;
  /** For `inviteOther` / `changeMemberRole` / `removeMember`: the target's side. */
  targetSide?: Side;
}

export function can(action: Action, ctx: AuthzContext): boolean {
  if (action === 'createDeal') return true; // any authenticated user; no membership

  if (ctx.status !== 'active') return false;

  const sellLead = isSellSideLead(ctx.role);
  const buyLead = isBuySideLead(ctx.role);
  const notOther = ctx.role !== 'OTHER';
  const managesSide = (s: Side | undefined): boolean =>
    s === 'buy' ? buyLead : s === 'sell' || s === 'neutral' ? sellLead : false;

  switch (action) {
    // --- deal fields ---
    case 'editDealFields':
      return sellLead; // the deal record is the seller's listing info
    case 'editPurchasePrice':
      return sellLead || buyLead; // always a handshake — "may initiate"
    case 'editDates':
      return ctx.isFirm ? sellLead || buyLead : sellLead;
    case 'changeDealStatus':
      return ctx.isFirm ? sellLead || buyLead : sellLead;

    // --- invitations ---
    case 'inviteSellSide':
    case 'inviteTitle':
      return sellLead;
    case 'inviteBuySide':
      // a sell-side lead bootstraps the buy side (there is no buy-side lead yet);
      // once a BUYER / BUYER_AGENT has joined they manage the rest of the roster.
      return sellLead || buyLead;
    case 'inviteOther':
      return managesSide(ctx.targetSide);

    // --- roster ---
    case 'changeMemberRole':
    case 'removeMember':
      return managesSide(ctx.targetSide);

    case 'viewAudit':
      return true; // results still filtered by scope at the query layer

    // --- milestones (Module 5) ---
    case 'advanceMilestone':
      return sellLead || buyLead; // "may initiate the advance handshake"
    case 'editStageMeta':
      return sellLead || buyLead; // stage notes / target dates
    case 'editChecklist':
      return notOther;

    // --- communication (refined in Module 6) ---
    case 'createThreadDealWide':
      return notOther;
    case 'createThreadSidePrivate':
      return true; // any active member of that side (incl. OTHER); side match checked by caller
    case 'createChannelThread':
    case 'convertChannelThread':
    case 'deleteThread':
      return isAgent(ctx.role) || isAttorney(ctx.role);
    case 'postMessage':
      return true; // OTHER only in a side-private thread — scope-checked by caller

    // --- documents (refined in Module 7) ---
    case 'uploadDealWideDoc':
      return notOther;
    case 'uploadSidePrivateDoc':
      return true;
    case 'promoteDocument':
      return notOther;
    case 'deleteDocument':
      return sellLead || buyLead; // "may initiate the delete handshake"
    case 'createDocRequest':
      return notOther;
    case 'sendForSignature':
      // any active non-OTHER member; the per-document scope + category check
      // (canSeeDocument) and per-signer visibility are enforced by the caller.
      return notOther;

    // --- payments (Module 11) — a lead records; the counterparty confirms/voids ---
    case 'recordPayment':
    case 'voidPayment':
      return sellLead || buyLead; // "may initiate the confirm / void handshake"

    default:
      return false;
  }
}

// --- buy-side roster limits -------------------------------------------------

export const BUY_SIDE_MAX = 7;
export const BUY_SIDE_MAX_AGENTS = 2;
export const BUY_SIDE_MAX_ATTORNEYS = 2;

export interface LimitCheck {
  ok: boolean;
  reason?: string;
}

/** Enforce ≤2 buy-side agents, ≤2 buy-side attorneys, ≤7 buy-side total. */
export function inviteLimits(
  existingBuySide: ReadonlyArray<{ role: Role; status: MembershipStatus }>,
  newRole: Role,
): LimitCheck {
  const counted = existingBuySide.filter((m) => m.status !== 'removed');
  if (counted.length >= BUY_SIDE_MAX) {
    return { ok: false, reason: `buy-side is capped at ${BUY_SIDE_MAX} members` };
  }
  if (
    newRole === 'BUYER_AGENT' &&
    counted.filter((m) => m.role === 'BUYER_AGENT').length >= BUY_SIDE_MAX_AGENTS
  ) {
    return { ok: false, reason: `buy-side is capped at ${BUY_SIDE_MAX_AGENTS} agents` };
  }
  if (
    newRole === 'BUYER_ATTORNEY' &&
    counted.filter((m) => m.role === 'BUYER_ATTORNEY').length >= BUY_SIDE_MAX_ATTORNEYS
  ) {
    return { ok: false, reason: `buy-side is capped at ${BUY_SIDE_MAX_ATTORNEYS} attorneys` };
  }
  return { ok: true };
}

/** Which `can()` action authorizes inviting a member with this role. */
export function inviteActionFor(role: Role): Action {
  if (role === 'TITLE_AGENT') return 'inviteTitle';
  if (role === 'OTHER') return 'inviteOther';
  return ROLE_SIDE[role] === 'sell' ? 'inviteSellSide' : 'inviteBuySide';
}

// --- handshake approval --------------------------------------------------

export type HandshakeAction =
  | 'advance_stage'
  | 'close_deal'
  | 'cancel_deal'
  | 'edit_price'
  | 'edit_dates'
  | 'delete_document'
  | 'delete_thread'
  | 'confirm_payment'
  | 'void_payment';

export const HANDSHAKE_ACTIONS: readonly HandshakeAction[] = [
  'advance_stage',
  'close_deal',
  'cancel_deal',
  'edit_price',
  'edit_dates',
  'delete_document',
  'delete_thread',
  'confirm_payment',
  'void_payment',
];

/** The side that must approve a handshake initiated by `initiatedSide`. */
export function handshakeApproverSide(initiatedSide: Side): Side {
  return initiatedSide === 'buy' ? 'sell' : 'buy';
}

/**
 * Whether this member may approve/reject a handshake initiated by
 * `initiatedSide`. The approver is a *lead* on the opposite side: a
 * `SELLER` / `SELLER_AGENT` on the sell side, a `BUYER` / `BUYER_AGENT` on the buy side.
 */
export function isHandshakeApprover(ctx: AuthzContext, initiatedSide: Side): boolean {
  if (ctx.status !== 'active') return false;
  return handshakeApproverSide(initiatedSide) === 'sell'
    ? isSellSideLead(ctx.role)
    : isBuySideLead(ctx.role);
}

/**
 * The side whose lead approves a handshake. Normally the counterparty, but
 * archiving a document the counterparty side **cannot see** — because of its
 * scope (side-private) *or* its category (e.g. Financing / Appraisal are hidden
 * from the sell side even deal-wide) — is approved by the *other lead on the
 * initiating side*. The counterparty has no basis to review a document it can't
 * open, and shouldn't be pulled into the decision.
 */
export function approverSideFor(
  action: HandshakeAction,
  initiatedSide: Side,
  scope?: string,
  category?: string,
): Side {
  const counterparty = handshakeApproverSide(initiatedSide);
  if (action !== 'delete_document') return counterparty;

  const counterpartyLead: Role = counterparty === 'sell' ? 'SELLER_AGENT' : 'BUYER_AGENT';
  const counterpartySeesIt = canSeeDocument(
    { role: counterpartyLead, side: counterparty, status: 'active' },
    (scope as Scope) || 'deal_wide',
    (category as DocumentCategory) || 'Other',
  );
  return counterpartySeesIt ? counterparty : initiatedSide;
}

/** Whether `ctx` is a lead of the side that approves this handshake. */
export function canApproveHandshake(
  ctx: AuthzContext,
  action: HandshakeAction,
  initiatedSide: Side,
  scope?: string,
  category?: string,
): boolean {
  if (ctx.status !== 'active') return false;
  return approverSideFor(action, initiatedSide, scope, category) === 'sell'
    ? isSellSideLead(ctx.role)
    : isBuySideLead(ctx.role);
}

/** The `can()` action that authorizes *initiating* a given handshake. */
export function initiateActionFor(action: HandshakeAction): Action {
  switch (action) {
    case 'advance_stage':
      return 'advanceMilestone';
    case 'close_deal':
    case 'cancel_deal':
      return 'changeDealStatus';
    case 'edit_price':
      return 'editPurchasePrice';
    case 'edit_dates':
      return 'editDates';
    case 'delete_document':
      return 'deleteDocument';
    case 'delete_thread':
      return 'deleteThread';
    case 'confirm_payment':
      return 'recordPayment';
    case 'void_payment':
      return 'voidPayment';
  }
}

// --- capability map for the SPA -------------------------------------------

const UI_ACTIONS: Action[] = [
  'editDealFields',
  'editPurchasePrice',
  'editDates',
  'changeDealStatus',
  'inviteSellSide',
  'inviteBuySide',
  'advanceMilestone',
  'editChecklist',
  'createThreadDealWide',
  'convertChannelThread',
  'deleteThread',
  'uploadDealWideDoc',
  'promoteDocument',
  'deleteDocument',
  'createDocRequest',
  'sendForSignature',
  'recordPayment',
  'viewAudit',
];

/**
 * A coarse `{ action: boolean }` map for hiding disallowed controls in the SPA.
 * Response-only — the server re-checks every action; never trust this as input.
 */
export function capabilitiesFor(ctx: AuthzContext): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of UI_ACTIONS) out[a] = can(a, ctx);
  // roster management is per-target; expose a coarse hint
  out.manageRoster =
    ctx.status === 'active' && (isSellSideLead(ctx.role) || isBuySideLead(ctx.role));
  return out;
}
