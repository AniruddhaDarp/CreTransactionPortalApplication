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

/** Settings object for react-oidc-context (auth-code + PKCE). */
export function oidcSettings(cfg: AppConfig) {
  return {
    authority: `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`,
    client_id: cfg.userPoolClientId,
    redirect_uri: `${window.location.origin}/`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: 'openid email profile',
    onSigninCallback: () => window.history.replaceState({}, '', '/'),
  };
}

/** Cognito has no OIDC end-session endpoint in discovery; build its /logout URL. */
export function hostedLogoutUrl(cfg: AppConfig): string {
  const u = new URL(`https://${cfg.hostedUiDomain}/logout`);
  u.searchParams.set('client_id', cfg.userPoolClientId);
  u.searchParams.set('logout_uri', `${window.location.origin}/`);
  return u.toString();
}
