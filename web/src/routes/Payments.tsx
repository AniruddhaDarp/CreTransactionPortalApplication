import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, DealsApi, Payment } from '../deals-api.js';

const KINDS = ['earnest_money', 'additional_deposit', 'closing_funds', 'extension_fee', 'other'];
const METHODS = ['wire', 'check', 'ach', 'other'];
const PARTIES = ['buyer', 'seller', 'escrow', 'lender', 'other'];

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
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  dealActive: boolean;
}) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setMsg(null);
    api
      .payments(dealId)
      .then((r) => setPayments(r.payments))
      .catch((e: unknown) => setMsg(String(e)));
  }, [api, dealId]);

  useEffect(load, [load]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e: unknown) => setMsg(String(e)));
  const canRecord = capabilities.recordPayment && dealActive;

  return (
    <>
      {msg && <p className="error">{msg}</p>}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Recording only — the portal never moves funds. Each payment is confirmed by the counterparty
        through a handshake; voiding one also needs a handshake. Approve pending payment handshakes
        in the Milestones panel.
      </p>

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
                <td>{p.kind.replace(/_/g, ' ')}</td>
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
                  {capabilities.recordPayment && p.status === 'recorded' && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => void act(api.confirmPayment(dealId, p.payId))}
                      title="Re-open the confirmation handshake"
                    >
                      Request confirm
                    </button>
                  )}{' '}
                  {capabilities.recordPayment && p.status !== 'void' && (
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() =>
                        void act(api.voidPayment(dealId, p.payId, prompt('Reason for void?') ?? undefined))
                      }
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
              const d = new FormData(e.currentTarget);
              const amount = Number(d.get('amount'));
              if (!(amount > 0)) {
                setMsg('amount must be a positive number');
                return;
              }
              const body: Record<string, unknown> = {
                kind: String(d.get('kind')),
                amount,
                method: String(d.get('method')),
                payer: String(d.get('payer')),
                payee: String(d.get('payee')),
                paidOn: String(d.get('paidOn')),
                reference: String(d.get('reference') || '') || undefined,
                note: String(d.get('note') || '') || undefined,
              };
              const form = e.currentTarget;
              act(api.recordPayment(dealId, body)).then(() => form.reset());
            }}
          >
            <label className="field">
              <span>Kind</span>
              <select className="select" name="kind" defaultValue="earnest_money">
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
              <select className="select" name="payer" defaultValue="buyer">
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
            <button className="btn btn--primary" type="submit">
              Record &amp; request confirmation
            </button>
          </form>
        </>
      )}
    </>
  );
}
