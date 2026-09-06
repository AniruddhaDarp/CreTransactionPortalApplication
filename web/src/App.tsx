import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { hostedLogoutUrl, isConfigured, type AppConfig } from './config.js';
import { Home } from './routes/Home.js';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto' }}>
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

  return (
    <Shell>
      <Home config={config} token={auth.user?.id_token ?? ''} />
      <p style={{ marginTop: '2rem' }}>
        <button
          onClick={() => {
            void auth.removeUser();
            window.location.href = hostedLogoutUrl(config);
          }}
        >
          Sign out
        </button>
      </p>
    </Shell>
  );
}
