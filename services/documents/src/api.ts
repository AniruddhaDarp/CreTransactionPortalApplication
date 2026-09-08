import {
  can,
  canSee,
  canSeeDocument,
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type Scope,
} from '@cre/authz';
import { HttpError, parseBody, router, type RequestContext, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import * as repo from './repo.js';
import { requireViewer, scopeMember } from './scope.js';
import { assertDealActive, authzCtx, emit, param } from './shared.js';
import { signatureRoutes } from './signatures.js';

const categoryEnum = z.enum(
  DOCUMENT_CATEGORIES as unknown as readonly [DocumentCategory, ...DocumentCategory[]],
);
const uploadScopeEnum = z.enum(['deal_wide', 'side_private:buy', 'side_private:sell']);

const newDocSchema = z.object({
  category: categoryEnum,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  scope: uploadScopeEnum,
  stageTag: z.number().int().min(1).max(6).optional(),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
});
const newVersionSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
});
const newRequestSchema = z
  .object({
    category: categoryEnum,
    note: z.string().max(1000).optional(),
    targetUserId: z.string().max(80).optional(),
    targetRole: z.string().max(40).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    stageTag: z.number().int().min(1).max(6).optional(),
    scope: uploadScopeEnum,
  })
  .refine((v) => Boolean(v.targetUserId) || Boolean(v.targetRole), {
    message: 'a document request needs a targetUserId or a targetRole',
  });

/** Who may write to a given scope: deal-wide → any non-OTHER; side-private → members of that side. */
function assertCanWriteScope(v: ReturnType<typeof scopeMember> & { userId?: string }, scope: Scope) {
  if (scope === 'deal_wide') {
    if (v.role === 'OTHER') throw new HttpError(403, 'this role cannot upload deal-wide');
    return;
  }
  const side = scope === 'side_private:buy' ? 'buy' : 'sell';
  if (v.side !== side) throw new HttpError(403, `only ${side}-side members can write here`);
}

const s3 = () => import('./s3.js');

const documentRoutes: Record<string, RouteHandler> = {
  'GET /v1/deals/{dealId}/documents': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    const m = scopeMember(viewer);
    const docs = (await repo.listDocuments(dealId)).filter(
      (d) => !d.archivedAt && canSeeDocument(m, d.scope, d.category),
    );
    return { body: { documents: docs } };
  },

  'POST /v1/deals/{dealId}/documents': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const input = parseBody(newDocSchema, ctx.body ?? {});
    assertCanWriteScope(scopeMember(viewer), input.scope);

    const docId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { s3Key, presignPut } = await s3();
    const key = s3Key(dealId, docId, 1, input.filename);
    await repo.createDocument(
      {
        dealId,
        docId,
        category: input.category,
        title: input.title,
        description: input.description,
        scope: input.scope,
        stageTag: input.stageTag,
        currentVersion: 1,
        versionCount: 1,
        uploadedBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      },
      {
        dealId,
        docId,
        n: 1,
        s3Key: key,
        filename: input.filename,
        contentType: input.contentType,
        uploadedBy: ctx.userId,
        uploadedAt: now,
      },
    );
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'document.uploaded',
        detail: { dealId, docId, category: input.category, scope: input.scope, uploadedBy: ctx.userId },
      },
    ]);
    return { status: 201, body: { docId, version: 1, uploadUrl: await presignPut(key, input.contentType) } };
  },

  'GET /v1/deals/{dealId}/documents/{docId}': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    const doc = await repo.getDocument(dealId, param(ctx, 'docId'));
    if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
    if (!canSeeDocument(scopeMember(viewer), doc.scope, doc.category)) {
      throw new HttpError(403, 'you cannot see this document');
    }
    return { body: { ...doc, versions: await repo.listVersions(dealId, doc.docId) } };
  },

  'POST /v1/deals/{dealId}/documents/{docId}/versions': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const doc = await repo.getDocument(dealId, param(ctx, 'docId'));
    if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
    assertCanWriteScope(scopeMember(viewer), doc.scope);
    const input = parseBody(newVersionSchema, ctx.body ?? {});
    const n = doc.currentVersion + 1;
    const { s3Key, presignPut } = await s3();
    const key = s3Key(dealId, doc.docId, n, input.filename);
    await repo.addVersion({
      dealId,
      docId: doc.docId,
      n,
      s3Key: key,
      filename: input.filename,
      contentType: input.contentType,
      uploadedBy: ctx.userId,
      uploadedAt: new Date().toISOString(),
      note: input.note,
    });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'document.versioned', detail: { dealId, docId: doc.docId, n, scope: doc.scope } },
    ]);
    return { status: 201, body: { version: n, uploadUrl: await presignPut(key, input.contentType) } };
  },

  'GET /v1/deals/{dealId}/documents/{docId}/versions/{n}/download': async (ctx) =>
    access(ctx, 'downloaded'),
  'GET /v1/deals/{dealId}/documents/{docId}/versions/{n}/view': async (ctx) => access(ctx, 'opened'),

  'POST /v1/deals/{dealId}/documents/{docId}/promote': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const doc = await repo.getDocument(dealId, param(ctx, 'docId'));
    if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
    if (doc.scope === 'deal_wide') throw new HttpError(409, 'document is already deal-wide');
    const side = doc.scope === 'side_private:buy' ? 'buy' : 'sell';
    if (viewer.side !== side || !can('promoteDocument', authzCtx(viewer))) {
      throw new HttpError(403, `only a ${side}-side member (not OTHER) can promote this document`);
    }
    const updated = await repo.promoteDocument(dealId, doc.docId);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'document.promoted', detail: { dealId, docId: doc.docId, scope: 'deal_wide' } },
    ]);
    return { body: updated };
  },

  'DELETE /v1/deals/{dealId}/documents/{docId}': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const doc = await repo.getDocument(dealId, param(ctx, 'docId'));
    if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
    if (!can('deleteDocument', authzCtx(viewer))) {
      throw new HttpError(403, 'only the admin or a buy-side lead may request a document deletion');
    }
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'document.delete_requested',
        detail: {
          dealId,
          docId: doc.docId,
          scope: doc.scope,
          category: doc.category,
          title: doc.title,
          requestedBy: ctx.userId,
          requesterRole: viewer.role,
          requesterSide: viewer.side,
        },
      },
    ]);
    return { status: 202, body: { status: 'delete_requested' } };
  },

  'GET /v1/deals/{dealId}/doc-requests': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    const m = scopeMember(viewer);
    const reqs = (await repo.listDocRequests(dealId)).filter(
      (r) =>
        canSee(m, r.scope) ||
        r.createdBy === ctx.userId ||
        r.targetUserId === ctx.userId ||
        r.targetRole === viewer.role,
    );
    return { body: { requests: reqs } };
  },

  'POST /v1/deals/{dealId}/doc-requests': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    if (!can('createDocRequest', authzCtx(viewer))) {
      throw new HttpError(403, 'not allowed to create document requests');
    }
    const input = parseBody(newRequestSchema, ctx.body ?? {});
    assertCanWriteScope(scopeMember(viewer), input.scope);
    const reqId = crypto.randomUUID();
    await repo.putDocRequest({
      dealId,
      reqId,
      category: input.category,
      note: input.note,
      targetUserId: input.targetUserId,
      targetRole: input.targetRole,
      dueDate: input.dueDate,
      stageTag: input.stageTag,
      scope: input.scope,
      status: 'open',
      createdBy: ctx.userId,
      createdAt: new Date().toISOString(),
    });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'docrequest.created',
        detail: {
          dealId,
          reqId,
          category: input.category,
          scope: input.scope,
          targetUserId: input.targetUserId,
          targetRole: input.targetRole,
          createdBy: ctx.userId,
        },
      },
    ]);
    return { status: 201, body: { reqId } };
  },

  'POST /v1/deals/{dealId}/doc-requests/{reqId}/fulfill': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const req = await requireOpenRequest(dealId, param(ctx, 'reqId'), viewer, ctx.userId);
    const { docId } = parseBody(z.object({ docId: z.string().min(1) }), ctx.body ?? {});
    const doc = await repo.getDocument(dealId, docId);
    if (!doc) throw new HttpError(400, 'the fulfilling document does not exist');
    await repo.resolveDocRequest(dealId, req.reqId, { status: 'fulfilled', fulfilledDocId: docId });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'docrequest.fulfilled',
        detail: { dealId, reqId: req.reqId, fulfilledDocId: docId, scope: req.scope, createdBy: req.createdBy },
      },
    ]);
    return { body: { status: 'fulfilled' } };
  },

  'POST /v1/deals/{dealId}/doc-requests/{reqId}/decline': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const viewer = await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const req = await requireOpenRequest(dealId, param(ctx, 'reqId'), viewer, ctx.userId);
    const { reason } = parseBody(z.object({ reason: z.string().max(500).optional() }), ctx.body ?? {});
    await repo.resolveDocRequest(dealId, req.reqId, { status: 'declined', declineReason: reason });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'docrequest.declined',
        detail: { dealId, reqId: req.reqId, reason, scope: req.scope, createdBy: req.createdBy },
      },
    ]);
    return { body: { status: 'declined' } };
  },

  'POST /v1/deals/{dealId}/doc-requests/{reqId}/cancel': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    await requireViewer(dealId, ctx.userId);
    await assertDealActive(dealId);
    const req = await repo.getDocRequest(dealId, param(ctx, 'reqId'));
    if (!req || req.status !== 'open') throw new HttpError(404, 'no open request with that id');
    if (req.createdBy !== ctx.userId) throw new HttpError(403, 'only the requester can cancel');
    await repo.resolveDocRequest(dealId, req.reqId, { status: 'cancelled' });
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'docrequest.cancelled', detail: { dealId, reqId: req.reqId, scope: req.scope } },
    ]);
    return { body: { status: 'cancelled' } };
  },
};

export const handler = router({ ...documentRoutes, ...signatureRoutes });

async function access(ctx: RequestContext, mode: 'opened' | 'downloaded') {
  const dealId = param(ctx, 'dealId');
  const viewer = await requireViewer(dealId, ctx.userId);
  const doc = await repo.getDocument(dealId, param(ctx, 'docId'));
  if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
  if (!canSeeDocument(scopeMember(viewer), doc.scope, doc.category)) {
    throw new HttpError(403, 'you cannot access this document');
  }
  const n = Number(param(ctx, 'n'));
  const version = await repo.getVersion(dealId, doc.docId, n);
  if (!version) throw new HttpError(404, 'version not found');
  const { presignGet } = await s3();
  const url = await presignGet(version.s3Key, {
    download: mode === 'downloaded',
    filename: version.filename,
  });
  await emit(dealId, ctx.correlationId, ctx.userId, [
    {
      type: 'document.accessed',
      detail: { dealId, docId: doc.docId, n, mode, by: ctx.userId, scope: doc.scope },
    },
  ]);
  return { body: { url, filename: version.filename } };
}

async function requireOpenRequest(
  dealId: string,
  reqId: string,
  viewer: { role: string; userId: string },
  userId: string,
) {
  const req = await repo.getDocRequest(dealId, reqId);
  if (!req || req.status !== 'open') throw new HttpError(404, 'no open request with that id');
  const isTarget =
    (req.targetUserId && req.targetUserId === userId) ||
    (req.targetRole && req.targetRole === viewer.role);
  if (!isTarget) throw new HttpError(403, 'this request is addressed to someone else');
  return req;
}
