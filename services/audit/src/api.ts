import { HttpError, router, type RawResponse, type RequestContext } from '@cre/platform';
import type { AuditRow } from './repo.js';
import * as repo from './repo.js';
import { requireViewer, viewerScopes, type Viewer } from './scope.js';

const EXPORT_CAP = 10_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const param = (ctx: RequestContext, name: string): string => {
  const v = ctx.pathParams[name];
  if (!v) throw new HttpError(400, `missing path parameter: ${name}`);
  return v;
};

interface Filters {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

function readFilters(ctx: RequestContext): Filters {
  const q = ctx.query;
  return {
    actor: q.actor || undefined,
    action: q.action || undefined,
    targetType: q.targetType || undefined,
    targetId: q.targetId || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
  };
}

/** Scope is the security boundary (no god view); the rest are convenience filters. */
function keep(row: AuditRow, visible: Set<string>, f: Filters): boolean {
  if (!visible.has(row.scope)) return false;
  if (f.actor && row.actorId !== f.actor) return false;
  if (f.action && row.detailType !== f.action && row.action !== f.action) return false;
  if (f.targetType && row.targetType !== f.targetType) return false;
  if (f.targetId && row.targetId !== f.targetId) return false;
  return true;
}

function scopedRows(rows: AuditRow[], viewer: Viewer, f: Filters): AuditRow[] {
  const visible = new Set(viewerScopes(viewer));
  return rows.filter((r) => keep(r, visible, f));
}

const csvCell = (v: unknown): string => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_COLUMNS: Array<keyof AuditRow> = [
  'occurredAt',
  'actorId',
  'detailType',
  'action',
  'targetType',
  'targetId',
  'scope',
  'summary',
  'correlationId',
];

function toCsv(rows: AuditRow[]): string {
  const head = CSV_COLUMNS.join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

export const handler = router({
  'GET /v1/deals/{dealId}/audit': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    const filters = readFilters(ctx);

    const limit = Math.min(Math.max(Number(ctx.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    // Over-fetch a little so scope/attribute filtering doesn't routinely yield a
    // short page; the cursor is DynamoDB's, so pagination stays correct even
    // when a page filters down to nothing.
    const page = await repo.queryDeal(dealId, {
      from: filters.from,
      to: filters.to,
      cursor: ctx.query.cursor,
      limit: Math.min(limit + 50, MAX_LIMIT),
    });
    const visible = scopedRows(page.rows, viewer, filters);
    return {
      body: {
        events: visible.slice(0, limit),
        nextCursor: visible.length > limit ? undefined : page.nextCursor,
        scopes: [...viewerScopes(viewer)],
      },
    };
  },

  'GET /v1/deals/{dealId}/audit/export': async (ctx): Promise<{ raw: RawResponse }> => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    const filters = readFilters(ctx);
    const format = (ctx.query.format ?? 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      throw new HttpError(400, "format must be 'csv' or 'json'");
    }

    const all = await repo.scanDeal(dealId, EXPORT_CAP);
    const rows = scopedRows(all, viewer, filters);
    const day = new Date().toISOString().slice(0, 10);
    const filename = `audit-${dealId}-${day}.${format}`;
    const disposition = `attachment; filename="${filename}"`;

    if (format === 'csv') {
      return {
        raw: {
          statusCode: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': disposition },
          body: toCsv(rows),
        },
      };
    }
    return {
      raw: {
        statusCode: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': disposition,
        },
        body: JSON.stringify({ dealId, exportedAt: new Date().toISOString(), count: rows.length, events: rows }, null, 2),
      },
    };
  },
});
