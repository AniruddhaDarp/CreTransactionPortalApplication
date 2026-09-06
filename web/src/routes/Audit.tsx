import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent, DealsApi } from '../deals-api.js';

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
];

export function Audit({ api, dealId }: { api: DealsApi; dealId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [actor, setActor] = useState('');
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
      .catch((e: unknown) => setErr(String(e)));
  }, [api, dealId, filters]);

  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

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
      setErr(String(e));
    }
  };

  return (
    <section>
      <h3>Audit trail</h3>
      <p style={{ fontSize: '0.85em', color: '#555' }}>
        You see entries in scopes: {scopes.join(', ') || '—'}. There is no cross-side view.
      </p>
      {err && <p style={{ color: '#b00' }}>{err}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>
          actor
          <br />
          <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="user id" />
        </label>
        <label>
          action
          <br />
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a || '(any)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          from
          <br />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          to
          <br />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={load}>Apply</button>
        <button onClick={() => void download('csv')}>Export CSV</button>
        <button onClick={() => void download('json')}>Export JSON</button>
      </div>

      <table style={{ marginTop: '1rem', borderCollapse: 'collapse', fontSize: '0.88em' }}>
        <thead>
          <tr>
            <th align="left">When</th>
            <th align="left">Actor</th>
            <th align="left">Action</th>
            <th align="left">Scope</th>
            <th align="left">Summary</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.eventId}>
              <td>{e.occurredAt.slice(0, 19).replace('T', ' ')}</td>
              <td>{e.actorId ? e.actorId.slice(0, 8) : '—'}</td>
              <td>{e.detailType}</td>
              <td>{e.scope}</td>
              <td>{e.summary}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={5}>No audit entries in your scope for this filter.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
