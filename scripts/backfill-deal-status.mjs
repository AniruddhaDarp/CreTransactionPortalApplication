#!/usr/bin/env node
// One-off backfill: the Chat and Documents services learned to freeze a deal's
// workspace on `deal.status_changed`, but deals closed/cancelled *before* that
// change never got the projection row. This scans the Deals table for
// non-ACTIVE deals and writes the `DEALMETA` row into each service table so the
// read-only guard applies retroactively. Safe to re-run. Uses the AWS CLI.
import { execFileSync } from 'node:child_process';

const REGION = 'us-east-2';
const aws = (args) => execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8' });

const tables = JSON.parse(aws(['dynamodb', 'list-tables', '--query', 'TableNames', '--output', 'json']));
const find = (needle) => {
  const t = tables.find((x) => x.startsWith(needle));
  if (!t) throw new Error(`no table starting with ${needle}`);
  return t;
};
const DEALS = find('CrePortalDeals-Table');
const CHAT = find('CrePortalChat-Table');
const DOCS = find('CrePortalDocuments-Table');

const scan = JSON.parse(
  aws([
    'dynamodb',
    'scan',
    '--table-name',
    DEALS,
    '--filter-expression',
    'SK = :meta AND #s <> :active',
    '--expression-attribute-names',
    JSON.stringify({ '#s': 'status' }),
    '--expression-attribute-values',
    JSON.stringify({ ':meta': { S: 'META' }, ':active': { S: 'ACTIVE' } }),
    '--query',
    'Items[].{dealId:dealId.S,status:status.S}',
    '--output',
    'json',
  ]),
);

console.log(`backfill: ${scan.length} non-ACTIVE deal(s)`);
for (const { dealId, status } of scan) {
  const item = JSON.stringify({
    PK: { S: `DEAL#${dealId}` },
    SK: { S: 'DEALMETA' },
    dealId: { S: dealId },
    status: { S: status },
  });
  for (const table of [CHAT, DOCS]) {
    aws(['dynamodb', 'put-item', '--table-name', table, '--item', item]);
  }
  console.log(`  ${dealId} -> ${status}`);
}
console.log('backfill: done');
