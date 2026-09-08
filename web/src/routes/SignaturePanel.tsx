import { useCallback, useRef, useState } from 'react';
import type { DealsApi, SignatureEnvelope } from '../deals-api.js';
import { useAsk } from './dialog.js';
import { humanizeError } from './errors.js';
import { useMemberNames } from './useMemberNames.js';
import { usePoll } from './usePoll.js';

/** green = completed, red = declined/voided, amber = pending (sent). */
function statusPill(status: string): string {
  if (status === 'completed') return 'pill pill--ok';
  if (status === 'declined' || status === 'voided') return 'pill pill--danger';
  return 'pill pill--warn';
}

/** Turn a raw API error into something readable — swap any internal signer id
 *  for the member's name, otherwise defer to the shared humanizer. */
function friendlyErr(raw: string, label: (id: string) => string): string {
  const inner = /\{"error":"([^"]+)"/.exec(raw)?.[1] ?? raw;
  const badId = /signer ([0-9a-fA-F-]{6,}) cannot see this document/.exec(inner)?.[1];
  if (badId) {
    return `${label(badId)} can't be a signer on this document — it's outside their access (scope or category).`;
  }
  return humanizeError(raw);
}

export function SignaturePanel({
  api,
  dealId,
  docId,
  myUserId,
  canSend,
  dealActive = true,
}: {
  api: DealsApi;
  dealId: string;
  docId: string;
  myUserId: string;
  canSend: boolean;
  dealActive?: boolean;
}) {
  const [envelopes, setEnvelopes] = useState<SignatureEnvelope[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ subject: string; version?: number } | null>(null);
  const seen = useRef<Record<string, string>>({});
  const { label, members } = useMemberNames(api, dealId);
  const ask = useAsk();

  const load = useCallback(() => {
    api
      .signatures(dealId, docId)
      .then((r) => {
        setEnvelopes(r.envelopes);
        for (const e of r.envelopes) {
          if (seen.current[e.envId] && seen.current[e.envId] !== 'completed' && e.status === 'completed') {
            setDone({ subject: e.subject, version: e.signedVersion });
          }
          seen.current[e.envId] = e.status;
        }
      })
      .catch((e: unknown) => setErr(friendlyErr(String(e), label)));
  }, [api, dealId, docId]);

  usePoll(load, 8_000, [load]);

  const act = (p: Promise<unknown>) => {
    setErr(null);
    void p.then(load).catch((e: unknown) => setErr(friendlyErr(String(e), label)));
  };

  const downloadSigned = (n: number) => {
    api
      .documentDownloadUrl(dealId, docId, n)
      .then((r) => window.open(r.url, '_blank', 'noopener'))
      .catch((e: unknown) => setErr(friendlyErr(String(e), label)));
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

      {done && (
        <div
          className="card card--ok"
          style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}
        >
          <span style={{ flex: 1 }}>
            ✅ <strong>Signing complete</strong> — “{done.subject}” is fully signed.
            {done.version ? (
              <>
                {' '}
                The executed copy is saved as <strong>v{done.version}</strong>.
              </>
            ) : null}
          </span>
          {done.version && (
            <button className="btn btn--ghost btn--sm" onClick={() => downloadSigned(done.version!)}>
              Download
            </button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => setDone(null)}>
            Dismiss
          </button>
        </div>
      )}

      <ul className="section-list">
        {envelopes.map((env) => {
          const mine = env.recipients.find((r) => r.userId === myUserId);
          const canSign = dealActive && env.status === 'sent' && mine && mine.status === 'sent';
          return (
            <li key={env.envId} style={{ flexWrap: 'wrap' }}>
              <span className={statusPill(env.status)}>{env.status}</span>
              <span>{env.subject}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                via {env.provider}
                {env.signedVersion ? ` · signed copy v${env.signedVersion}` : ''}
              </span>
              <span
                className="btn-row"
                style={{ flexBasis: '100%', marginTop: 4, flexWrap: 'wrap', gap: 6 }}
              >
                {env.recipients.map((r) => (
                  <span key={r.userId} className={statusPill(r.status)} style={{ fontSize: 11 }}>
                    {label(r.userId)} &middot; {r.status}
                  </span>
                ))}
              </span>
              <span className="btn-row" style={{ marginLeft: 'auto' }}>
                {canSign && (
                  <>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() =>
                        act(
                          api.signEnvelope(dealId, docId, env.envId).then((r) => {
                            if (r.status === 'completed')
                              setDone({ subject: env.subject, version: r.signedVersion });
                          }),
                        )
                      }
                    >
                      Sign
                    </button>
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={async () => {
                        const reason = await ask({
                          title: 'Decline to sign?',
                          body: `“${env.subject}” — the sender will be notified.`,
                          input: true,
                          placeholder: 'Reason (optional)',
                          danger: true,
                          confirmLabel: 'Decline',
                        });
                        if (reason == null) return;
                        act(
                          api.signEnvelope(dealId, docId, env.envId, {
                            decline: true,
                            reason: reason || undefined,
                          }),
                        );
                      }}
                    >
                      Decline
                    </button>
                  </>
                )}
                {dealActive && env.status === 'sent' && env.createdBy === myUserId && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      const reason = await ask({
                        title: 'Void this signature request?',
                        body: `“${env.subject}” — all pending signers lose access to sign.`,
                        input: true,
                        placeholder: 'Reason (optional)',
                        danger: true,
                        confirmLabel: 'Void',
                      });
                      if (reason == null) return;
                      act(api.voidEnvelope(dealId, docId, env.envId, reason || undefined));
                    }}
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
                  {label(m.userId)}
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
