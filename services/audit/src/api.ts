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

    // Scope + attribute filtering happens *after* the DynamoDB read, so a page
    // can shrink to nothing — keep paging the partition until we have `limit`
    // visible rows or run out (bounded by SCAN_CAP for a pathological viewer
    // whose scopes match almost nothing). The cursor we return points exactly
    // after the last row we hand back, not at a DynamoDB page boundary.
    const SCAN_CAP = 4000;
    const BATCH = 200;
    const gathered: AuditRow[] = [];
    let cursor = ctx.query.cursor;
    let scanned = 0;
    let exhausted = false;
    while (gathered.length < limit && scanned < SCAN_CAP) {
      const page = await repo.queryDeal(dealId, {
        from: filters.from,
        to: filters.to,
        cursor,
        limit: BATCH,
      });
      scanned += page.rows.length;
      for (const row of scopedRows(page.rows, viewer, filters)) {
        gathered.push(row);
        if (gathered.length >= limit) break;
      }
      cursor = page.nextCursor;
      if (!cursor) {
        exhausted = true;
        break;
      }
    }

    const events = gathered.slice(0, limit);
    const last = events[events.length - 1];
    // Hand back a cursor whenever more rows could follow the last one returned:
    // the page filled, or we bailed on the safety cap before running dry.
    const maybeMore = events.length === limit || (events.length > 0 && !exhausted && scanned >= SCAN_CAP);
    const nextCursor = maybeMore && last ? repo.rowCursor(last) : undefined;

    return {
      body: {
        events,
        nextCursor,
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
