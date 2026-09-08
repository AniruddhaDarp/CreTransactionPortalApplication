import { useCallback, useState } from 'react';
import type { Capabilities, DealsApi, Handshake, Payment } from '../deals-api.js';
import { useAsk } from './dialog.js';
import { humanizeError } from './errors.js';
import { useMemberNames } from './useMemberNames.js';
import { usePoll } from './usePoll.js';

const KINDS = ['earnest_money', 'additional_deposit', 'closing_funds', 'extension_fee', 'other'];
const METHODS = ['wire', 'check', 'ach', 'other'];
const PARTIES = ['buyer', 'seller', 'escrow', 'lender', 'other'];

// Kinds credited to the buyer at closing — these count toward the purchase price.
// Extension fees / "other" are recorded but excluded from the price total.
const PRICE_KINDS = new Set(['earnest_money', 'additional_deposit', 'closing_funds']);

function statusPill(status: Payment['status']): string {
  if (status === 'confirmed') return 'pill pill--ok';
  if (status === 'void') return 'pill pill--danger';
  return 'pill pill--warn';
}

const money = (n: number) => `$${n.toLocaleString()}`;

export function Payments({
  api,
  dealId,
  capabilities,
  dealActive,
  myUserId,
  acceptedPrice,
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  dealActive: boolean;
  myUserId: string;
  acceptedPrice: number;
}) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [pendingHs, setPendingHs] = useState<Record<string, Handshake>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [formKind, setFormKind] = useState('earnest_money');
  const [formPayer, setFormPayer] = useState('buyer');
  const ask = useAsk();
  const { members } = useMemberNames(api, dealId);
  const mySide = members.find((m) => m.userId === myUserId)?.side;

  const priceDefault = PRICE_KINDS.has(formKind) && formPayer === 'buyer';

  const load = useCallback(() => {
    setMsg(null);
    api
      .payments(dealId)
      .then((r) => setPayments(r.payments))
      .catch((e: unknown) => setMsg(humanizeError(String(e))));
    api
      .handshakes(dealId)
      .then((r) => {
        const byPay: Record<string, Handshake> = {};
        for (const h of r.handshakes) {
          if (
            h.status === 'pending' &&
            (h.action === 'confirm_payment' || h.action === 'void_payment')
          ) {
            const pid = String(h.payload?.payId ?? '');
            if (pid) byPay[pid] = h;
          }
        }
        setPendingHs(byPay);
      })
      .catch(() => {});
  }, [api, dealId]);

  usePoll(load, 8_000, [load]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e: unknown) => setMsg(humanizeError(String(e))));
  const canRecord = capabilities.recordPayment && dealActive;

  // Progress toward the accepted purchase price. A payment counts if it was
  // flagged as applying to the price (older rows fall back to the kind).
  const inTally = (p: Payment) => p.appliesToPrice ?? PRICE_KINDS.has(p.kind);
  const sumWhere = (pred: (p: Payment) => boolean) =>
    payments.filter(pred).reduce((n, p) => n + p.amount, 0);
  const confirmedToPrice = sumWhere((p) => p.status === 'confirmed' && inTally(p));
  const pendingToPrice = sumWhere((p) => p.status === 'recorded' && inTally(p));
  const remainingToPrice = acceptedPrice - confirmedToPrice;

  return (
    <>
      {msg && <p className="error">{msg}</p>}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Recording only — the portal never moves funds. Each payment is confirmed by the counterparty
        through a handshake; voiding one also needs a handshake. Pending handshakes can be approved
        on the row below (or in the Milestones tab).
      </p>

      <div className="card" style={{ marginBottom: 12, display: 'grid', gap: 4, fontSize: 13 }}>
        <div>
          <strong>{money(confirmedToPrice)}</strong> confirmed toward the {money(acceptedPrice)}{' '}
          accepted price
          {pendingToPrice > 0 && (
            <span className="muted"> · {money(pendingToPrice)} awaiting confirmation</span>
          )}
        </div>
        <div className={remainingToPrice < 0 ? 'pill pill--danger' : 'muted'} style={{ justifySelf: 'start' }}>
          {remainingToPrice >= 0
            ? `${money(remainingToPrice)} remaining`
            : `${money(-remainingToPrice)} over the accepted price`}
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          Counts only payments marked “toward the purchase price” when recorded (buyer deposits and
          the buyer’s cash to close — not lender proceeds or fees).
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th className="num">Amount</th>
              <th>Method</th>
              <th>Flow</th>
              <th>Paid on</th>
              <th>Reference</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.payId}>
                <td>
                  {p.kind.replace(/_/g, ' ')}
                  {inTally(p) && (
                    <span className="muted" style={{ fontSize: 11 }} title="Counts toward the purchase price">
                      {' '}
                      · price
                    </span>
                  )}
                </td>
                <td className="num money">{money(p.amount)}</td>
                <td className="muted">{p.method}</td>
                <td className="muted">
                  {p.payer} → {p.payee}
                </td>
                <td className="num">{p.paidOn}</td>
                <td className="muted">{p.reference || '—'}</td>
                <td>
                  <span className={statusPill(p.status)}>{p.status}</span>
                  {p.status === 'void' && p.voidReason ? (
                    <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                      {p.voidReason}
                    </span>
                  ) : null}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {pendingHs[p.payId] && (
                    <span
                      className="btn-row"
                      style={{ display: 'inline-flex', gap: 6, marginRight: 8, verticalAlign: 'middle' }}
                    >
                      <span className="pill pill--warn" style={{ fontSize: 11 }}>
                        {pendingHs[p.payId]!.action === 'void_payment' ? 'void' : 'confirm'} pending ·{' '}
                        {pendingHs[p.payId]!.initiatedSide === 'buy' ? 'buy' : 'sell'} side asked
                      </span>
                      {!dealActive || !mySide || pendingHs[p.payId]!.initiatedSide === mySide ? (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {dealActive ? 'waiting on the counterparty' : 'deal closed'}
                        </span>
                      ) : (
                        <>
                          <button
                            className="btn btn--primary btn--sm"
                            onClick={() =>
                              void act(api.approveHandshake(dealId, pendingHs[p.payId]!.hsId))
                            }
                          >
                            Approve
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={async () => {
                              const reason = await ask({
                                title: 'Reject this payment handshake?',
                                input: true,
                                placeholder: 'Reason (optional)',
                                danger: true,
                                confirmLabel: 'Reject',
                              });
                              if (reason == null) return;
                              void act(
                                api.rejectHandshake(
                                  dealId,
                                  pendingHs[p.payId]!.hsId,
                                  reason || undefined,
                                ),
                              );
                            }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </span>
                  )}
                  {dealActive && capabilities.recordPayment && p.status === 'recorded' && !pendingHs[p.payId] && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => void act(api.confirmPayment(dealId, p.payId))}
                      title="Re-open the confirmation handshake"
                    >
                      Request confirm
                    </button>
                  )}{' '}
                  {dealActive && capabilities.recordPayment && p.status !== 'void' && (
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={async () => {
                        const reason = await ask({
                          title: 'Void this payment?',
                          body: 'This opens a handshake — the counterparty must approve the void.',
                          input: true,
                          placeholder: 'Reason (optional)',
                          danger: true,
                          confirmLabel: 'Void',
                        });
                        if (reason == null) return;
                        void act(api.voidPayment(dealId, p.payId, reason || undefined));
                      }}
                    >
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <span className="empty">No payments recorded.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {canRecord && (
        <>
          <h4>Record a payment</h4>
          <form
            className="form-inline"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const d = new FormData(form);
              const amount = Number(d.get('amount'));
              if (!(amount > 0)) {
                setMsg('amount must be a positive number');
                return;
              }
              const kind = String(d.get('kind'));
              const appliesToPrice = d.get('appliesToPrice') != null;
              const body: Record<string, unknown> = {
                kind,
                amount,
                method: String(d.get('method')),
                payer: String(d.get('payer')),
                payee: String(d.get('payee')),
                paidOn: String(d.get('paidOn')),
                reference: String(d.get('reference') || '') || undefined,
                note: String(d.get('note') || '') || undefined,
                appliesToPrice,
              };
              void (async () => {
                if (appliesToPrice) {
                  const projected = confirmedToPrice + pendingToPrice + amount;
                  if (projected > acceptedPrice) {
                    const ok = await ask({
                      title: 'This exceeds the accepted price',
                      body: `Payments toward the price would total ${money(
                        projected,
                      )}, over the accepted ${money(acceptedPrice)}. Record it anyway?`,
                      danger: true,
                      confirmLabel: 'Record anyway',
                    });
                    if (ok == null) return;
                  }
                }
                await act(api.recordPayment(dealId, body)).then(() => {
                  form.reset();
                  setFormKind('earnest_money');
                  setFormPayer('buyer');
                });
              })();
            }}
          >
            <label className="field">
              <span>Kind</span>
              <select
                className="select"
                name="kind"
                value={formKind}
                onChange={(e) => setFormKind(e.target.value)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Amount (USD)</span>
              <input className="input" name="amount" type="number" min="1" step="0.01" required />
            </label>
            <label className="field">
              <span>Method</span>
              <select className="select" name="method" defaultValue="wire">
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Payer</span>
              <select
                className="select"
                name="payer"
                value={formPayer}
                onChange={(e) => setFormPayer(e.target.value)}
              >
                {PARTIES.map((pp) => (
                  <option key={pp}>{pp}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Payee</span>
              <select className="select" name="payee" defaultValue="escrow">
                {PARTIES.map((pp) => (
                  <option key={pp}>{pp}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Paid on</span>
              <input className="input" name="paidOn" type="date" required />
            </label>
            <label className="field">
              <span>Reference</span>
              <input className="input" name="reference" placeholder="wire / check no." />
            </label>
            <label className="field">
              <span>Note</span>
              <input className="input" name="note" placeholder="optional" />
            </label>
            <label
              className="field"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'end' }}
            >
              <input
                type="checkbox"
                name="appliesToPrice"
                key={String(priceDefault)}
                defaultChecked={priceDefault}
              />
              <span style={{ fontSize: 12.5 }}>Counts toward the purchase price</span>
            </label>
            <button className="btn btn--primary" type="submit">
              Record &amp; request confirmation
            </button>
          </form>
        </>
      )}
    </>
  );
}
