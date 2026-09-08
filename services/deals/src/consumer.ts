import type { AuthzContext, Role, Side } from '@cre/authz';
import { createLogger, HttpError } from '@cre/platform';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import * as handshake from './handshake.js';
import * as repo from './repo.js';
import { emit } from './shared.js';

/** Envelope inside every EventBridge event's `detail`. */
interface Envelope {
  eventId: string;
  occurredAt: string;
  correlationId: string;
  dealId: string;
  actorId?: string;
  detail: Record<string, unknown>;
}

/**
 * Documents can't open a handshake itself (no sync service-to-service calls), so
 * it emits `document.delete_requested` and this consumer runs the initiation on
 * its behalf. The counterparty then approves through the normal handshake API;
 * `handshake.approved` is consumed by the Documents service, which archives the
 * file and emits `document.archived`, closing the saga here.
 */
async function onDeleteRequested(env: Envelope): Promise<void> {
  const d = env.detail;
  const dealId = env.dealId;
  const docId = String(d.docId ?? '');
  const scope = String(d.scope ?? '');
  const category = String(d.category ?? '');
  const title = d.title === undefined ? undefined : String(d.title);
  const requestedBy = String(d.requestedBy ?? '');
  if (!dealId || !docId || !requestedBy) throw new HttpError(400, 'malformed document.delete_requested');

  const deal = await repo.getDeal(dealId);
  if (!deal) throw new HttpError(404, `deal ${dealId} not found`);

  // Idempotency: a redelivered request must not open a second handshake.
  const open = (await repo.listHandshakes(dealId)).find(
    (hs) =>
      hs.action === 'delete_document' &&
      (hs.status === 'pending' || hs.status === 'approved') &&
      hs.payload?.docId === docId,
  );
  if (open) return;

  const authz: AuthzContext = {
    role: d.requesterRole as Role,
    side: d.requesterSide as Side,
    status: 'active',
    isAdmin: d.requesterRole === 'SELLER_AGENT' && requestedBy === deal.createdBy,
    isFirm: deal.firm,
    currentStage: deal.currentStage,
  };

  const { hs, events } = await handshake.initiate({
    deal,
    authz,
    action: 'delete_document',
    payload: { docId, scope, category, ...(title ? { title } : {}) },
    actorId: requestedBy,
  });
  await emit(dealId, env.correlationId, requestedBy, events);
  createLogger({ consumer: 'deals' }).info('opened delete_document handshake', {
    dealId,
    docId,
    scope,
    hsId: hs.hsId,
    autoApproved: hs.status !== 'pending',
  });
}

async function onArchived(env: Envelope): Promise<void> {
  const hsId = String(env.detail.hsId ?? '');
  if (!hsId) throw new HttpError(400, 'document.archived is missing hsId');
  await repo.completeHandshakeSaga(env.dealId, hsId);
}

/**
 * Chat can't open a handshake itself, so it emits `thread.delete_requested` and
 * this consumer runs the initiation. A deal lead on the counterparty side then
 * approves; `handshake.approved` is consumed by the Chat service, which archives
 * the thread and emits `thread.deleted`, closing the saga here.
 */
async function onThreadDeleteRequested(env: Envelope): Promise<void> {
  const d = env.detail;
  const dealId = env.dealId;
  const threadId = String(d.threadId ?? '');
  const scope = String(d.scope ?? '');
  const subject = d.subject === undefined ? undefined : String(d.subject);
  const requestedBy = String(d.requestedBy ?? '');
  if (!dealId || !threadId || !requestedBy) {
    throw new HttpError(400, 'malformed thread.delete_requested');
  }

  const deal = await repo.getDeal(dealId);
  if (!deal) throw new HttpError(404, `deal ${dealId} not found`);

  const open = (await repo.listHandshakes(dealId)).find(
    (hs) =>
      hs.action === 'delete_thread' &&
      (hs.status === 'pending' || hs.status === 'approved') &&
      hs.payload?.threadId === threadId,
  );
  if (open) return;

  const authz: AuthzContext = {
    role: d.requesterRole as Role,
    side: d.requesterSide as Side,
    status: 'active',
    isAdmin: d.requesterRole === 'SELLER_AGENT' && requestedBy === deal.createdBy,
    isFirm: deal.firm,
    currentStage: deal.currentStage,
  };

  const { hs, events } = await handshake.initiate({
    deal,
    authz,
    action: 'delete_thread',
    payload: { threadId, scope, ...(subject ? { subject } : {}) },
    actorId: requestedBy,
  });
  await emit(dealId, env.correlationId, requestedBy, events);
  createLogger({ consumer: 'deals' }).info('opened delete_thread handshake', {
    dealId,
    threadId,
    hsId: hs.hsId,
  });
}

async function onThreadDeleted(env: Envelope): Promise<void> {
  const hsId = String(env.detail.hsId ?? '');
  if (!hsId) throw new HttpError(400, 'thread.deleted is missing hsId');
  await repo.completeHandshakeSaga(env.dealId, hsId);
}

async function dispatch(type: string, env: Envelope): Promise<void> {
  if (type === 'document.delete_requested') return onDeleteRequested(env);
  if (type === 'document.archived') return onArchived(env);
  if (type === 'thread.delete_requested') return onThreadDeleteRequested(env);
  if (type === 'thread.deleted') return onThreadDeleted(env);
}

export const handler: SQSHandler = async (event) => {
  const log = createLogger({ consumer: 'deals' });
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const eb = JSON.parse(record.body) as { 'detail-type': string; detail: Envelope };
      await dispatch(eb['detail-type'], eb.detail);
    } catch (err) {
      // An HttpError here is a permanent, non-retryable rejection (bad request,
      // deal gone, requester not permitted) — log and drop rather than poison
      // the queue. Anything else is transient: fail the record so SQS retries.
      if (err instanceof HttpError) {
        log.error('dropping non-retryable record', {
          messageId: record.messageId,
          status: err.status,
          message: err.message,
        });
        continue;
      }
      log.error('record failed, will retry', {
        messageId: record.messageId,
        message: (err as Error).message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
