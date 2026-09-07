import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { hostedLogoutUrl, isConfigured, type AppConfig } from './config.js';
import { dealsApi, type DealsApi } from './deals-api.js';
import { AcceptInvite } from './routes/AcceptInvite.js';
import { DealDetail } from './routes/DealDetail.js';
import { DealsList } from './routes/DealsList.js';
import { Home } from './routes/Home.js';
import { NewDeal } from './routes/NewDeal.js';
import { toggleTheme } from './theme.js';

function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark__mark" aria-hidden="true" />
      CRE Transaction Portal
    </span>
  );
}

function ApprovalsBadge({ api }: { api: DealsApi }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .myApprovals()
        .then((r) => live && setCount(r.handshakes.length))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api]);
  if (count === 0) return null;
  return (
    <span className="pill pill--warn" title="Handshakes awaiting your approval">
      {count} approval{count > 1 ? 's' : ''}
    </span>
  );
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
    <span className="notif-wrap">
      <button
        className="btn btn--icon"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="count-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown" role="menu">
          <div className="dropdown__head">
            <strong>Notifications</strong>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => void api.markAllNotificationsRead().then(load).catch(() => {})}
            >
              Mark all read
            </button>
          </div>
          <ul className="notif-list">
            {items.map((n) => (
              <li
                key={n.id}
                role="menuitem"
                tabIndex={0}
                className={`notif${n.readAt ? '' : ' notif--unread'}`}
                onClick={() => openItem(n.id, n.dealId)}
                onKeyDown={(e) => e.key === 'Enter' && openItem(n.id, n.dealId)}
              >
                {n.title}
                <time>{n.occurredAt.slice(0, 16).replace('T', ' ')}</time>
              </li>
            ))}
            {items.length === 0 && (
              <li className="notif">
                <span className="empty">Nothing yet.</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () =>
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  return (
    <button
      className="btn btn--icon"
      aria-label="Toggle light or dark theme"
      onClick={() => setDark(toggleTheme() === 'dark')}
    >
      <span aria-hidden="true">{dark ? '☾' : '☀'}</span>
    </button>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return (
    <main className="gate">
      <Wordmark />
      {children}
    </main>
  );
}

export function App({ config }: { config: AppConfig }) {
  const auth = useAuth();

  if (!isConfigured(config)) {
    return (
      <Gate>
        <p className="muted">
          Not configured. After deploying, write the stack outputs into{' '}
          <code>web/public/config.json</code>.
        </p>
      </Gate>
    );
  }

  if (auth.isLoading) return <Gate><p className="muted">Loading…</p></Gate>;
  if (auth.error) {
    return (
      <Gate>
        <p className="error">Sign-in error: {auth.error.message}</p>
        <button className="btn btn--primary" onClick={() => void auth.signinRedirect()}>
          Try again
        </button>
      </Gate>
    );
  }
  if (!auth.isAuthenticated) {
    return (
      <Gate>
        <p className="muted">Sign in to access your deals.</p>
        <button className="btn btn--primary" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </Gate>
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
      <header className="app-bar">
        <div className="app-bar__inner">
          <NavLink to="/" className="wordmark">
            <span className="wordmark__mark" aria-hidden="true" />
            CRE Transaction Portal
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'is-active' : '')}>
              My deals
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => (isActive ? 'is-active' : '')}>
              Profile
            </NavLink>
            <ApprovalsBadge api={api} />
            <NotificationsBell api={api} />
            <ThemeToggle />
            <button className="btn btn--ghost btn--sm" onClick={signOut}>
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <div className="container">
        <Routes>
          <Route path="/" element={<DealsList api={api} />} />
          <Route path="/deals/new" element={<NewDeal api={api} />} />
          <Route path="/deals/:id" element={<DealDetail api={api} myUserId={myUserId} />} />
          <Route path="/accept/:dealId/:token" element={<AcceptInvite api={api} />} />
          <Route path="/profile" element={<Home config={config} token={token} />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
