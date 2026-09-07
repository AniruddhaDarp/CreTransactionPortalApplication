import { useEffect, useState, type ReactNode } from 'react';
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

  const wrap = (body: ReactNode) => (
    <section>
      <div className="panel" style={{ maxWidth: 460 }}>
        <div className="panel__head">
          <h3>Deal invitation</h3>
        </div>
        <div className="panel__body">{body}</div>
      </div>
    </section>
  );

  if (error) return wrap(<p className="error">Invitation problem: {error}</p>);
  if (!preview) return wrap(<p className="muted">Checking invitation…</p>);
  if (preview.status !== 'pending')
    return wrap(<p className="empty">This invitation is {preview.status}.</p>);
  if (preview.expired) return wrap(<p className="empty">This invitation has expired.</p>);

  return wrap(
    <>
      <p>
        You&rsquo;ve been invited to <strong>{preview.dealAddress ?? dealId}</strong> as{' '}
        <span className="tag tag--role">{preview.role}</span>.
      </p>
      <button
        className="btn btn--primary"
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
    </>,
  );
}
