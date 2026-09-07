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

let _accountsTable;
async function accountsTable() {
  if (!_accountsTable) {
    const res = await aws([
      'cloudformation',
      'describe-stack-resources',
      '--stack-name',
      'CrePortalAccounts',
      '--query',
      "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId",
    ]);
    _accountsTable = (res ?? [])[0];
    if (!_accountsTable) throw new Error('could not resolve the CrePortalAccounts table');
  }
  return _accountsTable;
}

/**
 * Write an `accounts` profile row directly — the equivalent of what the
 * PostConfirmation trigger would do. `admin-create-user` (used by `makeUser`)
 * does NOT fire that trigger, so without this a scripted login gets a 404 on
 * the Profile page. Idempotent: a row that already exists is left alone.
 */
export async function provisionProfile({ sub, email, name }) {
  const now = new Date().toISOString();
  const item = {
    PK: { S: `USER#${sub}` },
    SK: { S: 'PROFILE' },
    GSI1PK: { S: `EMAIL#${String(email).toLowerCase()}` },
    userId: { S: sub },
    email: { S: email },
    name: { S: name || email },
    createdAt: { S: now },
    updatedAt: { S: now },
  };
  try {
    await execFileP(
      'aws',
      [
        'dynamodb',
        'put-item',
        '--region',
        REGION,
        '--table-name',
        await accountsTable(),
        '--item',
        JSON.stringify(item),
        '--condition-expression',
        'attribute_not_exists(PK)',
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    if (!String(e.stderr || e).includes('ConditionalCheckFailed')) throw e;
  }
}

/**
 * Create a confirmed Cognito user with a permanent password, provision its
 * `accounts` profile row, and return an authenticated client.
 *
 * Uses `admin-create-user` with `SUPPRESS` (no verification email) rather than
 * `sign-up` — the Cognito-default email sender has a low daily cap that a
 * scripted cohort blows through. `admin-create-user` does **not** fire the
 * `PostConfirmation` trigger, so `makeUser` writes the profile row itself
 * (`provisionProfile`) to keep the Profile page working for scripted logins.
 * (No `account.created` event is emitted — only the Audit trail and the
 * Notifications `PROFILE#` projection consume that, neither of which the
 * seed/verify flows exercise.)
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
  const client = await authClient(cfg, { email, name, password });
  await provisionProfile({ sub: client.sub, email, name });
  return client;
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

/**
 * Block until a just-added member's membership has propagated to every scoped
 * service (chat / documents / audit). Each runs its own EventBridge → SQS
 * consumer, so a fresh member can 403 ("membership may not be synced yet") on
 * any of them for a while — and under sustained membership churn (many
 * `member.*` events in a short window) that window stretches from a few seconds
 * into tens of seconds. Any code that acts as a member right after
 * `inviteAndAccept` relies on this.
 */
export async function waitMemberSync(client, dealId, { tries = 60, gapMs = 2000 } = {}) {
  const paths = [
    `/v1/deals/${dealId}/threads`,
    `/v1/deals/${dealId}/documents`,
    `/v1/deals/${dealId}/audit`,
  ];
  await waitFor(
    async () => {
      const codes = await Promise.all(paths.map((p) => client.call('GET', p).then((r) => r.status)));
      return codes.every((c) => c === 200);
    },
    `projection sync for ${client.email} on ${dealId}`,
    { tries, gapMs },
  );
}

/** Invite `invitee` to a deal as `role`, have them accept (email must match),
 *  and wait until they can actually act in every scoped service. */
export async function inviteAndAccept(inviter, invitee, dealId, role) {
  const inv = await inviter.must('POST', `/v1/deals/${dealId}/invites`, { email: invitee.email, role });
  await invitee.must('POST', `/v1/deals/${dealId}/invites/${inv.token}/accept`, undefined, [200, 201]);
  await waitMemberSync(invitee, dealId);
  return inv.token;
}
