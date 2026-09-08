/** Turn an event into the columns the audit UI shows. Pure; no I/O. */
export interface Described {
  action: string;
  targetType: string;
  targetId?: string;
  summary: string;
}

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export function summarize(detailType: string, d: Record<string, unknown>): Described {
  switch (detailType) {
    // --- deal ---
    case 'deal.created':
      return { action: detailType, targetType: 'deal', targetId: s(d.dealId), summary: 'Deal created' };
    case 'deal.updated': {
      const changed = (d.changed ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const fields = Object.keys(changed);
      const parts = fields.map((f) => `${f}: ${s(changed[f]?.from) || '∅'} → ${s(changed[f]?.to)}`);
      return {
        action: detailType,
        targetType: 'deal',
        targetId: s(d.dealId),
        summary: parts.length ? `Terms edited — ${parts.join(', ')}` : 'Deal updated',
      };
    }
    case 'deal.status_changed':
      return {
        action: detailType,
        targetType: 'deal',
        targetId: s(d.dealId),
        summary: `Deal ${s(d.status).toLowerCase()}${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };

    // --- membership ---
    case 'member.invited':
      return {
        action: detailType,
        targetType: 'invite',
        targetId: s(d.email),
        summary: `Invited ${s(d.email)} as ${s(d.role)} (${s(d.side)})`,
      };
    case 'member.joined':
      return {
        action: detailType,
        targetType: 'member',
        targetId: s(d.userId),
        summary: `${s(d.role)} joined (${s(d.side)})`,
      };
    case 'member.role_changed':
      return {
        action: detailType,
        targetType: 'member',
        targetId: s(d.userId),
        summary: `Role changed ${s(d.from ?? d.old)} → ${s(d.to ?? d.new)}`,
      };
    case 'member.removed':
      return {
        action: detailType,
        targetType: 'member',
        targetId: s(d.userId),
        summary: 'Member removed',
      };

    // --- milestones + handshakes ---
    case 'stage.advanced':
      return {
        action: detailType,
        targetType: 'stage',
        targetId: s(d.to),
        summary: `Advanced to stage ${s(d.to)}${d.firmNow ? ' — deal is now firm' : ''}`,
      };
    case 'handshake.requested':
      return {
        action: detailType,
        targetType: 'handshake',
        targetId: s(d.hsId),
        summary: `Handshake requested: ${s(d.action)}`,
      };
    case 'handshake.approved':
      return {
        action: detailType,
        targetType: 'handshake',
        targetId: s(d.hsId),
        summary: `Handshake approved: ${s(d.action)}`,
      };
    case 'handshake.rejected':
      return {
        action: detailType,
        targetType: 'handshake',
        targetId: s(d.hsId),
        summary: `Handshake rejected${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };

    // --- chat ---
    case 'thread.created':
      return {
        action: detailType,
        targetType: 'thread',
        targetId: s(d.threadId),
        summary: `Thread "${s(d.subject)}" created in ${s(d.scope)}`,
      };
    case 'thread.converted':
      return {
        action: detailType,
        targetType: 'thread',
        targetId: s(d.threadId),
        summary: `Thread converted to ${s(d.toScope)}`,
      };
    case 'thread.delete_requested':
      return {
        action: detailType,
        targetType: 'thread',
        targetId: s(d.threadId),
        summary: `Deletion requested for channel "${s(d.subject)}"`,
      };
    case 'thread.deleted':
      return {
        action: detailType,
        targetType: 'thread',
        targetId: s(d.threadId),
        summary: `Channel thread deleted${d.subject ? ` — "${s(d.subject)}"` : ''}`,
      };
    case 'message.posted':
      return {
        action: detailType,
        targetType: 'message',
        targetId: s(d.msgId),
        summary: `Message posted${(d.mentions as unknown[])?.length ? ' (with @mentions)' : ''}`,
      };
    case 'message.edited':
      return { action: detailType, targetType: 'message', targetId: s(d.msgId), summary: 'Message edited' };
    case 'message.deleted':
      return { action: detailType, targetType: 'message', targetId: s(d.msgId), summary: 'Message removed' };

    // --- documents ---
    case 'document.uploaded':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: `Document uploaded (${s(d.category)}, ${s(d.scope)})`,
      };
    case 'document.versioned':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: `New version v${s(d.n)}`,
      };
    case 'document.promoted':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: 'Document promoted to deal-wide',
      };
    case 'document.delete_requested':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: `Deletion requested by ${s(d.requesterRole)}`,
      };
    case 'document.archived':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: 'Document archived (delete handshake completed)',
      };
    case 'document.accessed':
      return {
        action: detailType,
        targetType: 'document',
        targetId: s(d.docId),
        summary: `Document ${s(d.mode)} (v${s(d.n)}) by ${s(d.by)}`,
      };
    case 'docrequest.created':
      return {
        action: detailType,
        targetType: 'doc-request',
        targetId: s(d.reqId),
        summary: `Requested a ${s(d.category)} document (${s(d.targetRole ?? d.targetUserId)})`,
      };
    case 'docrequest.fulfilled':
      return {
        action: detailType,
        targetType: 'doc-request',
        targetId: s(d.reqId),
        summary: `Request fulfilled with ${s(d.fulfilledDocId)}`,
      };
    case 'docrequest.declined':
      return {
        action: detailType,
        targetType: 'doc-request',
        targetId: s(d.reqId),
        summary: `Request declined${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };
    case 'docrequest.cancelled':
      return {
        action: detailType,
        targetType: 'doc-request',
        targetId: s(d.reqId),
        summary: 'Request cancelled',
      };

    // --- e-signature (Module 12) ---
    case 'signature.requested':
      return {
        action: detailType,
        targetType: 'signature',
        targetId: s(d.envId),
        summary: `Sent for signature (${(d.recipientUserIds as unknown[])?.length ?? 0} signer(s), via ${s(d.provider)})`,
      };
    case 'signature.recipient_completed':
      return {
        action: detailType,
        targetType: 'signature',
        targetId: s(d.envId),
        summary: `A signer completed the envelope`,
      };
    case 'signature.completed':
      return {
        action: detailType,
        targetType: 'signature',
        targetId: s(d.envId),
        summary: `Signature complete — signed copy saved as v${s(d.signedVersion)}`,
      };
    case 'signature.declined':
      return {
        action: detailType,
        targetType: 'signature',
        targetId: s(d.envId),
        summary: `Signature declined${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };
    case 'signature.voided':
      return {
        action: detailType,
        targetType: 'signature',
        targetId: s(d.envId),
        summary: `Signature request voided${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };

    // --- payments (Module 11) ---
    case 'payment.recorded':
      return {
        action: detailType,
        targetType: 'payment',
        targetId: s(d.payId),
        summary: `Payment recorded — ${s(d.kind)} $${s(d.amount)} via ${s(d.method)} (${s(d.payer)} → ${s(d.payee)}), pending confirmation`,
      };
    case 'payment.confirmed':
      return {
        action: detailType,
        targetType: 'payment',
        targetId: s(d.payId),
        summary: `Payment confirmed — ${s(d.kind)} $${s(d.amount)}`,
      };
    case 'payment.voided':
      return {
        action: detailType,
        targetType: 'payment',
        targetId: s(d.payId),
        summary: `Payment voided${d.reason ? ` — ${s(d.reason)}` : ''}`,
      };

    // --- notifications (Module 9) ---
    case 'notification.emailed':
      return {
        action: detailType,
        targetType: 'notification',
        targetId: s(d.notifId),
        summary: `Email sent (${s(d.channel)})`,
      };

    default:
      return { action: detailType, targetType: 'event', summary: detailType };
  }
}
