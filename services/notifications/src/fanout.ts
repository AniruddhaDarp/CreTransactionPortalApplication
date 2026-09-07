/**
 * Pure event → notification mapping. `recipients` is a *directive* the consumer
 * resolves against its membership projection:
 *   { users }      — explicit user ids
 *   { allMembers } — every active member of the deal
 *   { role }       — every active member holding that role
 *   { inviteEmail }— an email address with no account yet (invitation only)
 */
export type Recipients =
  | { users: string[] }
  | { allMembers: true }
  | { role: string }
  | { inviteEmail: string };

export interface Plan {
  recipients: Recipients;
  type: string;
  title: string;
  targetType?: string;
  targetId?: string;
  /** true → also an "action required" email when email is enabled */
  email?: boolean;
  /** invitation email body needs the token; carried through for the consumer */
  inviteToken?: string;
  inviteRole?: string;
}

const str = (v: unknown) => (v == null ? '' : String(v));

export function plan(detailType: string, d: Record<string, unknown>): Plan | null {
  switch (detailType) {
    case 'member.invited':
      return {
        recipients: { inviteEmail: str(d.email) },
        type: 'deal_invitation',
        title: `You've been invited to a deal as ${str(d.role)}`,
        targetType: 'deal',
        targetId: str(d.dealId),
        email: true,
        inviteToken: str(d.token),
        inviteRole: str(d.role),
      };

    case 'handshake.requested':
      return {
        recipients: { users: (d.approverIds as string[]) ?? [] },
        type: 'handshake_pending',
        title: `A "${str(d.action)}" handshake needs your approval`,
        targetType: 'handshake',
        targetId: str(d.hsId),
        email: true,
      };
    case 'handshake.approved':
      return {
        recipients: { users: [str(d.initiatedBy)] },
        type: 'handshake_approved',
        title: `Your "${str(d.action)}" handshake was approved`,
        targetType: 'handshake',
        targetId: str(d.hsId),
      };
    case 'handshake.rejected':
      return {
        recipients: { users: [str(d.initiatedBy)] },
        type: 'handshake_rejected',
        title: `Your handshake was rejected${d.reason ? ` — ${str(d.reason)}` : ''}`,
        targetType: 'handshake',
        targetId: str(d.hsId),
      };

    case 'message.posted': {
      const mentions = (d.mentions as string[]) ?? [];
      if (mentions.length === 0) return null; // plain messages don't notify
      return {
        recipients: { users: mentions },
        type: 'mention',
        title: 'You were mentioned in a message',
        targetType: 'thread',
        targetId: str(d.threadId),
      };
    }

    case 'docrequest.created':
      return {
        recipients: d.targetUserId
          ? { users: [str(d.targetUserId)] }
          : { role: str(d.targetRole) },
        type: 'docrequest_assigned',
        title: `You were asked to provide a ${str(d.category)} document`,
        targetType: 'doc-request',
        targetId: str(d.reqId),
        email: true,
      };
    case 'docrequest.fulfilled':
      return {
        recipients: { users: [str(d.createdBy)] },
        type: 'docrequest_fulfilled',
        title: 'Your document request was fulfilled',
        targetType: 'doc-request',
        targetId: str(d.reqId),
      };
    case 'docrequest.declined':
      return {
        recipients: { users: [str(d.createdBy)] },
        type: 'docrequest_declined',
        title: `Your document request was declined${d.reason ? ` — ${str(d.reason)}` : ''}`,
        targetType: 'doc-request',
        targetId: str(d.reqId),
      };

    case 'stage.advanced':
      return {
        recipients: { allMembers: true },
        type: 'stage_advanced',
        title: `The deal advanced to stage ${str(d.to)}${d.firmNow ? ' — it is now firm' : ''}`,
        targetType: 'stage',
        targetId: str(d.to),
      };
    case 'deal.status_changed':
      return {
        recipients: { allMembers: true },
        type: str(d.status) === 'CLOSED' ? 'deal_closed' : 'deal_cancelled',
        title: `The deal was ${str(d.status).toLowerCase()}${d.reason ? ` — ${str(d.reason)}` : ''}`,
        targetType: 'deal',
        targetId: str(d.dealId),
      };
    case 'signature.requested':
      return {
        recipients: { users: (d.recipientUserIds as string[]) ?? [] },
        type: 'signature_requested',
        title: 'You were asked to sign a document',
        targetType: 'document',
        targetId: str(d.docId),
        email: true,
      };
    case 'signature.completed':
      return {
        recipients: { allMembers: true },
        type: 'signature_completed',
        title: 'A document finished signing — the signed copy is in the document room',
        targetType: 'document',
        targetId: str(d.docId),
      };
    case 'signature.declined':
      return {
        recipients: { users: [str(d.createdBy)] },
        type: 'signature_declined',
        title: `A signature request you sent was declined${d.reason ? ` — ${str(d.reason)}` : ''}`,
        targetType: 'document',
        targetId: str(d.docId),
      };

    case 'payment.confirmed':
      return {
        recipients: { allMembers: true },
        type: 'payment_confirmed',
        title: `A ${str(d.kind)} payment of $${str(d.amount)} was confirmed`,
        targetType: 'payment',
        targetId: str(d.payId),
      };
    case 'payment.voided':
      return {
        recipients: { allMembers: true },
        type: 'payment_voided',
        title: `A payment was voided${d.reason ? ` — ${str(d.reason)}` : ''}`,
        targetType: 'payment',
        targetId: str(d.payId),
      };

    case 'thread.converted':
      if (!d.droppedUserId) return null;
      return {
        recipients: { users: [str(d.droppedUserId)] },
        type: 'thread_converted',
        title: `A private thread you were in moved to ${str(d.toScope)} — you were removed`,
        targetType: 'thread',
        targetId: str(d.threadId),
      };

    default:
      return null;
  }
}
