import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Deal, DealsApi } from '../deals-api.js';

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
      <h2>My deals</h2>
      <p>
        <Link to="/deals/new">+ New deal</Link>
      </p>
      {error && <p>Could not load deals: {error}</p>}
      {!deals && !error && <p>Loading your deals…</p>}
      {deals && deals.length === 0 && <p>No deals yet.</p>}
      <ul>
        {deals?.map((d) => (
          <li key={d.dealId}>
            <Link to={`/deals/${d.dealId}`}>{d.label ?? d.address}</Link> — {d.status}
            {d.myRole ? ` · ${d.myRole}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
