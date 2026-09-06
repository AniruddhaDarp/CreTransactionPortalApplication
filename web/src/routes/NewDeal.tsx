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
      <h2>New deal</h2>
      <p>A deal starts at an accepted offer. You become its admin (seller&rsquo;s agent).</p>
      {error && <p>Could not create: {error}</p>}
      <form
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
        <p>
          <label>
            Property address
            <br />
            <input name="address" required minLength={3} size={40} />
          </label>
        </p>
        <p>
          <label>
            Type{' '}
            <select name="propertyType">
              {PROPERTY_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Accepted price (USD) <input name="price" type="number" min={1} required />
          </label>
        </p>
        <p>
          <label>
            Label (optional) <input name="label" maxLength={80} />
          </label>
        </p>
        <p>
          <label>
            Target closing date (optional) <input name="targetClosingDate" type="date" />
          </label>
        </p>
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create deal'}
        </button>
      </form>
    </section>
  );
}
