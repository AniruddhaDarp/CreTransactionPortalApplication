import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DealsApi } from '../deals-api.js';

const PROPERTY_TYPES = ['office', 'retail', 'industrial', 'multifamily', 'land', 'residential'];

export function NewDeal({ api }: { api: DealsApi }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section>
      <h2 style={{ fontSize: 20, letterSpacing: '-0.015em' }}>New deal</h2>
      <p className="deal-header__sub" style={{ marginBottom: 18 }}>
        A deal starts at an accepted offer. You become its admin (seller&rsquo;s agent).
      </p>
      {error && <p className="error">Could not create: {error}</p>}

      <form
        className="panel"
        style={{ maxWidth: 480 }}
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          const body: Record<string, unknown> = {
            address: String(d.get('address') ?? ''),
            propertyType: String(d.get('propertyType') ?? ''),
            price: Number(d.get('price') ?? 0),
          };
          const label = String(d.get('label') ?? '');
          if (label) body.label = label;
          const closing = String(d.get('targetClosingDate') ?? '');
          if (closing) body.targetClosingDate = closing;
          setBusy(true);
          setError(null);
          api
            .create(body)
            .then((deal) => navigate(`/deals/${deal.dealId}`))
            .catch((err: unknown) => {
              setError(String(err));
              setBusy(false);
            });
        }}
      >
        <div className="panel__body form-grid" style={{ maxWidth: 'none' }}>
          <label className="field">
            <span>Property address</span>
            <input className="input" name="address" required minLength={3} />
          </label>
          <label className="field">
            <span>Property type</span>
            <select className="select" name="propertyType">
              {PROPERTY_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Accepted price (USD)</span>
            <input className="input" name="price" type="number" min={1} required />
          </label>
          <label className="field">
            <span>Label (optional)</span>
            <input className="input" name="label" maxLength={80} placeholder="e.g. Larkspur Commons" />
          </label>
          <label className="field">
            <span>Target closing date (optional)</span>
            <input className="input" name="targetClosingDate" type="date" />
          </label>
          <div>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create deal'}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
