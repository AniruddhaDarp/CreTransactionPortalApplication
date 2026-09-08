import {
  approverSideFor,
  can,
  canApproveHandshake,
  initiateActionFor,
  isBuySideLead,
  isSellSideLead,
  type AuthzContext,
  type HandshakeAction,
} from '@cre/authz';
import { HttpError } from '@cre/platform';
import { ATTORNEY_REVIEW_STAGE, LAST_STAGE } from './pipeline.js';
import type { DealMeta, Handshake, TransactItem } from './repo.js';
import * as repo from './repo.js';

const T = () => repo.tableName();
const K = repo.keys;

export interface DealEventOut {
  type: string;
  detail: Record<string, unknown>;
}

interface ApplyResult {
  effects: TransactItem[];
  events: DealEventOut[];
  saga?: 'awaiting_document' | 'awaiting_thread';
}

type Applier = (deal: DealMeta, payload: Record<string, unknown>, actorId: string) => ApplyResult;

// --- appliers: what each approved handshake does to the deal ---------------

const applyAdvance: Applier = (deal, _payload, actorId) => {
  if (deal.status !== 'ACTIVE') throw new HttpError(409, 'the deal is not active');
  const from = deal.currentStage;
  if (from >= LAST_STAGE) throw new HttpError(409, 'already at the final stage');
  const to = from + 1;
  const now = new Date().toISOString();
  const firmNow = from === ATTORNEY_REVIEW_STAGE;

  const metaValues: Record<string, unknown> = { ':to': to, ':now': now, ':cur': from };
  let metaExpr = 'SET currentStage = :to, updatedAt = :now';
  if (firmNow) {
    metaExpr = 'SET currentStage = :to, firm = :true, updatedAt = :now';
    metaValues[':true'] = true;
  }

  return {
    effects: [
      {
        Update: {
          TableName: T(),
          Key: K.stageKey(deal.dealId, from),
          UpdateExpression: 'SET #s = :done, completedBy = :by, completedAt = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':done': 'completed',
            ':by': actorId,
            ':now': now,
            ':inprog': 'in_progress',
          },
          ConditionExpression: '#s = :inprog',
        },
      },
      {
        Update: {
          TableName: T(),
          Key: K.stageKey(deal.dealId, to),
          UpdateExpression: 'SET #s = :inprog',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inprog': 'in_progress' },
        },
      },
      {
        Update: {
          TableName: T(),
          Key: K.dealKey(deal.dealId),
          UpdateExpression: metaExpr,
          ExpressionAttributeValues: metaValues,
          ConditionExpression: 'currentStage = :cur',
        },
      },
    ],
    events: [{ type: 'stage.advanced', detail: { dealId: deal.dealId, from, to, firmNow } }],
  };
};

const applyStatus =
  (status: 'CLOSED' | 'CANCELLED'): Applier =>
  (deal, payload, actorId) => {
    if (deal.status !== 'ACTIVE') throw new HttpError(409, `deal is already ${deal.status}`);
    const now = new Date().toISOString();
    const values: Record<string, unknown> = { ':s': status, ':now': now, ':active': 'ACTIVE' };
    let expr = 'SET #status = :s, updatedAt = :now';
    if (status === 'CLOSED') {
      expr += ', actualClosingDate = :acd';
      values[':acd'] = now.slice(0, 10);
    }
    const effects: TransactItem[] = [
      {
        Update: {
          TableName: T(),
          Key: K.dealKey(deal.dealId),
          UpdateExpression: expr,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
          ConditionExpression: '#status = :active',
        },
      },
    ];
    // Completing the deal completes its final milestone too.
    if (status === 'CLOSED') {
      effects.push({
        Update: {
          TableName: T(),
          Key: K.stageKey(deal.dealId, deal.currentStage),
          UpdateExpression: 'SET #st = :done, completedBy = :by, completedAt = :now',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':done': 'completed', ':by': actorId, ':now': now },
          ConditionExpression: 'attribute_exists(SK)',
        },
      });
    }
    return {
      effects,
      events: [
        {
          type: 'deal.status_changed',
          detail: { dealId: deal.dealId, status, reason: payload.reason ?? undefined },
        },
      ],
    };
  };

const applyEditPrice: Applier = (deal, payload) => {
  const price = Number(payload.price);
  if (!(price > 0)) throw new HttpError(400, 'price must be a positive number');
  const now = new Date().toISOString();
  return {
    effects: [
      {
        Update: {
          TableName: T(),
          Key: K.dealKey(deal.dealId),
          UpdateExpression: 'SET price = :p, updatedAt = :now',
          ExpressionAttributeValues: { ':p': price, ':now': now },
        },
      },
    ],
    events: [
      {
        type: 'deal.updated',
        detail: { dealId: deal.dealId, changed: { price: { from: deal.price, to: price } } },
      },
    ],
  };
};

const applyEditDates: Applier = (deal, payload) => {
  const d = String(payload.targetClosingDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new HttpError(400, 'targetClosingDate must be YYYY-MM-DD');
  }
  const now = new Date().toISOString();
  return {
    effects: [
      {
        Update: {
          TableName: T(),
          Key: K.dealKey(deal.dealId),
          UpdateExpression: 'SET targetClosingDate = :d, updatedAt = :now',
          ExpressionAttributeValues: { ':d': d, ':now': now },
        },
      },
    ],
    events: [
      {
        type: 'deal.updated',
        detail: {
          dealId: deal.dealId,
          changed: { targetClosingDate: { from: deal.targetClosingDate ?? null, to: d } },
        },
      },
    ],
  };
};

const applyDeleteDocument: Applier = (_deal, payload) => {
  if (!payload.docId) throw new HttpError(400, 'docId is required');
  // The archive itself happens in the Documents service; this only opens the saga.
  return { effects: [], events: [], saga: 'awaiting_document' };
};

const applyDeleteThread: Applier = (_deal, payload) => {
  if (!payload.threadId) throw new HttpError(400, 'threadId is required');
  // The Chat service archives the thread on handshake.approved; this only opens the saga.
  return { effects: [], events: [], saga: 'awaiting_thread' };
};

const applyConfirmPayment: Applier = (deal, payload, actorId) => {
  const payId = String(payload.payId ?? '');
  if (!payId) throw new HttpError(400, 'payId is required');
  const now = new Date().toISOString();
  return {
    effects: [
      {
        Update: {
          TableName: T(),
          Key: K.payKey(deal.dealId, payId),
          UpdateExpression: 'SET #s = :confirmed, confirmedBy = :by, confirmedAt = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':confirmed': 'confirmed',
            ':by': actorId,
            ':now': now,
            ':recorded': 'recorded',
          },
          ConditionExpression: '#s = :recorded',
        },
      },
    ],
    events: [
      {
        type: 'payment.confirmed',
        detail: { dealId: deal.dealId, payId, kind: payload.kind, amount: payload.amount, confirmedBy: actorId },
      },
    ],
  };
};

const applyVoidPayment: Applier = (deal, payload, actorId) => {
  const payId = String(payload.payId ?? '');
  if (!payId) throw new HttpError(400, 'payId is required');
  const reason = payload.reason === undefined ? undefined : String(payload.reason);
  const now = new Date().toISOString();
  const sets = ['#s = :void', 'voidedBy = :by', 'voidedAt = :now'];
  const values: Record<string, unknown> = {
    ':void': 'void',
    ':by': actorId,
    ':now': now,
    ':voidcmp': 'void',
  };
  if (reason !== undefined) {
    sets.push('voidReason = :reason');
    values[':reason'] = reason;
  }
  return {
    effects: [
      {
        Update: {
          TableName: T(),
          Key: K.payKey(deal.dealId, payId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(PK) AND #s <> :voidcmp',
        },
      },
    ],
    events: [{ type: 'payment.voided', detail: { dealId: deal.dealId, payId, reason } }],
  };
};

const REGISTRY: Record<HandshakeAction, Applier> = {
  advance_stage: applyAdvance,
  close_deal: applyStatus('CLOSED'),
  cancel_deal: applyStatus('CANCELLED'),
  edit_price: applyEditPrice,
  edit_dates: applyEditDates,
  delete_document: applyDeleteDocument,
  delete_thread: applyDeleteThread,
  confirm_payment: applyConfirmPayment,
  void_payment: applyVoidPayment,
};

// --- orchestration -------------------------------------------------------

export async function initiate(args: {
  deal: DealMeta;
  authz: AuthzContext;
  action: HandshakeAction;
  payload: Record<string, unknown>;
  actorId: string;
}): Promise<{ hs: Handshake; events: DealEventOut[] }> {
  const { deal, authz, action, payload, actorId } = args;

  if (!can(initiateActionFor(action), authz)) {
    throw new HttpError(403, `not allowed to initiate a ${action} handshake`);
  }
  // Pre-flight the effect so an obviously-invalid request fails now, not on approve.
  REGISTRY[action](deal, payload, actorId);

  const approverSide = approverSideFor(
    action,
    authz.side,
    String(payload.scope ?? ''),
    String(payload.category ?? ''),
  );
  const leadOfApproverSide = approverSide === 'sell' ? isSellSideLead : isBuySideLead;

  const active = (await repo.listMembers(deal.dealId)).filter((m) => m.status === 'active');
  const approverIds = active
    .filter((m) => m.userId !== actorId && leadOfApproverSide(m.role))
    .map((m) => m.userId);

  const now = new Date().toISOString();
  const base = {
    dealId: deal.dealId,
    hsId: crypto.randomUUID(),
    action,
    payload,
    initiatedBy: actorId,
    initiatedSide: authz.side,
    createdAt: now,
  };
  const requested = (approvers: string[]): DealEventOut => ({
    type: 'handshake.requested',
    detail: {
      dealId: deal.dealId,
      hsId: base.hsId,
      action,
      payload,
      initiatedBy: actorId,
      initiatedSide: authz.side,
      approverIds: approvers,
    },
  });

  if (approverIds.length === 0) {
    // A side-private document archive with no *other* lead on the initiating
    // side: the initiator is the sole lead, so their request is self-approving.
    if (approverSide === authz.side) {
      const result = REGISTRY[action](deal, payload, actorId);
      const hs: Handshake = {
        ...base,
        status: result.saga ? 'approved' : 'completed',
        decidedBy: actorId,
        decidedAt: now,
        sagaState: result.saga,
      };
      await repo.runTransaction([
        { Put: { TableName: T(), Item: { ...K.hsKey(hs.dealId, hs.hsId), ...hs } } },
        ...result.effects,
      ]);
      return {
        hs,
        events: [
          requested([]),
          {
            type: 'handshake.approved',
            detail: {
              dealId: deal.dealId,
              hsId: hs.hsId,
              action,
              payload,
              initiatedBy: actorId,
              initiatedSide: authz.side,
            },
          },
          ...result.events,
        ],
      };
    }
    throw new HttpError(
      409,
      authz.side === 'sell'
        ? "invite the buyer's side before initiating this handshake"
        : 'no sell-side lead is available to approve',
    );
  }

  const hs: Handshake = { ...base, status: 'pending' };
  await repo.putHandshake(hs, approverIds);
  return { hs, events: [requested(approverIds)] };
}

export async function decide(args: {
  deal: DealMeta;
  hs: Handshake;
  authz: AuthzContext;
  actorId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}): Promise<{ events: DealEventOut[] }> {
  const { deal, hs, authz, actorId, decision, reason } = args;
  if (hs.status !== 'pending') throw new HttpError(409, `handshake is already ${hs.status}`);

  const canApprove = canApproveHandshake(
    authz,
    hs.action,
    hs.initiatedSide,
    String(hs.payload?.scope ?? ''),
    String(hs.payload?.category ?? ''),
  );
  const isInitiator = hs.initiatedBy === actorId;
  if (decision === 'approve' && (!canApprove || isInitiator)) {
    throw new HttpError(403, 'you are not an approver of this handshake');
  }
  if (decision === 'reject' && !canApprove && !isInitiator) {
    throw new HttpError(403, 'only an approver or the initiator may reject this handshake');
  }

  const now = new Date().toISOString();
  const pointerUserIds = (await repo.listApprovalPointers(deal.dealId, hs.hsId)).map((p) => p.userId);
  const apprDeletes = repo.apprDeleteItems(deal.dealId, hs.hsId, pointerUserIds);

  if (decision === 'reject') {
    await repo.runTransaction([
      hsDecideItem(deal.dealId, hs.hsId, {
        status: 'rejected',
        decidedBy: actorId,
        decidedAt: now,
        decisionReason: reason,
      }),
      ...apprDeletes,
    ]);
    return {
      events: [
        {
          type: 'handshake.rejected',
          detail: {
            dealId: deal.dealId,
            hsId: hs.hsId,
            reason,
            initiatedBy: hs.initiatedBy,
            initiatedSide: hs.initiatedSide,
          },
        },
      ],
    };
  }

  const result = REGISTRY[hs.action](deal, hs.payload, actorId);
  await repo.runTransaction([
    hsDecideItem(deal.dealId, hs.hsId, {
      status: result.saga ? 'approved' : 'completed',
      decidedBy: actorId,
      decidedAt: now,
      sagaState: result.saga,
    }),
    ...result.effects,
    ...apprDeletes,
  ]);

  return {
    events: [
      {
        type: 'handshake.approved',
        detail: {
          dealId: deal.dealId,
          hsId: hs.hsId,
          action: hs.action,
          payload: hs.payload,
          initiatedBy: hs.initiatedBy,
          initiatedSide: hs.initiatedSide,
        },
      },
      ...result.events,
    ],
  };
}

function hsDecideItem(
  dealId: string,
  hsId: string,
  patch: {
    status: string;
    decidedBy: string;
    decidedAt: string;
    decisionReason?: string;
    sagaState?: string;
  },
): TransactItem {
  const sets = ['#status = :status', 'decidedBy = :by', 'decidedAt = :at'];
  const values: Record<string, unknown> = {
    ':status': patch.status,
    ':by': patch.decidedBy,
    ':at': patch.decidedAt,
    ':pending': 'pending',
  };
  if (patch.decisionReason !== undefined) {
    sets.push('decisionReason = :reason');
    values[':reason'] = patch.decisionReason;
  }
  if (patch.sagaState !== undefined) {
    sets.push('sagaState = :saga');
    values[':saga'] = patch.sagaState;
  }
  return {
    Update: {
      TableName: T(),
      Key: K.hsKey(dealId, hsId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ConditionExpression: '#status = :pending',
    },
  };
}
