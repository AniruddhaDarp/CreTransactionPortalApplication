import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { hostedLogoutUrl, isConfigured, type AppConfig } from './config.js';
import { dealsApi } from './deals-api.js';
import { AcceptInvite } from './routes/AcceptInvite.js';
import { DealDetail } from './routes/DealDetail.js';
import { DealsList } from './routes/DealsList.js';
import { Home } from './routes/Home.js';
import { NewDeal } from './routes/NewDeal.js';

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
