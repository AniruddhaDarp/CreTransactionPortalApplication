import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Deal, DealsApi } from '../deals-api.js';
import { statusPill } from '../theme.js';

export function DealsList({ api }: { api: DealsApi }) {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .list()
      .then((r) => live && setDeals(r.deals))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [api]);

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

      {error && <p className="error">Could not load deals: {error}</p>}
      {!deals && !error && <p className="muted">Loading your deals…</p>}
      {deals && deals.length === 0 && (
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
