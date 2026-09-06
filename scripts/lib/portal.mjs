// Shared helpers for the deploy-target scripts (seed.mjs, verify.mjs).
// Talks to the *deployed* stack: resolves config from SSM, drives Cognito
// (sign-up / confirm / password auth) and the edge HTTP API.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const REGION = process.env.AWS_REGION || 'us-east-2';

const SSM_NAMES = {
  apiBaseUrl: '/cre-portal/shared/http-api-endpoint',
  distributionDomain: '/cre-portal/shared/distribution-domain',
  userPoolId: '/cre-portal/accounts/user-pool-id',
  userPoolClientId: '/cre-portal/accounts/user-pool-client-id',
  hostedUiDomain: '/cre-portal/accounts/hosted-ui-domain',
};

async function aws(args) {
  const { stdout } = await execFileP('aws', [...args, '--region', REGION, '--output', 'json'], {
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout ? JSON.parse(stdout) : null;
}
async function awsQuiet(args) {
  try {
    await aws(args);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the deployed stack's public identifiers from SSM Parameter Store. */
export async function resolveConfig() {
  const res = await aws(['ssm', 'get-parameters', '--names', ...Object.values(SSM_NAMES)]);
  const byName = Object.fromEntries((res.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const cfg = {};
  for (const [k, name] of Object.entries(SSM_NAMES)) {
    cfg[k] = byName[name];
    if (!cfg[k]) throw new Error(`SSM parameter ${name} is missing — is the stack deployed?`);
  }
  cfg.spaUrl = `https://${cfg.distributionDomain}`;
  cfg.hostedUiUrl = `https://${cfg.hostedUiDomain}`;
  return cfg;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the attempts run out. */
export async function waitFor(fn, label, { tries = 40, gapMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(gapMs);
  }
  throw new Error(`timed out waiting for: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

/** Delete a Cognito user if it exists (used by the idempotent seed reset). */
export async function deleteUser(userPoolId, username) {
  return awsQuiet(['cognito-idp', 'admin-delete-user', '--user-pool-id', userPoolId, '--username', username]);
}

/**
 * Create a confirmed Cognito user with a permanent password and return an
 * authenticated client.
 *
 * Uses `admin-create-user` with `SUPPRESS` (no verification email) rather than
 * `sign-up` — the Cognito-default email sender has a low daily cap that a
 * scripted cohort blows through. Trade-off: `admin-create-user` does **not**
 * fire the `PostConfirmation` trigger, so these users get no `accounts` profile
 * row / `account.created` event. That is fine for the seed/verify flows (deals,
 * chat, documents, audit and notifications all key off deal membership + JWT
 * claims, not the profile); only `GET /v1/me` would 404 for a scripted login.
 */
export async function makeUser(cfg, { email, name, password }) {
  await aws([
    'cognito-idp',
    'admin-create-user',
    '--user-pool-id',
    cfg.userPoolId,
    '--username',
    email,
    '--message-action',
    'SUPPRESS',
    '--user-attributes',
    `Name=email,Value=${email}`,
    `Name=email_verified,Value=true`,
    `Name=name,Value=${name}`,
  ]);
  await aws([
    'cognito-idp',
    'admin-set-user-password',
    '--user-pool-id',
    cfg.userPoolId,
    '--username',
    email,
    '--password',
    password,
    '--permanent',
  ]);
  return authClient(cfg, { email, name, password });
}

/** Authenticate an existing user and return an API client bound to their token. */
export async function authClient(cfg, { email, name, password }) {
  const res = await aws([
    'cognito-idp',
    'initiate-auth',
    '--client-id',
    cfg.userPoolClientId,
    '--auth-flow',
    'USER_PASSWORD_AUTH',
    '--auth-parameters',
    `USERNAME=${email},PASSWORD=${password}`,
  ]);
  const idToken = res.AuthenticationResult.IdToken;
  const sub = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()).sub;

  const call = async (method, path, body) => {
    const r = await fetch(cfg.apiBaseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${idToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-correlation-id': `script-${Math.random().toString(36).slice(2)}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, ok: r.ok, body: json, text, headers: r.headers };
  };

  const must = async (method, path, body, okStatuses = [200, 201, 202]) => {
    const res2 = await call(method, path, body);
    if (!okStatuses.includes(res2.status)) {
      throw new Error(`${method} ${path} → ${res2.status}: ${JSON.stringify(res2.body)}`);
    }
    return res2.body;
  };

  return { email, name, sub, idToken, call, must };
}

/** Upload bytes to a presigned S3 PUT URL (Content-Type must match what was signed). */
export async function putToS3(url, bytes, contentType) {
  const r = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
  if (!r.ok) throw new Error(`S3 PUT failed (${r.status})`);
}

/** Invite `invitee` to a deal as `role` and have them accept (email must match). */
export async function inviteAndAccept(inviter, invitee, dealId, role) {
  const inv = await inviter.must('POST', `/v1/deals/${dealId}/invites`, { email: invitee.email, role });
  await invitee.must('POST', `/v1/deals/${dealId}/invites/${inv.token}/accept`, undefined, [200, 201]);
  return inv.token;
}
