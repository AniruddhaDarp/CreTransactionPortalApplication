#!/usr/bin/env node
// Populate web/public/config.json from CDK stack outputs (infra/cdk-outputs.json,
// produced by `cdk deploy --outputs-file`). These IDs are not secret — they ship
// in the SPA bundle regardless — so the file is safe to commit.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputsPath = join(ROOT, 'infra', 'cdk-outputs.json');
const configPath = join(ROOT, 'web', 'public', 'config.json');
const REGION = 'us-east-2';

const outputs = JSON.parse(await readFile(outputsPath, 'utf8'));
const shared = outputs.CrePortalShared ?? {};
const accounts = outputs.CrePortalAccounts ?? {};

const config = {
  region: REGION,
  userPoolId: accounts.UserPoolId ?? '',
  userPoolClientId: accounts.UserPoolClientId ?? '',
  hostedUiDomain: String(accounts.HostedUiUrl ?? '').replace(/^https?:\/\//, ''),
  apiBaseUrl: shared.HttpApiEndpoint ?? '',
};

for (const [k, v] of Object.entries(config)) {
  if (!v) console.warn(`sync-config: warning — "${k}" resolved empty`);
}

await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
console.log(`sync-config: wrote ${configPath}`);
console.log(config);
