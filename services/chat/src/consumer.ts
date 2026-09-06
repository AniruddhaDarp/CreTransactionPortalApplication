import { sideOf, type Role, type Side } from '@cre/authz';
import { createLogger } from '@cre/platform';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import * as repo from './repo.js';

/** Envelope inside every EventBridge event's `detail`. */
interface Envelope {
  eventId: string;
  occurredAt: string;
  correlationId: string;
  dealId: string;
  actorId?: string;
  detail: Record<string, unknown>;
}

const FEED_KINDS = new Set([
  'member.joined',
  'stage.advanced',
  'handshake.approved',
  'handshake.rejected',
  'deal.status_changed',
]);

function feedSummary(type: string, d: Record<string, unknown>): string {
  switch (type) {
    case 'member.joined':
      return `${String(d.role)} joined the deal`;
    case 'stage.advanced':
      return `Advanced to stage ${String(d.to)}${d.firmNow ? ' — the deal is now firm' : ''}`;
    case 'handshake.approved':
      return `Handshake approved: ${String(d.action)}`;
    case 'handshake.rejected':
      return `Handshake rejected: ${String(d.reason ?? 'no reason given')}`;
    case 'deal.status_changed':
      return `Deal ${String(d.status).toLowerCase()}`;
    default:
      return type;
  }
}

async function process(type: string, env: Envelope): Promise<void> {
  const d = env.detail;

  if (type === 'member.joined') {
    await repo.upsertMemberView(env.dealId, String(d.userId), {
      role: d.role as Role,
      side: d.side as Side,
      status: 'active',
      version: env.occurredAt,
    });
  } else if (type === 'member.role_changed') {
    const to = d.to as Role;
    await repo.upsertMemberView(env.dealId, String(d.userId), {
      role: to,
      side: to === 'OTHER' ? undefined : sideOf(to),
      status: 'active',
      version: env.occurredAt,
    });
  } else if (type === 'member.removed') {
    await repo.upsertMemberView(env.dealId, String(d.userId), {
      status: 'removed',
      version: env.occurredAt,
    });
  }

  if (FEED_KINDS.has(type)) {
    await repo.putFeedItem(env.dealId, env.eventId, env.occurredAt, {
      kind: type,
      summary: feedSummary(type, d),
      actorId: env.actorId,
    });
  }
}

export const handler: SQSHandler = async (event) => {
  const log = createLogger({ consumer: 'chat' });
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const eb = JSON.parse(record.body) as { 'detail-type': string; detail: Envelope };
      await process(eb['detail-type'], eb.detail);
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
