import { sideOf, type Role } from '@cre/authz';
import { createLogger, listMemberViews, publish, upsertMemberView } from '@cre/platform';
import type { SQSBatchItemFailure, SQSHandler } from 'aws-lambda';
import { emailEnabled, sendEmail } from './email.js';
import { plan, type Recipients } from './fanout.js';
import * as repo from './repo.js';

interface Envelope {
  eventId: string;
  occurredAt: string;
  correlationId: string;
  dealId?: string;
  actorId?: string;
  detail: Record<string, unknown>;
}

const BUS = () => process.env.EVENT_BUS_NAME ?? '';
const WEB_ORIGIN = () => process.env.WEB_ORIGIN ?? '';

async function projections(type: string, env: Envelope): Promise<void> {
  const d = env.detail;
  if (type === 'account.created') {
    await repo.putProfile({
      userId: String(d.userId),
      email: String(d.email),
      name: String(d.email).split('@')[0] || String(d.email),
    });
    return;
  }
  if (!env.dealId) return;
  const table = repo.tableName();
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

async function resolveUsers(r: Recipients, dealId: string | undefined): Promise<string[]> {
  if ('users' in r) return [...new Set(r.users.filter(Boolean))];
  if (!dealId) return [];
  const members = (await listMemberViews(repo.tableName(), dealId)).filter((m) => m.status === 'active');
  if ('allMembers' in r) return members.map((m) => m.userId);
  if ('role' in r) return members.filter((m) => m.role === r.role).map((m) => m.userId);
  return [];
}

async function fanOut(type: string, env: Envelope): Promise<void> {
  const p = plan(type, { ...env.detail, dealId: env.dealId });
  if (!p) return;
  const log = createLogger({ consumer: 'notifications' });

  // Invitations: no in-app row (the invitee has no account yet) — email only.
  if ('inviteEmail' in p.recipients) {
    const to = p.recipients.inviteEmail;
    if (!to) return;
    if (!emailEnabled()) {
      log.info('invitation email skipped (email disabled)', { to, dealId: env.dealId });
      return;
    }
    const url = `${WEB_ORIGIN()}/accept/${env.dealId}/${p.inviteToken}`;
    await sendEmail(to, 'You have been invited to a CRE deal', `${p.title}\n\nAccept: ${url}`);
    await publish(BUS(), [
      {
        service: 'notifications',
        type: 'notification.emailed',
        correlationId: env.correlationId,
        dealId: env.dealId,
        detail: { channel: 'invitation', to, sourceEventId: env.eventId },
      },
    ]);
    return;
  }

  // A deal-wide broadcast (stage advanced, deal closed/cancelled) goes to
  // everyone on the deal, the actor included — it is a milestone, not feedback
  // on their own action. Every other plan skips the actor.
  const isBroadcast = 'allMembers' in p.recipients;
  const userIds = (await resolveUsers(p.recipients, env.dealId)).filter(
    (u) => isBroadcast || u !== env.actorId,
  );
  for (const userId of userIds) {
    await repo.putNotification({
      userId,
      notifId: env.eventId,
      occurredAt: env.occurredAt,
      type: p.type,
      title: p.title,
      dealId: env.dealId,
      actorId: env.actorId,
      targetType: p.targetType,
      targetId: p.targetId,
      sourceEventId: env.eventId,
    });

    if (p.email && emailEnabled()) {
      const profile = await repo.getProfile(userId);
      if (profile?.email) {
        const link = `${WEB_ORIGIN()}/deals/${env.dealId}`;
        await sendEmail(profile.email, `Action required: ${p.title}`, `${p.title}\n\n${link}`);
        await publish(BUS(), [
          {
            service: 'notifications',
            type: 'notification.emailed',
            correlationId: env.correlationId,
            dealId: env.dealId,
            detail: { channel: 'action_required', to: profile.email, sourceEventId: env.eventId },
          },
        ]);
      }
    }
  }
}

export const handler: SQSHandler = async (event) => {
  const log = createLogger({ consumer: 'notifications' });
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const rec of event.Records) {
    try {
      const eb = JSON.parse(rec.body) as { 'detail-type': string; detail: Envelope };
      await projections(eb['detail-type'], eb.detail);
      await fanOut(eb['detail-type'], eb.detail);
    } catch (err) {
      log.error('record failed', { messageId: rec.messageId, message: (err as Error).message });
      batchItemFailures.push({ itemIdentifier: rec.messageId });
    }
  }

  return { batchItemFailures };
};
