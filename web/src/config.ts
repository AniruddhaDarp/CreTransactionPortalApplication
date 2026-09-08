export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  /** e.g. `cre-portal-123.auth.us-east-2.amazoncognito.com` */
  hostedUiDomain: string;
  /** e.g. `https://abc.execute-api.us-east-2.amazonaws.com` */
  apiBaseUrl: string;
}

let cache: Promise<AppConfig> | undefined;

/** Fetch `/config.json` once; the deploy step writes it from stack outputs. */
export function loadConfig(): Promise<AppConfig> {
  if (!cache) {
    cache = fetch('/config.json', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`config.json returned ${r.status}`);
      return r.json() as Promise<AppConfig>;
    });
  }
  return cache;
}

export function isConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.userPoolId && cfg.userPoolClientId && cfg.apiBaseUrl);
}

/**
 * The path the user was on before sign-in (an invite link, a deep-linked deal).
 * `redirect_uri` must be `/` (the only registered Cognito callback), so we carry
 * the real destination through the OIDC `state` and restore it after the code
 * exchange. `signinRedirect` is always called with this as `state`.
 */
export const preLoginPath = (): string => {
  const p = window.location.pathname + window.location.search;
  return p.startsWith('/') && !p.startsWith('/?code=') ? p : '/';
};

/** Settings object for react-oidc-context (auth-code + PKCE). */
export function oidcSettings(cfg: AppConfig) {
  return {
    authority: `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`,
    client_id: cfg.userPoolClientId,
    redirect_uri: `${window.location.origin}/`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: 'openid email profile',
    onSigninCallback: (user?: unknown) => {
      const st = (user as { state?: unknown } | undefined)?.state;
      let target = '/';
      if (st && typeof st === 'object' && 'returnTo' in st) {
        const rt = String((st as { returnTo?: unknown }).returnTo ?? '/');
        if (rt.startsWith('/') && !rt.startsWith('/?code=')) target = rt;
      }
      if (target === '/') {
        window.history.replaceState({}, '', '/');
      } else {
        // full reload so BrowserRouter mounts on the restored path (e.g. /accept/…)
        window.location.replace(target);
      }
    },
  };
}

/** Cognito has no OIDC end-session endpoint in discovery; build its /logout URL. */
export function hostedLogoutUrl(cfg: AppConfig): string {
  const u = new URL(`https://${cfg.hostedUiDomain}/logout`);
  u.searchParams.set('client_id', cfg.userPoolClientId);
  u.searchParams.set('logout_uri', `${window.location.origin}/`);
  return u.toString();
}
