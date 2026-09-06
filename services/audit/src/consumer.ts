import { sideOf, type Role } from '@cre/authz';
import { createLogger, upsertMemberView } from '@cre/platform';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import { summarize } from './describe.js';
import * as repo from './repo.js';
import { deriveScope } from './scope.js';

interface Envelope {
  eventId: string;
  occurredAt: string;
  correlationId: string;
  dealId?: string;
  actorId?: string;
  detail: Record<string, unknown>;
}

async function projectMembership(type: string, env: Envelope): Promise<void> {
  if (!env.dealId) return;
  const d = env.detail;
  const table = repo.membershipTableName();
  if (type === 'member.joined') {
    await upsertMemberView(table, env.dealId, String(d.userId), {
      role: String(d.role),
      side: String(d.side),
      status: 'active',
      version: env.occurredAt,
    });
  } else if (type === 'member.role_changed') {
    const to = (d.to ?? d.new) as Role;
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
  }
}

async function record(type: string, env: Envelope): Promise<void> {
  // account.created (and any other dealId-less event) has no deal to attach to;
  // account-lifecycle auditing is future work — see docs/02-design.md §12.
  if (!env.dealId) return;

  await projectMembership(type, env);

  const { action, targetType, targetId, summary } = summarize(type, env.detail);
  await repo.putEvent({
    dealId: env.dealId,
    eventId: env.eventId,
    occurredAt: env.occurredAt,
    actorId: env.actorId,
    detailType: type,
    action,
    targetType,
    targetId,
    scope: deriveScope(env.detail),
    summary,
    correlationId: env.correlationId,
    metadata: env.detail,
  });
}

export const handler: SQSHandler = async (event) => {
  const log = createLogger({ consumer: 'audit' });
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const rec of event.Records) {
    try {
      const eb = JSON.parse(rec.body) as { 'detail-type': string; detail: Envelope };
      await record(eb['detail-type'], eb.detail);
    } catch (err) {
      log.error('record failed', { messageId: rec.messageId, message: (err as Error).message });
      batchItemFailures.push({ itemIdentifier: rec.messageId });
    }
  }

  return { batchItemFailures };
};
