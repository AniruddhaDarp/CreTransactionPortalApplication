#!/usr/bin/env node
// Build + deploy the SPA to S3 + CloudFront.
//
// Cache strategy:
//   - /assets/*  (Vite-hashed JS/CSS) -> immutable, cache 1 year. The filename
//     changes every build, so it is always safe to cache hard.
//   - index.html / config.json        -> no-cache (revalidate every load), so a
//     plain browser reload picks up a new deploy with no hard-refresh.
//
// Bucket + distribution come from the SSM params the SharedStack publishes.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'web', 'dist');
const REGION = 'us-east-2';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const ssm = (name) =>
  capture('aws', [
    'ssm', 'get-parameter',
    '--name', name,
    '--region', REGION,
    '--query', 'Parameter.Value',
    '--output', 'text',
  ]);

const bucket = ssm('/cre-portal/shared/web-bucket-name');
const distId = ssm('/cre-portal/shared/distribution-id');
console.log(`deploy-web: bucket=${bucket} distribution=${distId}`);

// 1. build the SPA
run('pnpm', ['--filter', 'web', 'build'], { cwd: ROOT });

// 2. hashed assets first (never referenced before index.html points at them)
run('aws', [
  's3', 'sync', DIST, `s3://${bucket}`,
  '--region', REGION,
  '--delete',
  '--exclude', 'index.html',
  '--exclude', 'config.json',
  '--cache-control', 'public,max-age=31536000,immutable',
]);

// 3. entry point + runtime config — must always revalidate
run('aws', [
  's3', 'sync', DIST, `s3://${bucket}`,
  '--region', REGION,
  '--exclude', '*',
  '--include', 'index.html',
  '--include', 'config.json',
  '--cache-control', 'no-cache',
]);

// 4. invalidate only the mutable paths at the edge
const invId = capture('aws', [
  'cloudfront', 'create-invalidation',
  '--distribution-id', distId,
  '--paths', '/index.html', '/config.json',
  '--query', 'Invalidation.Id',
  '--output', 'text',
]);
console.log(`deploy-web: invalidation ${invId} created (paths: /index.html /config.json)`);
console.log('deploy-web: done');
