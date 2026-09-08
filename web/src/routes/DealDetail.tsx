import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Capabilities, Deal, DealsApi, Invite, Member } from '../deals-api.js';
import { roleLabel } from '../roles.js';
import { statusPill } from '../theme.js';
import { Actions } from './Actions.js';
import { Activity } from './Activity.js';
import { Audit } from './Audit.js';
import { Chat } from './Chat.js';
import { Documents } from './Documents.js';
import { Milestones } from './Milestones.js';
import { Payments } from './Payments.js';
import { humanizeError } from './errors.js';
import { usePoll } from './usePoll.js';

const ROLES = [
  'SELLER',
  'SELLER_ATTORNEY',
  'BUYER',
  'BUYER_AGENT',
  'BUYER_ATTORNEY',
  'LENDER',
  'TITLE_AGENT',
  'OTHER',
];

const TABS = [
  { key: 'milestones', label: 'Milestones' },
  { key: 'actions', label: 'Actions' },
  { key: 'chat', label: 'Communication' },
  { key: 'activity', label: 'Activity' },
  { key: 'documents', label: 'Documents' },
  { key: 'payments', label: 'Payments' },
  { key: 'audit', label: 'Audit' },
  { key: 'members', label: 'Members' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function StageBar({
  current,
  total = 6,
  closed = false,
}: {
  current: number;
  total?: number;
  closed?: boolean;
}) {
  const done = closed ? total : current - 1; // stages completed
  const color = (i: number) =>
    i < done ? 'var(--accent)' : i === done && !closed ? 'var(--warn)' : 'var(--line-2)';
  return (
    <div
      style={{ display: 'flex', gap: 3 }}
      aria-label={
        closed
          ? `all ${total} stages complete — deal closed`
          : `${done} of ${total} stages complete, currently in stage ${current}`
      }
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} style={{ width: 26, height: 5, borderRadius: 3, background: color(i) }} />
      ))}
    </div>
  );
}

export function DealDetail({ api, myUserId }: { api: DealsApi; myUserId: string }) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [deal, setDeal] = useState<(Deal & { capabilities: Capabilities }) | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState('SELLER');
  const [copied, setCopied] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [termsNote, setTermsNote] = useState<string | null>(null);
  const [actionCount, setActionCount] = useState(0);

  const rawTab = params.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : 'milestones';
  const setTab = (k: TabKey) =>
    setParams(
      (p) => {
        p.set('tab', k);
        return p;
      },
      { replace: true },
    );

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.get(id), api.members(id)])
      .then(([d, m]) => {
        setDeal(d);
        setMembers(m.members);
        if (d.capabilities.inviteBuySide || d.capabilities.inviteSellSide) {
          api
            .invites(id)
            .then((r) => setInvites(r.invites))
            .catch(() => setInvites([]));
        }
      })
      .catch((e: unknown) => setError(humanizeError(String(e))));
  }, [api, id]);

  useEffect(load, [load]);

  // Keep the header (stage bar, firm flag, status), tab counts and capabilities
  // live while the page stays open — e.g. the counterparty approves a stage
  // advance. Distinct from `load` so a poll tick never clears an action-error
  // banner or the "loading" fallback.
  const refresh = useCallback(() => {
    Promise.all([api.get(id), api.members(id)])
      .then(([d, m]) => {
        setDeal(d);
        setMembers(m.members);
        if (d.capabilities.inviteBuySide || d.capabilities.inviteSellSide) {
          api
            .invites(id)
            .then((r) => setInvites(r.invites))
            .catch(() => {});
        }
      })
      .catch(() => {});
    // Actions-tab badge: handshakes someone else started that wait on a decision
    // from this side, plus documents awaiting this user's signature.
    Promise.all([api.handshakes(id), api.dealSignatures(id)])
      .then(([h, s]) => {
        const hs = h.handshakes.filter(
          (x) => x.status === 'pending' && x.initiatedBy !== myUserId,
        ).length;
        const sign = s.envelopes.filter(
          (e) =>
            e.status === 'sent' &&
            e.recipients.some((r) => r.userId === myUserId && r.status === 'sent'),
        ).length;
        setActionCount(hs + sign);
      })
      .catch(() => {});
  }, [api, id, myUserId]);
  usePoll(refresh, 15_000, [refresh]);

  // A failed *load* replaces the page; a failed *action* (invite, remove, …) is
  // a dismissible banner so you don't lose your place on the deal.
  if (error && !deal) return <p className="error">Could not load deal: {error}</p>;
  if (!deal) return <p className="muted">Loading deal…</p>;

  const canInvite = deal.capabilities.inviteBuySide || deal.capabilities.inviteSellSide;
  const canEditTerms = deal.capabilities.editPurchasePrice || deal.capabilities.editDates;
  const activeLabel = TABS.find((t) => t.key === tab)?.label ?? '';

  const submitTerms = (body: { price?: number; targetClosingDate?: string }) => {
    setTermsNote(null);
    setError(null);
    api
      .terms(id, body)
      .then((r) => {
        setTermsNote(
          r.handshakeId
            ? 'Requested — the counterparty must approve it (see the Milestones tab).'
            : 'Applied.',
        );
        load();
      })
      .catch((e: unknown) => setError(humanizeError(String(e))));
  };

  return (
    <section>
      {error && (
        <div
          className="card card--warn"
          style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="deal-header">
        <div className="deal-header__top">
          <div>
            <h2>{deal.label ?? deal.address}</h2>
            <div className="deal-header__sub">{deal.address}</div>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {canEditTerms && deal.status === 'ACTIVE' && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setShowTerms((v) => !v);
                  setTermsNote(null);
                }}
              >
                {showTerms ? 'Close' : 'Edit terms'}
              </button>
            )}
            <span className={statusPill(deal.status)}>{deal.status}</span>
          </span>
        </div>

        {showTerms && canEditTerms && deal.status === 'ACTIVE' && (
          <div className="card" style={{ marginTop: 14, display: 'grid', gap: 10 }}>
            {termsNote && <p className="muted" style={{ margin: 0 }}>{termsNote}</p>}
            {deal.capabilities.editPurchasePrice && (
              <form
                className="form-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  const price = Number(new FormData(e.currentTarget).get('price'));
                  if (price > 0) submitTerms({ price });
                }}
              >
                <label className="field">
                  <span>New accepted price (USD)</span>
                  <input
                    className="input"
                    name="price"
                    type="number"
                    min={1}
                    defaultValue={deal.price}
                  />
                </label>
                <button className="btn btn--primary btn--sm" type="submit">
                  Request price change
                </button>
              </form>
            )}
            {deal.capabilities.editDates && (
              <form
                className="form-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = String(new FormData(e.currentTarget).get('targetClosingDate') || '');
                  if (d) submitTerms({ targetClosingDate: d });
                }}
              >
                <label className="field">
                  <span>Target closing date</span>
                  <input
                    className="input"
                    name="targetClosingDate"
                    type="date"
                    defaultValue={deal.targetClosingDate ?? ''}
                  />
                </label>
                <button className="btn btn--sm" type="submit">
                  {deal.firm ? 'Request date change' : 'Change closing date'}
                </button>
              </form>
            )}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              A price change is always a handshake. A closing-date change applies directly before the
              deal is firm, and needs a handshake once it is.
            </p>
          </div>
        )}
        <dl className="deal-facts">
          <div>
            <dt>Property type</dt>
            <dd>{deal.propertyType}</dd>
          </div>
          <div>
            <dt>Accepted price</dt>
            <dd className="money">${deal.price.toLocaleString()}</dd>
          </div>
          {deal.targetClosingDate && (
            <div>
              <dt>Target closing</dt>
              <dd className="money">{deal.targetClosingDate}</dd>
            </div>
          )}
          <div>
            <dt>Milestone</dt>
            <dd style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StageBar current={deal.currentStage} closed={deal.status === 'CLOSED'} />
              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                {(deal.status === 'CLOSED' ? 6 : deal.currentStage - 1)} / 6 complete
              </span>
              {deal.firm && <span className="pill pill--accent">Firm</span>}
            </dd>
          </div>
        </dl>
      </div>

      <nav className="deal-tabs" role="tablist" aria-label="Deal sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`deal-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === 'members' && <span className="deal-tab__count">{members.length}</span>}
            {t.key === 'actions' && actionCount > 0 && (
              <span className="deal-tab__count deal-tab__count--alert">{actionCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="panel">
        <div className="panel__head">
          <h3>{activeLabel}</h3>
          {tab === 'members' && <span className="meta">{members.length} parties</span>}
        </div>
        <div className="panel__body">
          {tab === 'milestones' && (
            <Milestones
              api={api}
              dealId={id}
              capabilities={deal.capabilities}
              dealActive={deal.status === 'ACTIVE'}
              dealClosed={deal.status === 'CLOSED'}
              myUserId={myUserId}
            />
          )}
          {tab === 'actions' && (
            <Actions api={api} dealId={id} myUserId={myUserId} goto={setTab} />
          )}
          {tab === 'chat' && (
            <Chat
              api={api}
              dealId={id}
              myUserId={myUserId}
              dealActive={deal.status === 'ACTIVE'}
            />
          )}
          {tab === 'activity' && <Activity api={api} dealId={id} />}
          {tab === 'documents' && (
            <Documents
              api={api}
              dealId={id}
              capabilities={deal.capabilities}
              myUserId={myUserId}
              dealActive={deal.status === 'ACTIVE'}
            />
          )}
          {tab === 'payments' && (
            <Payments
              api={api}
              dealId={id}
              capabilities={deal.capabilities}
              dealActive={deal.status === 'ACTIVE'}
              myUserId={myUserId}
              acceptedPrice={deal.price}
            />
          )}
          {tab === 'audit' && <Audit api={api} dealId={id} />}

          {tab === 'members' && (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Side</th>
                      <th></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.userId}>
                        <td>{roleLabel(m.role)}</td>
                        <td className="muted">
                          {m.side === 'buy' ? 'Buy-side' : m.side === 'sell' ? 'Sell-side' : 'Neutral'}
                        </td>
                        <td>
                          {m.userId === deal.createdBy && (
                            <span className="pill pill--accent">Creator</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {deal.capabilities.manageRoster &&
                          m.userId !== deal.createdBy &&
                          m.userId !== myUserId ? (
                            <button
                              className="btn btn--danger btn--sm"
                              onClick={() => {
                                void api
                                  .removeMember(id, m.userId)
                                  .then(load)
                                  .catch((e: unknown) => setError(humanizeError(String(e))));
                              }}
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {canInvite && (
                <>
                  <h4>Invite a member</h4>
                  {lastAcceptUrl && (
                    <>
                      <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                        Invitation link — the invitee opens it (or sees the deal under “Pending
                        invitations” on their My deals) and clicks Accept:
                      </p>
                      <div
                        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                      >
                        <code className="share-link" style={{ flex: 1, minWidth: 240 }}>
                          {lastAcceptUrl}
                        </code>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => {
                            void navigator.clipboard?.writeText(lastAcceptUrl).then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            });
                          }}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </>
                  )}
                  <form
                    className="form-inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const d = new FormData(e.currentTarget);
                      const role = String(d.get('role') ?? '');
                      const body: Record<string, unknown> = {
                        email: String(d.get('email') ?? ''),
                        role,
                      };
                      if (role === 'OTHER') body.side = String(d.get('side') ?? 'buy');
                      api
                        .invite(id, body)
                        .then((r) => {
                          setLastAcceptUrl(r.acceptUrl);
                          load();
                        })
                        .catch((err: unknown) => setError(humanizeError(String(err))));
                    }}
                  >
                    <label className="field">
                      <span>Email</span>
                      <input className="input" name="email" type="email" required />
                    </label>
                    <label className="field">
                      <span>Role</span>
                      <select
                        className="select"
                        name="role"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {inviteRole === 'OTHER' && (
                      <label className="field">
                        <span>Side</span>
                        <select className="select" name="side">
                          <option value="buy">Buy-side</option>
                          <option value="sell">Sell-side</option>
                        </select>
                      </label>
                    )}
                    <button className="btn btn--primary" type="submit">
                      Send invite
                    </button>
                  </form>

                  {invites.length > 0 && (
                    <>
                      <h4>Pending invitations</h4>
                      <ul className="section-list">
                        {invites.map((iv) => (
                          <li key={iv.token}>
                            <span>{iv.email}</span>
                            <span className="tag tag--role">{roleLabel(iv.role)}</span>
                            <button
                              className="btn btn--danger btn--sm"
                              style={{ marginLeft: 'auto' }}
                              onClick={() => {
                                void api
                                  .revokeInvite(id, iv.token)
                                  .then(load)
                                  .catch((e: unknown) => setError(humanizeError(String(e))));
                              }}
                            >
                              Revoke
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
