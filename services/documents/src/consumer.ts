import { sideOf, type Role } from '@cre/authz';
import { createLogger, publish, upsertMemberView } from '@cre/platform';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import * as repo from './repo.js';
import { BUS } from './shared.js';

/** Envelope inside every EventBridge event's `detail`. */
interface Envelope {
  eventId: string;
  occurredAt: string;
  correlationId: string;
  dealId: string;
  actorId?: string;
  detail: Record<string, unknown>;
}

async function dispatch(type: string, env: Envelope): Promise<void> {
  const table = repo.tableName();
  const d = env.detail;

  if (type === 'member.joined') {
    await upsertMemberView(table, env.dealId, String(d.userId), {
      role: String(d.role),
      side: String(d.side),
      status: 'active',
      version: env.occurredAt,
    });
  } else if (type === 'member.role_changed') {
    const to = d.to as Role;
    await upsertMemberView(table, env.dealId, String(d.userId), {
      role: to,
      side: to === 'OTHER' ? undefined : sideOf(to),
      status: 'active',
      version: env.occurredAt,
    });
  } else if (type === 'member.removed') {
    await upsertMemberView(table, env.dealId, String(d.userId), {
      status: 'removed',
      version: env.occurredAt,
    });
  } else if (type === 'deal.status_changed') {
    await repo.setDealStatus(env.dealId, String(d.status));
  } else if (type === 'handshake.approved' && d.action === 'delete_document') {
    const payload = (d.payload ?? {}) as { docId?: string };
    const docId = String(payload.docId ?? '');
    const hsId = String(d.hsId ?? '');
    if (!docId || !hsId) return;
    const doc = await repo.getDocument(env.dealId, docId);
    const scope = doc?.scope ?? 'deal_wide';
    await repo.archiveDocument(env.dealId, docId);
    await publish(BUS(), [
      {
        service: 'documents',
        type: 'document.archived',
        correlationId: env.correlationId,
        actorId: env.actorId,
        dealId: env.dealId,
        detail: { dealId: env.dealId, docId, hsId, scope },
      },
    ]);
  }
}

export const handler: SQSHandler = async (event) => {
  const log = createLogger({ consumer: 'documents' });
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const eb = JSON.parse(record.body) as { 'detail-type': string; detail: Envelope };
      await dispatch(eb['detail-type'], eb.detail);
    } catch (err) {
      log.error('record failed', {
        messageId: record.messageId,
        message: (err as Error).message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
