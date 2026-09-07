import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Capabilities, Deal, DealsApi, Invite, Member } from '../deals-api.js';
import { statusPill } from '../theme.js';
import { Audit } from './Audit.js';
import { Chat } from './Chat.js';
import { Documents } from './Documents.js';
import { Milestones } from './Milestones.js';
import { Payments } from './Payments.js';

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

function StageBar({ current, total = 6 }: { current: number; total?: number }) {
  return (
    <div style={{ display: 'flex', gap: 3 }} aria-label={`Stage ${current} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 26,
            height: 5,
            borderRadius: 3,
            background: i < current ? 'var(--accent)' : 'var(--line-2)',
          }}
        />
      ))}
    </div>
  );
}

export function DealDetail({ api, myUserId }: { api: DealsApi; myUserId: string }) {
  const { id = '' } = useParams();
  const [deal, setDeal] = useState<(Deal & { capabilities: Capabilities }) | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);

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
      .catch((e: unknown) => setError(String(e)));
  }, [api, id]);

  useEffect(load, [load]);

  if (error) return <p className="error">Could not load deal: {error}</p>;
  if (!deal) return <p className="muted">Loading deal…</p>;

  const canInvite = deal.capabilities.inviteBuySide || deal.capabilities.inviteSellSide;

  return (
    <section>
      <div className="deal-header">
        <div className="deal-header__top">
          <div>
            <h2>{deal.label ?? deal.address}</h2>
            <div className="deal-header__sub">{deal.address}</div>
          </div>
          <span className={statusPill(deal.status)} style={{ marginLeft: 'auto' }}>
            {deal.status}
          </span>
        </div>
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
              <StageBar current={deal.currentStage} />
              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                {deal.currentStage} / 6{deal.firm ? '' : ''}
              </span>
              {deal.firm && <span className="pill pill--accent">Firm</span>}
            </dd>
          </div>
        </dl>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Milestones</h3>
        </div>
        <div className="panel__body">
          <Milestones
            api={api}
            dealId={id}
            capabilities={deal.capabilities}
            dealActive={deal.status === 'ACTIVE'}
          />
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Communication</h3>
        </div>
        <div className="panel__body">
          <Chat api={api} dealId={id} myUserId={myUserId} />
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Document room</h3>
        </div>
        <div className="panel__body">
          <Documents api={api} dealId={id} capabilities={deal.capabilities} />
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Payments</h3>
        </div>
        <div className="panel__body">
          <Payments
            api={api}
            dealId={id}
            capabilities={deal.capabilities}
            dealActive={deal.status === 'ACTIVE'}
          />
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Audit trail</h3>
        </div>
        <div className="panel__body">
          <Audit api={api} dealId={id} />
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <h3>Members</h3>
          <span className="meta">{members.length} parties</span>
        </div>
        <div className="panel__body">
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
                    <td>{m.role}</td>
                    <td className="muted">{m.side}</td>
                    <td>
                      {m.userId === deal.createdBy && <span className="pill pill--accent">Admin</span>}
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
                              .catch((e: unknown) => setError(String(e)));
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
                    Invitation link — share with the invitee:
                  </p>
                  <code className="share-link">{lastAcceptUrl}</code>
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
                    .catch((err: unknown) => setError(String(err)));
                }}
              >
                <label className="field">
                  <span>Email</span>
                  <input className="input" name="email" type="email" required />
                </label>
                <label className="field">
                  <span>Role</span>
                  <select className="select" name="role">
                    {ROLES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Side (for OTHER)</span>
                  <select className="select" name="side">
                    <option value="buy">buy</option>
                    <option value="sell">sell</option>
                  </select>
                </label>
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
                        <span className="tag tag--role">{iv.role}</span>
                        <button
                          className="btn btn--danger btn--sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => {
                            void api
                              .revokeInvite(id, iv.token)
                              .then(load)
                              .catch((e: unknown) => setError(String(e)));
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
        </div>
      </div>
    </section>
  );
}
