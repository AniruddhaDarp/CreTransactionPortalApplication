import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { AppConfig } from './config.js';

const h = vi.hoisted(() => ({ auth: {} as Record<string, unknown> }));
vi.mock('react-oidc-context', () => ({ useAuth: () => h.auth }));

const cfg: AppConfig = {
  region: 'us-east-2',
  userPoolId: 'pool-1',
  userPoolClientId: 'client-1',
  hostedUiDomain: 'x.auth.us-east-2.amazoncognito.com',
  apiBaseUrl: 'https://api.example.com',
};

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('prompts to configure when config.json is blank', () => {
    h.auth = { isLoading: false, isAuthenticated: false };
    render(<App config={{ ...cfg, userPoolId: '' }} />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  it('shows a Sign in button when not authenticated', () => {
    h.auth = { isLoading: false, isAuthenticated: false, signinRedirect: vi.fn() };
    render(<App config={cfg} />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the signed-in view and a Sign out button when authenticated', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})), // never resolves — Home stays on "Loading profile…"
    );
    h.auth = {
      isLoading: false,
      isAuthenticated: true,
      user: { id_token: 'tok' },
      removeUser: vi.fn(),
    };
    render(<App config={cfg} />);
    expect(screen.getByText(/loading profile/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
