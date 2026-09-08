import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent, DealsApi } from '../deals-api.js';
import { scopeTag } from '../theme.js';
import { isMembershipSyncing, SYNCING_NOTE } from './sync.js';
import { useMemberNames } from './useMemberNames.js';
import { humanizeError } from './errors.js';
import { usePoll } from './usePoll.js';

const ACTIONS = [
  '',
  'deal.created',
  'deal.updated',
  'deal.status_changed',
  'member.joined',
  'member.removed',
  'stage.advanced',
  'handshake.requested',
  'handshake.approved',
  'handshake.rejected',
  'thread.created',
  'message.posted',
  'document.uploaded',
  'document.accessed',
  'document.archived',
  'docrequest.created',
  'payment.recorded',
  'payment.confirmed',
  'payment.voided',
  'signature.requested',
  'signature.completed',
  'signature.declined',
  'signature.voided',
];

export function Audit({ api, dealId }: { api: DealsApi; dealId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [actor, setActor] = useState('');
  const { label, members } = useMemberNames(api, dealId);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters = useCallback((): Record<string, string> => {
    const p: Record<string, string> = {};
    if (actor) p.actor = actor;
    if (action) p.action = action;
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [actor, action, from, to]);

  const load = useCallback(() => {
    setErr(null);
    api
      .audit(dealId, filters())
      .then((r) => {
        setEvents(r.events);
        setScopes(r.scopes);
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  }, [api, dealId, filters]);

  usePoll(load, 12_000, [load]);
  // while the membership projection is catching up, retry quickly
  useEffect(() => {
    if (!err || !isMembershipSyncing(err)) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [err, load]);

  const download = async (format: 'csv' | 'json') => {
    try {
      const { blob, filename } = await api.auditExport(dealId, format, filters());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(humanizeError(String(e)));
    }
  };

  return (
    <>
      <p className="scope-note">
        Showing entries in your visible scopes:{' '}
        {scopes.length
          ? scopes.map((s) => (
              <span key={s} className={scopeTag(s).cls} style={{ marginRight: 4 }}>
                {scopeTag(s).label}
              </span>
            ))
          : '—'}
        . There is no cross-side view.
      </p>
      {err &&
        (isMembershipSyncing(err) ? (
          <p className="muted">{SYNCING_NOTE}</p>
        ) : (
          <p className="error">{err}</p>
        ))}

      <div className="toolbar">
        <label className="field">
          <span>Actor</span>
          <select className="select" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">(anyone)</option>
            {members
              .filter((m) => m.status === 'active')
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {label(m.userId)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Action</span>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a || '(any)'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span>To</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn btn--sm" onClick={load}>
          Apply
        </button>
        <span className="spacer" />
        <button className="btn btn--ghost btn--sm" onClick={() => void download('csv')}>
          Export CSV
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void download('json')}>
          Export JSON
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Scope</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.eventId}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {e.occurredAt.slice(0, 19).replace('T', ' ')}
                </td>
                <td>{e.actorId ? label(e.actorId) : '—'}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {e.detailType}
                </td>
                <td>
                  <span className={scopeTag(e.scope).cls}>{scopeTag(e.scope).label}</span>
                </td>
                <td>{e.summary}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <span className="empty">No audit entries in your scope for this filter.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
