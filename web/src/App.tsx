import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Link, Route, Routes, useNavigate } from 'react-router-dom';
import { hostedLogoutUrl, isConfigured, type AppConfig } from './config.js';
import { dealsApi, type DealsApi } from './deals-api.js';
import { AcceptInvite } from './routes/AcceptInvite.js';
import { DealDetail } from './routes/DealDetail.js';
import { DealsList } from './routes/DealsList.js';
import { Home } from './routes/Home.js';
import { NewDeal } from './routes/NewDeal.js';

function ApprovalsBadge({ api }: { api: DealsApi }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .myApprovals()
      .then((r) => live && setCount(r.handshakes.length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  return count > 0 ? <strong> · {count} approval{count > 1 ? 's' : ''} waiting</strong> : null;
}

function NotificationsBell({ api }: { api: DealsApi }) {
  const [items, setItems] = useState<Awaited<ReturnType<DealsApi['notifications']>>['notifications']>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unreadCount);
      })
      .catch(() => {});
  }, [api]);

  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const openItem = (id: string, dealId?: string) => {
    void api.markNotificationRead(id).then(load).catch(() => {});
    setOpen(false);
    if (dealId) navigate(`/deals/${dealId}`);
  };

  return (
    <span style={{ position: 'relative', marginLeft: '1rem' }}>
      <button onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        🔔{unread > 0 ? ` ${unread}` : ''}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '1.8rem',
            width: 320,
            background: '#fff',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: 8,
            zIndex: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <strong>Notifications</strong>
            <button
              onClick={() => {
                void api.markAllNotificationsRead().then(load).catch(() => {});
              }}
            >
              mark all read
            </button>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}>
            {items.map((n) => (
              <li
                key={n.id}
                onClick={() => openItem(n.id, n.dealId)}
                style={{
                  padding: '6px 4px',
                  borderTop: '1px solid #eee',
                  cursor: 'pointer',
                  fontWeight: n.readAt ? 400 : 700,
                }}
              >
                {n.title}
                <br />
                <small style={{ color: '#777', fontWeight: 400 }}>
                  {n.occurredAt.slice(0, 16).replace('T', ' ')}
                </small>
              </li>
            ))}
            {items.length === 0 && <li style={{ padding: 6, color: '#777' }}>Nothing yet.</li>}
          </ul>
        </div>
      )}
    </span>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '3rem auto' }}>
      <h1>CRE Transaction Portal</h1>
      {children}
    </main>
  );
}

export function App({ config }: { config: AppConfig }) {
  const auth = useAuth();

  if (!isConfigured(config)) {
    return (
      <Shell>
        <p>
          Not configured. After deploying, write the stack outputs into{' '}
          <code>web/public/config.json</code>.
        </p>
      </Shell>
    );
  }

  if (auth.isLoading) return <Shell>Loading…</Shell>;
  if (auth.error) {
    return (
      <Shell>
        <p>Sign-in error: {auth.error.message}</p>
        <button onClick={() => void auth.signinRedirect()}>Try again</button>
      </Shell>
    );
  }
  if (!auth.isAuthenticated) {
    return (
      <Shell>
        <p>Sign in to access your deals.</p>
        <button onClick={() => void auth.signinRedirect()}>Sign in</button>
      </Shell>
    );
  }

  const token = auth.user?.id_token ?? '';
  const myUserId = String(auth.user?.profile.sub ?? '');
  const api = dealsApi(config, token);

  const signOut = () => {
    void auth.removeUser();
    window.location.href = hostedLogoutUrl(config);
  };

  return (
    <BrowserRouter>
      <Shell>
        <nav style={{ marginBottom: '1.5rem' }}>
          <Link to="/">My deals</Link> · <Link to="/profile">Profile</Link> ·{' '}
          <button onClick={signOut}>Sign out</button>
          <ApprovalsBadge api={api} />
          <NotificationsBell api={api} />
        </nav>
        <Routes>
          <Route path="/" element={<DealsList api={api} />} />
          <Route path="/deals/new" element={<NewDeal api={api} />} />
          <Route path="/deals/:id" element={<DealDetail api={api} myUserId={myUserId} />} />
          <Route path="/accept/:dealId/:token" element={<AcceptInvite api={api} />} />
          <Route path="/profile" element={<Home config={config} token={token} />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
