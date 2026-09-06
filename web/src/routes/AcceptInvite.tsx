import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { DealsApi } from '../deals-api.js';

export function AcceptInvite({ api }: { api: DealsApi }) {
  const { dealId = '', token = '' } = useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<{
    dealAddress: string | null;
    role: string;
    status: string;
    expired: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .previewInvite(dealId, token)
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [api, dealId, token]);

  if (error) return <p>Invitation problem: {error}</p>;
  if (!preview) return <p>Checking invitation…</p>;
  if (preview.status !== 'pending') return <p>This invitation is {preview.status}.</p>;
  if (preview.expired) return <p>This invitation has expired.</p>;

  return (
    <section>
      <h2>Join a deal</h2>
      <p>
        You&rsquo;ve been invited to <strong>{preview.dealAddress ?? dealId}</strong> as{' '}
        <strong>{preview.role}</strong>.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api
            .accept(dealId, token)
            .then(() => navigate(`/deals/${dealId}`))
            .catch((e: unknown) => {
              setError(String(e));
              setBusy(false);
            });
        }}
      >
        {busy ? 'Joining…' : 'Accept & join'}
      </button>
    </section>
  );
}
