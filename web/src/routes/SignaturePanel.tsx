import { useCallback, useEffect, useState } from 'react';
import type { DealsApi, Member, SignatureEnvelope } from '../deals-api.js';

function statusPill(status: string): string {
  if (status === 'completed') return 'pill pill--ok';
  if (status === 'declined' || status === 'voided') return 'pill pill--danger';
  return 'pill pill--warn';
}

const short = (id: string) => id.slice(0, 8);

export function SignaturePanel({
  api,
  dealId,
  docId,
  myUserId,
  canSend,
}: {
  api: DealsApi;
  dealId: string;
  docId: string;
  myUserId: string;
  canSend: boolean;
}) {
  const [envelopes, setEnvelopes] = useState<SignatureEnvelope[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .signatures(dealId, docId)
      .then((r) => setEnvelopes(r.envelopes))
      .catch((e: unknown) => setErr(String(e)));
  }, [api, dealId, docId]);

  useEffect(load, [load]);
  useEffect(() => {
    if (canSend) api.members(dealId).then((r) => setMembers(r.members)).catch(() => {});
  }, [api, dealId, canSend]);

  const act = (p: Promise<unknown>) => {
    setErr(null);
    void p.then(load).catch((e: unknown) => setErr(String(e)));
  };

  const send = () => {
    const signerUserIds = Object.entries(picked)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (signerUserIds.length === 0) {
      setErr('pick at least one signer');
      return;
    }
    act(api.createSignature(dealId, docId, { signerUserIds }).then(() => setPicked({})));
  };

  return (
    <div style={{ marginTop: 12 }}>
      <h4 style={{ margin: '0 0 6px' }}>Signatures</h4>
      {err && <p className="error">{err}</p>}

      <ul className="section-list">
        {envelopes.map((env) => {
          const mine = env.recipients.find((r) => r.userId === myUserId);
          const canSign = env.status === 'sent' && mine && mine.status === 'sent';
          return (
            <li key={env.envId} style={{ flexWrap: 'wrap' }}>
              <span className={statusPill(env.status)}>{env.status}</span>
              <span>{env.subject}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                via {env.provider}
                {env.signedVersion ? ` · signed copy v${env.signedVersion}` : ''}
              </span>
              <span className="btn-row" style={{ flexBasis: '100%', marginTop: 4 }}>
                {env.recipients.map((r) => (
                  <span key={r.userId} className={`tag tag--role`} title={r.userId}>
                    {short(r.userId)}: {r.status}
                  </span>
                ))}
              </span>
              <span className="btn-row" style={{ marginLeft: 'auto' }}>
                {canSign && (
                  <>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => act(api.signEnvelope(dealId, docId, env.envId))}
                    >
                      Sign
                    </button>
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() =>
                        act(
                          api.signEnvelope(dealId, docId, env.envId, {
                            decline: true,
                            reason: window.prompt('Reason for declining?') || undefined,
                          }),
                        )
                      }
                    >
                      Decline
                    </button>
                  </>
                )}
                {env.status === 'sent' && env.createdBy === myUserId && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      act(api.voidEnvelope(dealId, docId, env.envId, window.prompt('Reason?') || undefined))
                    }
                  >
                    Void
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {envelopes.length === 0 && (
          <li>
            <span className="empty">No signature requests for this document.</span>
          </li>
        )}
      </ul>

      {canSend && (
        <div className="card card--warn" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Send this document for signature</div>
          <div className="btn-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {members
              .filter((m) => m.status === 'active' && m.role !== 'OTHER')
              .map((m) => (
                <label key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={!!picked[m.userId]}
                    onChange={(e) => setPicked((p) => ({ ...p, [m.userId]: e.target.checked }))}
                  />
                  {m.role} <span className="muted">({short(m.userId)})</span>
                </label>
              ))}
          </div>
          <button className="btn btn--primary btn--sm" style={{ marginTop: 8 }} onClick={send}>
            Send for signature
          </button>
        </div>
      )}
    </div>
  );
}
