import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, ChecklistItem, DealsApi, Handshake, Stage } from '../deals-api.js';

export function Milestones({
  api,
  dealId,
  capabilities,
  dealActive,
}: {
  api: DealsApi;
  dealId: string;
  capabilities: Capabilities;
  dealActive: boolean;
}) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [currentStage, setCurrentStage] = useState(1);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [handshakes, setHandshakes] = useState<Handshake[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setMsg(null);
    api
      .stages(dealId)
      .then((r) => {
        setStages(r.stages);
        setCurrentStage(r.currentStage);
        return api.checklist(dealId, r.currentStage);
      })
      .then((c) => setItems(c.items))
      .catch((e: unknown) => setMsg(String(e)));
    api
      .handshakes(dealId)
      .then((r) => setHandshakes(r.handshakes.filter((h) => h.status === 'pending')))
      .catch(() => setHandshakes([]));
  }, [api, dealId]);

  useEffect(load, [load]);

  const act = (p: Promise<unknown>) => p.then(load).catch((e: unknown) => setMsg(String(e)));
  const atLast = currentStage >= 6;

  return (
    <>
      {msg && <p className="error">{msg}</p>}

      <ol className="stepper">
        {stages.map((s) => {
          const state =
            s.status === 'completed' ? 'done' : s.status === 'in_progress' ? 'current' : 'todo';
          return (
            <li key={s.n} className={`step step--${state}`}>
              <span className="step__dot" aria-hidden="true" />
              <span>
                <span className="step__name">{s.name}</span>
                <span className="step__meta">
                  {s.status.replace('_', ' ')}
                  {s.targetDate ? ` · target ${s.targetDate}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      {capabilities.advanceMilestone && dealActive && !atLast && (
        <div style={{ marginTop: 14 }}>
          <button className="btn btn--primary btn--sm" onClick={() => void act(api.advance(dealId))}>
            Request advance to stage {currentStage + 1}
          </button>
        </div>
      )}

      <h4>Checklist — current stage</h4>
      {items.length === 0 && <p className="empty">No checklist items.</p>}
      <ul className="checklist">
        {items.map((it) => (
          <li key={it.itemId}>
            <input
              type="checkbox"
              id={`chk-${it.itemId}`}
              checked={it.done}
              disabled={!capabilities.editChecklist}
              onChange={(e) =>
                void act(api.toggleChecklistItem(dealId, currentStage, it.itemId, e.target.checked))
              }
            />
            <label htmlFor={`chk-${it.itemId}`} className={it.done ? 'done' : ''}>
              {it.title}
            </label>
          </li>
        ))}
      </ul>

      {handshakes.length > 0 && (
        <>
          <h4>Pending handshakes</h4>
          <div style={{ display: 'grid', gap: 8 }}>
            {handshakes.map((h) => (
              <div key={h.hsId} className="card card--warn">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="tag">{h.action}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    initiated by {h.initiatedSide}-side
                  </span>
                  <span className="btn-row" style={{ marginLeft: 'auto' }}>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={() => void act(api.approveHandshake(dealId, h.hsId))}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() =>
                        void act(api.rejectHandshake(dealId, h.hsId, prompt('Reason?') ?? undefined))
                      }
                    >
                      Reject
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
