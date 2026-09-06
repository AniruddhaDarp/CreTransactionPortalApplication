import { describe, expect, it } from 'vitest';
import { plan } from './fanout.js';

describe('plan', () => {
  it('handshake.requested → one action-required notification per approver', () => {
    const p = plan('handshake.requested', {
      hsId: 'h1',
      action: 'advance_stage',
      approverIds: ['u1', 'u2'],
    })!;
    expect(p.type).toBe('handshake_pending');
    expect(p.email).toBe(true);
    expect(p.recipients).toEqual({ users: ['u1', 'u2'] });
    expect(p.targetId).toBe('h1');
  });

  it('handshake.approved / rejected → notify the initiator', () => {
    expect(plan('handshake.approved', { hsId: 'h', action: 'edit_price', initiatedBy: 'u9' })!.recipients).toEqual({
      users: ['u9'],
    });
    expect(plan('handshake.rejected', { hsId: 'h', reason: 'no', initiatedBy: 'u9' })!.type).toBe(
      'handshake_rejected',
    );
  });

  it('message.posted notifies only on @mentions', () => {
    expect(plan('message.posted', { threadId: 't', mentions: [] })).toBeNull();
    const p = plan('message.posted', { threadId: 't', mentions: ['u1'] })!;
    expect(p).toMatchObject({ type: 'mention', recipients: { users: ['u1'] } });
  });

  it('docrequest.created targets a user or a role', () => {
    expect(plan('docrequest.created', { reqId: 'r', category: 'Title', targetUserId: 'u1' })!.recipients).toEqual(
      { users: ['u1'] },
    );
    expect(plan('docrequest.created', { reqId: 'r', category: 'Title', targetRole: 'SELLER_AGENT' })!.recipients).toEqual(
      { role: 'SELLER_AGENT' },
    );
  });

  it('docrequest.fulfilled / declined → notify the requester (createdBy)', () => {
    expect(plan('docrequest.fulfilled', { reqId: 'r', createdBy: 'u3' })!.recipients).toEqual({ users: ['u3'] });
    expect(plan('docrequest.declined', { reqId: 'r', createdBy: 'u3', reason: 'x' })!.type).toBe(
      'docrequest_declined',
    );
  });

  it('stage.advanced / deal.status_changed → all members', () => {
    expect(plan('stage.advanced', { to: 3 })!.recipients).toEqual({ allMembers: true });
    const closed = plan('deal.status_changed', { dealId: 'd', status: 'CLOSED' })!;
    expect(closed.type).toBe('deal_closed');
    expect(closed.recipients).toEqual({ allMembers: true });
  });

  it('thread.converted notifies the dropped user only when there is one', () => {
    expect(plan('thread.converted', { threadId: 't', toScope: 'side_private:buy' })).toBeNull();
    expect(
      plan('thread.converted', { threadId: 't', toScope: 'side_private:buy', droppedUserId: 'u7' })!.recipients,
    ).toEqual({ users: ['u7'] });
  });

  it('member.invited → invitation email only, no in-app row', () => {
    const p = plan('member.invited', { dealId: 'd', email: 'x@y.com', role: 'BUYER', token: 'tok' })!;
    expect(p.recipients).toEqual({ inviteEmail: 'x@y.com' });
    expect(p.inviteToken).toBe('tok');
    expect(p.email).toBe(true);
  });

  it('returns null for events it does not handle', () => {
    expect(plan('document.accessed', { docId: 'x' })).toBeNull();
  });
});
