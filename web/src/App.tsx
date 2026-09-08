import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { hostedLogoutUrl, isConfigured, preLoginPath, type AppConfig } from './config.js';
import { dealsApi, type DealsApi } from './deals-api.js';
import { roleLabel } from './roles.js';
import { DialogProvider } from './routes/dialog.js';
import { usePoll } from './routes/usePoll.js';
import { useVersionCheck } from './routes/useVersionCheck.js';
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
  const load = useCallback(() => {
    api
      .myApprovals()
      .then((r) => setCount(r.handshakes.length))
      .catch(() => {});
  }, [api]);
  usePoll(load, 10_000, [load]);
  if (count === 0) return null;
  return (
    <span className="pill pill--warn" title="Requests awaiting your approval — see the Actions tab on the deal">
      {count} approval{count > 1 ? 's' : ''}
    </span>
  );
}

/** Which deal-detail tab a notification's action / info lives on. */
function tabForNotification(n: { type: string; targetType?: string; title?: string }): string | null {
  // payment handshakes ride the generic handshake plumbing — route them by title
  if (/(confirm|void)_payment/.test(n.title ?? '')) return 'payments';
  switch (n.targetType) {
    case 'handshake':
    case 'stage':
      return 'milestones';
    case 'thread':
      return 'chat';
    case 'payment':
      return 'payments';
    case 'document':
    case 'doc-request':
      return 'documents';
  }
  if (n.type.startsWith('payment')) return 'payments';
  if (n.type.startsWith('signature') || n.type.startsWith('docrequest')) return 'documents';
  if (n.type === 'mention' || n.type === 'thread_converted') return 'chat';
  if (n.type.startsWith('handshake') || n.type === 'stage_advanced') return 'milestones';
  if (n.type === 'deal_closed' || n.type === 'deal_cancelled') return 'milestones';
  return null;
}

/** Display name for a deal-detail tab key. */
const SECTION_LABEL: Record<string, string> = {
  milestones: 'Milestones',
  actions: 'Actions',
  chat: 'Communication',
  documents: 'Documents',
  payments: 'Payments',
  audit: 'Audit',
  members: 'Members',
};

function NotificationsBell({ api }: { api: DealsApi }) {
  const [items, setItems] = useState<Awaited<ReturnType<DealsApi['notifications']>>['notifications']>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [dealName, setDealName] = useState<Record<string, string>>({});
  const wrapRef = useRef<HTMLSpanElement>(null);
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

  usePoll(load, 10_000, [load]);

  // resolve dealId -> a readable name for the "which deal" line (deals change rarely)
  useEffect(() => {
    if (!open) return;
    api
      .list()
      .then((r) => {
        const m: Record<string, string> = {};
        for (const d of r.deals) m[d.dealId] = d.label ?? d.address;
        setDealName(m);
      })
      .catch(() => {});
  }, [api, open]);

  // close on a click outside the bell, or on Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n: {
    id: string;
    dealId?: string;
    type: string;
    targetType?: string;
    title?: string;
  }) => {
    void api.markNotificationRead(n.id).then(load).catch(() => {});
    setOpen(false);
    if (!n.dealId) return;
    const t = tabForNotification(n);
    navigate(`/deals/${n.dealId}${t ? `?tab=${t}` : ''}`);
  };

  return (
    <span className="notif-wrap" ref={wrapRef}>
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
            {items.map((n) => {
              const section = SECTION_LABEL[tabForNotification(n) ?? ''];
              return (
                <li
                  key={n.id}
                  role="menuitem"
                  tabIndex={0}
                  className={`notif${n.readAt ? '' : ' notif--unread'}`}
                  onClick={() => openItem(n)}
                  onKeyDown={(e) => e.key === 'Enter' && openItem(n)}
                >
                  {n.title}
                  {n.dealId && (
                    <span className="notif__where">
                      <b>{dealName[n.dealId] ?? 'Deal'}</b>
                      {section ? ` · ${section}` : ''}
                    </span>
                  )}
                  <time>{n.occurredAt.slice(0, 16).replace('T', ' ')}</time>
                </li>
              );
            })}
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

function UserChip({ api, myUserId }: { api: DealsApi; myUserId: string }) {
  const { pathname } = useLocation();
  const [name, setName] = useState<string | null>(null);
  const [profileRole, setProfileRole] = useState<string | undefined>(undefined);
  const [dealRole, setDealRole] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setName(m.name);
        setProfileRole(m.industryRole);
      })
      .catch(() => {});
  }, [api]);

  // On a deal page, show this user's role *on that deal* (it can differ per
  // deal); elsewhere fall back to their account profile role.
  const dealId = /^\/deals\/([^/]+)/.exec(pathname)?.[1];
  useEffect(() => {
    if (!dealId || dealId === 'new') {
      setDealRole(null);
      return;
    }
    let live = true;
    api
      .members(dealId)
      .then((r) => {
        if (live) setDealRole(r.members.find((m) => m.userId === myUserId)?.role ?? null);
      })
      .catch(() => {
        if (live) setDealRole(null);
      });
    return () => {
      live = false;
    };
  }, [api, dealId, myUserId]);

  if (!name) return null;
  const role = dealRole ? roleLabel(dealRole) : profileRole;
  return (
    <NavLink
      to="/profile"
      className={({ isActive }) => `user-chip${isActive ? ' is-active' : ''}`}
      title={role ? `${name} — ${role} · View profile` : `${name} · View profile`}
    >
      <span className="user-chip__name">{name}</span>
      {role && <span className="user-chip__role">{role}</span>}
    </NavLink>
  );
}

function UpdateBanner() {
  const stale = useVersionCheck();
  if (!stale) return null;
  return (
    <div className="update-banner" role="status">
      <span>A newer version of the portal has been deployed.</span>
      <button className="btn btn--primary btn--sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
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
        <button
          className="btn btn--primary"
          onClick={() => void auth.signinRedirect({ state: { returnTo: preLoginPath() } })}
        >
          Try again
        </button>
      </Gate>
    );
  }
  if (!auth.isAuthenticated) {
    return (
      <Gate>
        <p className="muted">Sign in to access your deals.</p>
        <button
          className="btn btn--primary"
          onClick={() => void auth.signinRedirect({ state: { returnTo: preLoginPath() } })}
        >
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
    <DialogProvider>
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
            <ApprovalsBadge api={api} />
            <NotificationsBell api={api} />
            <ThemeToggle />
            <UserChip api={api} myUserId={myUserId} />
            <button className="btn btn--ghost btn--sm" onClick={signOut}>
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <div className="container">
        <UpdateBanner />
        <Routes>
          <Route path="/" element={<DealsList api={api} />} />
          <Route path="/deals/new" element={<NewDeal api={api} />} />
          <Route path="/deals/:id" element={<DealDetail api={api} myUserId={myUserId} />} />
          <Route path="/accept/:dealId/:token" element={<AcceptInvite api={api} />} />
          <Route path="/profile" element={<Home config={config} token={token} />} />
        </Routes>
      </div>
    </BrowserRouter>
    </DialogProvider>
  );
}
