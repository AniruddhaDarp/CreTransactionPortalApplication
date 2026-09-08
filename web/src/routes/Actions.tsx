import { useCallback, useState } from 'react';
import type { DealsApi, DocRequest, Handshake, SignatureEnvelope } from '../deals-api.js';
import { isSameSideDelete, roleLabel } from '../roles.js';
import { scopeTag } from '../theme.js';
import { useAsk } from './dialog.js';
import { humanizeError } from './errors.js';
import { useMemberNames } from './useMemberNames.js';
import { usePoll } from './usePoll.js';

const ACTION_LABEL: Record<string, string> = {
  advance_stage: 'Advance to the next milestone',
  close_deal: 'Close the deal',
  cancel_deal: 'Cancel the deal',
  edit_price: 'Change the purchase price',
  edit_dates: 'Change the target closing date',
  delete_document: 'Archive a document',
  delete_thread: 'Delete a channel',
  confirm_payment: 'Confirm a recorded payment',
  void_payment: 'Void a payment',
};

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toLocaleString()}` : String(v ?? ''));

/** One line naming the resource and the change being asked for. */
function detail(h: Handshake): string | null {
  const p = h.payload ?? {};
  switch (h.action) {
    case 'edit_price':
      return `New purchase price: ${money(p.price)}`;
    case 'edit_dates':
      return `New target closing date: ${String(p.targetClosingDate ?? '')}`;
    case 'confirm_payment':
      return `Payment: ${String(p.kind ?? 'payment').replace(/_/g, ' ')}${p.amount ? ` of ${money(p.amount)}` : ''}`;
    case 'void_payment':
      return `Void payment${p.reason ? ` — ${String(p.reason)}` : ''}`;
    case 'delete_document': {
      const bits = [String(p.title ?? 'a document')];
      if (p.category) bits.push(String(p.category));
      if (p.scope) bits.push(scopeTag(String(p.scope)).label);
      return `Archive: ${bits.join(' · ')}`;
    }
    case 'delete_thread':
      return `Delete channel${p.subject ? `: “${String(p.subject)}”` : ''}`;
    case 'advance_stage':
      return 'Mark the current milestone complete and move to the next';
    case 'close_deal':
      return `Close the deal${p.reason ? ` — ${String(p.reason)}` : ''}`;
    case 'cancel_deal':
      return `Cancel the deal${p.reason ? ` — ${String(p.reason)}` : ''}`;
    default:
      return null;
  }
}

/** Everything in *this deal* that is waiting on the current user, plus what they
 *  have proposed that is waiting on the other side. */
export function Actions({
  api,
  dealId,
  myUserId,
  goto,
}: {
  api: DealsApi;
  dealId: string;
  myUserId: string;
  goto: (tab: 'documents') => void;
}) {
  const [pending, setPending] = useState<Handshake[]>([]);
  const [docReqs, setDocReqs] = useState<DocRequest[]>([]);
  const [sigs, setSigs] = useState<SignatureEnvelope[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const ask = useAsk();
  const { roles, members } = useMemberNames(api, dealId);
  const myRole = roles[myUserId];
  const mySide = members.find((m) => m.userId === myUserId)?.side;

  /** Whether the current user is on the side that decides this handshake. */
  const decideByMe = (h: Handshake): boolean => {
    if (!mySide) return false;
    if (isSameSideDelete(h)) return mySide === h.initiatedSide && myUserId !== h.initiatedBy;
    return mySide !== h.initiatedSide;
  };

  const load = useCallback(() => {
    // Derive from the deal's full handshake list (same source the Milestones
    // cards use) rather than the approval-pointer feed, so nothing initiated by
    // the other side can be missed here. The server still enforces on approve.
    api
      .handshakes(dealId)
      .then((r) => setPending(r.handshakes.filter((h) => h.status === 'pending')))
      .catch((e: unknown) => setMsg(humanizeError(String(e))));
    api
      .docRequests(dealId)
      .then((r) => setDocReqs(r.requests))
      .catch(() => {});
    api
      .dealSignatures(dealId)
      .then((r) => setSigs(r.envelopes))
      .catch(() => {});
  }, [api, dealId]);

  usePoll(load, 10_000, [load]);

  const mine = pending.filter(decideByMe);
  const outgoing = pending.filter((h) => h.initiatedBy === myUserId);

  const act = (p: Promise<unknown>) => {
    setMsg(null);
    void p.then(load).catch((e: unknown) => setMsg(humanizeError(String(e))));
  };

  const reqsForMe = docReqs.filter(
    (r) =>
      r.status === 'open' &&
      ((!!r.targetUserId && r.targetUserId === myUserId) ||
        (!!r.targetRole && r.targetRole === myRole)),
  );
  const toSign = sigs.filter(
    (e) =>
      e.status === 'sent' &&
      e.recipients.some((r) => r.userId === myUserId && r.status === 'sent'),
  );
  const nothing =
    mine.length === 0 && reqsForMe.length === 0 && outgoing.length === 0 && toSign.length === 0;

  return (
    <>
      {msg && <p className="error">{msg}</p>}
      {nothing && <p className="empty">Nothing is waiting on you in this deal.</p>}

      {mine.length > 0 && (
        <>
          <h4 style={{ marginTop: 0 }}>Needs your decision</h4>
          <ul className="section-list">
            {mine.map((h) => {
              const d = detail(h);
              return (
                <li key={h.hsId} style={{ flexWrap: 'wrap' }}>
                  <span className="pill pill--warn">{ACTION_LABEL[h.action] ?? h.action}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    requested by the {h.initiatedSide === 'buy' ? 'buy' : 'sell'}-side
                  </span>
                  {d && (
                    <span
                      className="muted"
                      style={{ flexBasis: '100%', fontSize: 12.5, marginTop: 2 }}
                    >
                      {d}
                    </span>
                  )}
                  <span className="btn-row" style={{ marginLeft: 'auto' }}>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => act(api.approveHandshake(dealId, h.hsId))}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={async () => {
                        const reason = await ask({
                          title: 'Reject this request?',
                          body: 'The other side will be notified. They can re-propose it.',
                          input: true,
                          placeholder: 'Reason (optional)',
                          danger: true,
                          confirmLabel: 'Reject',
                        });
                        if (reason == null) return;
                        act(api.rejectHandshake(dealId, h.hsId, reason || undefined));
                      }}
                    >
                      Reject
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {reqsForMe.length > 0 && (
        <>
          <h4>Documents requested from you</h4>
          <ul className="section-list">
            {reqsForMe.map((r) => (
              <li key={r.reqId} style={{ flexWrap: 'wrap' }}>
                <span className="pill pill--warn">{r.category}</span>
                <span className={scopeTag(r.scope).cls}>{scopeTag(r.scope).label}</span>
                {r.note && <span className="muted">— {r.note}</span>}
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => goto('documents')}
                >
                  Open in Documents
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {toSign.length > 0 && (
        <>
          <h4>Documents to sign</h4>
          <ul className="section-list">
            {toSign.map((e) => (
              <li key={e.envId} style={{ flexWrap: 'wrap' }}>
                <span className="pill pill--warn">signature</span>
                <span>{e.subject}</span>
                <span className="btn-row" style={{ marginLeft: 'auto' }}>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => act(api.signEnvelope(dealId, e.docId, e.envId))}
                  >
                    Sign
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      const reason = await ask({
                        title: 'Decline to sign?',
                        body: `“${e.subject}” — the sender will be notified.`,
                        input: true,
                        placeholder: 'Reason (optional)',
                        danger: true,
                        confirmLabel: 'Decline',
                      });
                      if (reason == null) return;
                      act(
                        api.signEnvelope(dealId, e.docId, e.envId, {
                          decline: true,
                          reason: reason || undefined,
                        }),
                      );
                    }}
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {outgoing.length > 0 && (
        <>
          <h4>Waiting on approval</h4>
          <ul className="section-list">
            {outgoing.map((h) => {
              const d = detail(h);
              const sameSide = isSameSideDelete(h);
              return (
                <li key={h.hsId} style={{ flexWrap: 'wrap' }}>
                  <span className="pill">{ACTION_LABEL[h.action] ?? h.action}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    you proposed this — pending{' '}
                    {sameSide
                      ? `another lead on your side`
                      : `the ${h.initiatedSide === 'buy' ? 'sell' : 'buy'}-side`}
                    {myRole ? ` (as ${roleLabel(myRole)})` : ''}
                  </span>
                  {d && (
                    <span
                      className="muted"
                      style={{ flexBasis: '100%', fontSize: 12.5, marginTop: 2 }}
                    >
                      {d}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
