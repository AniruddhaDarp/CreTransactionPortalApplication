import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Capabilities, Deal, DealsApi, Invite, Member } from '../deals-api.js';

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

  if (error) return <p>Could not load deal: {error}</p>;
  if (!deal) return <p>Loading deal…</p>;

  const canInvite = deal.capabilities.inviteBuySide || deal.capabilities.inviteSellSide;

  return (
    <section>
      <h2>{deal.label ?? deal.address}</h2>
      <dl>
        <dt>Address</dt>
        <dd>{deal.address}</dd>
        <dt>Type</dt>
        <dd>{deal.propertyType}</dd>
        <dt>Price</dt>
        <dd>${deal.price.toLocaleString()}</dd>
        <dt>Status</dt>
        <dd>{deal.status}</dd>
        <dt>Stage</dt>
        <dd>
          {deal.currentStage} / 6{deal.firm ? ' · firm' : ''}
        </dd>
      </dl>

      <h3>Members</h3>
      <table>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.role}</td>
              <td>{m.side}</td>
              <td>{m.userId === deal.createdBy ? 'admin' : ''}</td>
              <td>
                {deal.capabilities.manageRoster &&
                m.userId !== deal.createdBy &&
                m.userId !== myUserId ? (
                  <button
                    onClick={() => {
                      void api.removeMember(id, m.userId).then(load).catch((e: unknown) => setError(String(e)));
                    }}
                  >
                    remove
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canInvite && (
        <>
          <h3>Invite a member</h3>
          {lastAcceptUrl && (
            <p>
              Invitation link (share with the invitee): <code>{lastAcceptUrl}</code>
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = new FormData(e.currentTarget);
              const role = String(d.get('role') ?? '');
              const body: Record<string, unknown> = { email: String(d.get('email') ?? ''), role };
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
            <input name="email" type="email" placeholder="email" required />{' '}
            <select name="role">
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>{' '}
            <select name="side">
              <option value="buy">buy (for OTHER)</option>
              <option value="sell">sell (for OTHER)</option>
            </select>{' '}
            <button type="submit">Invite</button>
          </form>

          {invites.length > 0 && (
            <>
              <h4>Pending invitations</h4>
              <ul>
                {invites.map((iv) => (
                  <li key={iv.token}>
                    {iv.email} — {iv.role}{' '}
                    <button
                      onClick={() => {
                        void api.revokeInvite(id, iv.token).then(load).catch((e: unknown) => setError(String(e)));
                      }}
                    >
                      revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
