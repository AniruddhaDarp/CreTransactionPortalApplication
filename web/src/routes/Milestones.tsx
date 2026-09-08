import { useCallback, useState } from 'react';
import type { Capabilities, ChecklistItem, DealsApi, Handshake, Stage } from '../deals-api.js';
import { isSameSideDelete } from '../roles.js';
import { useAsk } from './dialog.js';
import { humanizeError } from './errors.js';
import { useMemberNames } from './useMemberNames.js';
import { usePoll } from './usePoll.js';

const ACTION_LABEL: Record<string, string> = {
  advance_stage: 'Advance stage',
  close_deal: 'Close deal',
  cancel_deal: 'Cancel deal',
  edit_price: 'Price change',
  edit_dates: 'Closing-date change',
  delete_document: 'Delete document',
  delete_thread: 'Delete channel',
  confirm_payment: 'Confirm payment',
  void_payment: 'Void payment',
};
const SIDE_LEADS: Record<string, string> = {
  sell: "the Seller or Seller's Agent",
  buy: "the Buyer or Buyer's Agent",
};

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toLocaleString()}` : String(v ?? ''));

/** A one-line summary of what a pending handshake would do. */
function describeHandshake(h: Handshake, stages: Stage[], currentStage: number): string | null {
  const p = h.payload ?? {};
  switch (h.action) {
    case 'advance_stage': {
      const to = stages.find((s) => s.n === currentStage + 1)?.name ?? `stage ${currentStage + 1}`;
      return `Move the deal to ${to}`;
    }
    case 'edit_price':
      return `New accepted price: ${money(p.price)}`;
    case 'edit_dates':
      return `New target closing date: ${String(p.targetClosingDate ?? '')}`;
    case 'close_deal':
      return `Close the deal${p.reason ? ` — "${String(p.reason)}"` : ''}`;
    case 'cancel_deal':
      return `Cancel the deal${p.reason ? ` — "${String(p.reason)}"` : ''}`;
    case 'confirm_payment':
      return `Confirm the ${String(p.kind ?? 'payment')}${p.amount ? ` of ${money(p.amount)}` : ''}`;
    case 'void_payment':
      return `Void a payment${p.reason ? ` — "${String(p.reason)}"` : ''}`;
    case 'delete_document': {
      const bits = [p.title ? `"${String(p.title)}"` : 'a document'];
      if (p.category) bits.push(String(p.category));
      return `Archive ${bits.join(' · ')}`;
    }
    case 'delete_thread':
      return `Delete the channel${p.subject ? ` "${String(p.subject)}"` : ''}`;
    default:
      return null;
  }
}

/** Both parties to a handshake and where each stands. */
function HandshakeSides({ h }: { h: Handshake }) {
  // Archiving a doc the counterparty can't see (private scope or a blind
  // category) is approved by the *other* lead on the initiating side.
  const sameSide = isSameSideDelete(h);
  const agreed = h.initiatedSide; // initiating = consenting
  const pending = sameSide ? h.initiatedSide : h.initiatedSide === 'buy' ? 'sell' : 'buy';

  if (sameSide) {
    return (
      <div className="hs-sides">
        <div className="hs-side">
          <span className="hs-side__mark is-done" aria-hidden="true">
            ✓
          </span>
          <span className="hs-side__name">{agreed}-side</span>
          <span className="hs-side__state">requested by a lead</span>
        </div>
        <div className="hs-side">
          <span className="hs-side__mark" aria-hidden="true">
            ⏳
          </span>
          <span className="hs-side__name">{agreed}-side</span>
          <span className="hs-side__state">awaiting another {agreed}-side lead&rsquo;s approval</span>
        </div>
      </div>
    );
  }

  const row = (side: string, done: boolean) => (
    <div className="hs-side" key={side}>
      <span className={`hs-side__mark${done ? ' is-done' : ''}`} aria-hidden="true">
        {done ? '✓' : '⏳'}
      </span>
      <span className="hs-side__name">{side}-side</span>
      <span className="hs-side__state">
        {done
          ? 'agreed (made the request)'
          : `awaiting a lead's approval — ${SIDE_LEADS[pending] ?? 'a counterparty lead'}`}
      </span>
    </div>
  );
  return (
    <div className="hs-sides">
      {row(agreed, true)}
      {row(pending, false)}
    </div>
  );
}

export function Milestones({
  api,
  dealId,
  capabilities,
  dealActive,
  dealClosed,
  myUserId,
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  dealActive: boolean;
  dealClosed: boolean;
  myUserId: string;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [currentStage, setCurrentStage] = useState(1);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [handshakes, setHandshakes] = useState<Handshake[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useAsk();
  const { members } = useMemberNames(api, dealId);
  const mySide = members.find((m) => m.userId === myUserId)?.side;

  /** Whether the current user is on the side that decides this handshake. */
  const canDecide = (h: Handshake): boolean => {
    if (!mySide) return false;
    if (isSameSideDelete(h)) return mySide === h.initiatedSide && myUserId !== h.initiatedBy;
    return mySide !== h.initiatedSide;
  };

  const load = useCallback(() => {
    setMsg(null);
    api
      .stages(dealId)
      .then((r) => {
        setStages(r.stages);
        setCurrentStage(r.currentStage);
        return api.checklist(dealId, r.currentStage);
      })
      .then((c) => setItems(c.items))
      .catch((e: unknown) => setMsg(humanizeError(String(e))));
    api
      .handshakes(dealId)
      .then((r) => setHandshakes(r.handshakes.filter((h) => h.status === 'pending')))
      .catch(() => setHandshakes([]));
  }, [api, dealId]);

  usePoll(load, 10_000, [load]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e: unknown) => setMsg(humanizeError(String(e))));
  const atLast = currentStage >= 6;
  const nextStageName =
    stages.find((s) => s.n === currentStage + 1)?.name ?? `stage ${currentStage + 1}`;
  const pendingAdvance = handshakes.some((h) => h.action === 'advance_stage');
  const pendingClose = handshakes.some((h) => h.action === 'close_deal');

  const requestAdvance = () => {
    setBusy(true);
    setMsg(null);
    api
      .advance(dealId)
      .then(load)
      .catch((e: unknown) => setMsg(humanizeError(String(e))))
      .finally(() => setBusy(false));
  };

  // The final step of the pipeline: closing the deal is a `close_deal` handshake.
  const requestClose = async () => {
    const reason = await ask({
      title: 'Request completion of this deal?',
      body: 'Once the counterparty approves, the deal is marked CLOSED and the workspace becomes a permanent, read-only record.',
      input: true,
      placeholder: 'Note / reason (optional)',
      confirmLabel: 'Request completion',
    });
    if (reason == null) return;
    setBusy(true);
    setMsg(null);
    api
      .setDealStatus(dealId, 'CLOSED', reason || undefined)
      .then(load)
      .catch((e: unknown) => setMsg(humanizeError(String(e))))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {msg && <p className="error">{msg}</p>}

      <ol className="stepper">
        {stages.map((s) => {
          const state =
            dealClosed || s.status === 'completed'
              ? 'done'
              : s.status === 'in_progress'
                ? 'current'
                : 'todo';
          return (
            <li key={s.n} className={`step step--${state}`}>
              <span className="step__dot" aria-hidden="true" />
              <span>
                <span className="step__name">{s.name}</span>
                <span className="step__meta">
                  {dealClosed && s.status !== 'completed' ? 'completed' : s.status.replace('_', ' ')}
                  {s.targetDate ? ` · target ${s.targetDate}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      {!atLast && dealActive && (pendingAdvance || capabilities.advanceMilestone) && (
        <div style={{ marginTop: 14 }}>
          {pendingAdvance ? (
            <p className="muted" style={{ margin: 0 }}>
              ⏳ Advance to <strong>{nextStageName}</strong> requested — waiting for the counterparty
              to approve it below.
            </p>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={requestAdvance}
            >
              {busy ? 'Requesting…' : `Request advance to ${nextStageName}`}
            </button>
          )}
        </div>
      )}

      {atLast && dealActive && (pendingClose || capabilities.changeDealStatus) && (
        <div style={{ marginTop: 14 }}>
          {pendingClose ? (
            <p className="muted" style={{ margin: 0 }}>
              ⏳ <strong>Deal completion</strong> requested — waiting for the counterparty to approve
              it below.
            </p>
          ) : (
            <button
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={() => void requestClose()}
            >
              {busy ? 'Requesting…' : 'Request deal completion (close)'}
            </button>
          )}
        </div>
      )}

      <h4>Checklist — current stage</h4>
      {items.length === 0 && <p className="empty">No checklist items.</p>}
      <ul className="checklist">
        {items.map((it) => (
          <li key={it.itemId}>
            <input
              type="checkbox"
              id={`chk-${it.itemId}`}
              checked={it.done}
              disabled={!capabilities.editChecklist}
              onChange={(e) =>
                void act(api.toggleChecklistItem(dealId, currentStage, it.itemId, e.target.checked))
              }
            />
            <label htmlFor={`chk-${it.itemId}`} className={it.done ? 'done' : ''}>
              {it.title}
            </label>
          </li>
        ))}
      </ul>

      {handshakes.length > 0 && (
        <>
          <h4>Pending handshakes</h4>
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            A handshake needs a lead on <em>each</em> side. The side that made the request has
            already agreed; a lead on the approving side acts below.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {handshakes.map((h) => (
              <div key={h.hsId} className="card card--warn">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{ACTION_LABEL[h.action] ?? h.action}</strong>
                  <span className="tag">{h.action}</span>
                </div>
                {describeHandshake(h, stages, currentStage) && (
                  <p style={{ margin: '4px 0 0', fontSize: 13 }}>
                    {describeHandshake(h, stages, currentStage)}
                  </p>
                )}
                <HandshakeSides h={h} />
                {canDecide(h) ? (
                  <span className="btn-row" style={{ marginTop: 8 }}>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => void act(api.approveHandshake(dealId, h.hsId))}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn--danger btn--sm"
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
                        void act(api.rejectHandshake(dealId, h.hsId, reason || undefined));
                      }}
                    >
                      Reject
                    </button>
                  </span>
                ) : (
                  <p className="muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
                    {isSameSideDelete(h)
                      ? '⏳ Waiting for another lead on your side to approve — no action needed from you.'
                      : '⏳ Requested by your side — waiting for the counterparty to approve. No action needed here.'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
