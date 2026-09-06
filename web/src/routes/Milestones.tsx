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

  const act = (p: Promise<unknown>) =>
    p.then(load).catch((e: unknown) => setMsg(String(e)));

  const atLast = currentStage >= 6;

  return (
    <section>
      <h3>Milestones</h3>
      {msg && <p style={{ color: '#b00' }}>{msg}</p>}
      <ol>
        {stages.map((s) => (
          <li key={s.n} style={{ fontWeight: s.status === 'in_progress' ? 700 : 400 }}>
            {s.name} — {s.status.replace('_', ' ')}
            {s.targetDate ? ` · target ${s.targetDate}` : ''}
          </li>
        ))}
      </ol>
      {capabilities.advanceMilestone && dealActive && !atLast && (
        <button onClick={() => void act(api.advance(dealId))}>
          Request advance to stage {currentStage + 1}
        </button>
      )}

      <h4>Checklist — current stage</h4>
      <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
        {items.map((it) => (
          <li key={it.itemId}>
            <label>
              <input
                type="checkbox"
                checked={it.done}
                disabled={!capabilities.editChecklist}
                onChange={(e) =>
                  void act(api.toggleChecklistItem(dealId, currentStage, it.itemId, e.target.checked))
                }
              />{' '}
              {it.title}
              {it.done && it.doneBy ? ' ✓' : ''}
            </label>
          </li>
        ))}
      </ul>

      {handshakes.length > 0 && (
        <>
          <h4>Pending handshakes</h4>
          <ul>
            {handshakes.map((h) => (
              <li key={h.hsId}>
                <code>{h.action}</code> — initiated by {h.initiatedSide}-side{' '}
                <button onClick={() => void act(api.approveHandshake(dealId, h.hsId))}>approve</button>{' '}
                <button
                  onClick={() =>
                    void act(api.rejectHandshake(dealId, h.hsId, prompt('Reason?') ?? undefined))
                  }
                >
                  reject
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
