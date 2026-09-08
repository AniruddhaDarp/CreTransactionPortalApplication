import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Deal, DealsApi, PendingInvite } from '../deals-api.js';
import { roleLabel } from '../roles.js';
import { statusPill } from '../theme.js';

export function DealsList({ api }: { api: DealsApi }) {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .list()
      .then((r) => {
        setDeals(r.deals);
        setPending(r.pendingInvites ?? []);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [api]);

  useEffect(load, [load]);

  const respond = (inv: PendingInvite, action: 'accept' | 'decline') => {
    setBusy(inv.token);
    setError(null);
    const call =
      action === 'accept'
        ? api.accept(inv.dealId, inv.token).then(() => navigate(`/deals/${inv.dealId}`))
        : api.declineInvite(inv.dealId, inv.token).then(load);
    call.catch((e: unknown) => setError(String(e))).finally(() => setBusy(null));
  };

  return (
    <section>
      <div className="deal-header__top" style={{ marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 20, letterSpacing: '-0.015em' }}>My deals</h2>
          <p className="deal-header__sub">Transactions you're a party to.</p>
        </div>
        <Link to="/deals/new" className="btn btn--primary" style={{ marginLeft: 'auto' }}>
          New deal
        </Link>
      </div>

      {error && <p className="error">{error}</p>}

      {pending.length > 0 && (
        <div className="panel" style={{ marginBottom: 18 }}>
          <div className="panel__head">
            <h3>Pending invitations</h3>
            <span className="meta">{pending.length} awaiting your response</span>
          </div>
          <div className="panel__body">
            <ul className="section-list">
              {pending.map((inv) => (
                <li key={inv.token}>
                  <span>{inv.dealAddress ?? inv.dealId}</span>
                  <span className="tag tag--role">{roleLabel(inv.role)}</span>
                  <span className="btn-row" style={{ marginLeft: 'auto' }}>
                    <button
                      className="btn btn--primary btn--sm"
                      disabled={busy === inv.token}
                      onClick={() => respond(inv, 'accept')}
                    >
                      Accept
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={busy === inv.token}
                      onClick={() => respond(inv, 'decline')}
                    >
                      Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!deals && !error && <p className="muted">Loading your deals…</p>}
      {deals && deals.length === 0 && pending.length === 0 && (
        <p className="empty">No deals yet. Create one to begin a transaction workspace.</p>
      )}

      {deals && deals.length > 0 && (
        <ul className="deal-index">
          {deals.map((d) => (
            <li key={d.dealId}>
              <Link to={`/deals/${d.dealId}`}>
                <span className="deal-index__name">{d.label ?? d.address}</span>
                <span className="deal-index__meta">
                  {d.myRole && <span className="tag tag--role">{d.myRole}</span>}
                  <span className={statusPill(d.status)}>{d.status}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
