import { can, canSeeDocument, type Role, type Side } from '@cre/authz';
import { getMemberView, HttpError, parseBody, type RouteHandler } from '@cre/platform';
import { z } from 'zod';
import { getProvider, type ProviderRecipient } from './provider/index.js';
import * as repo from './repo.js';
import { requireViewer, scopeMember } from './scope.js';
import { authzCtx, emit, param } from './shared.js';

const s3 = () => import('./s3.js');

const createSchema = z.object({
  signerUserIds: z.array(z.string().min(1)).min(1).max(10),
  subject: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
  routing: z.enum(['parallel', 'sequential']).default('parallel'),
  /** userId -> { email, name }; required in docusign mode, ignored by the fake provider. */
  contacts: z.record(z.string(), z.object({ email: z.string().email(), name: z.string().min(1) })).optional(),
});
const signSchema = z.object({ decline: z.boolean().optional(), reason: z.string().max(500).optional() });
const voidSchema = z.object({ reason: z.string().max(500).optional() });

async function loadVisibleDoc(dealId: string, docId: string, userId: string) {
  const viewer = await requireViewer(dealId, userId);
  const doc = await repo.getDocument(dealId, docId);
  if (!doc || doc.archivedAt) throw new HttpError(404, 'document not found');
  if (!canSeeDocument(scopeMember(viewer), doc.scope, doc.category)) {
    throw new HttpError(403, 'you cannot see this document');
  }
  return { viewer, doc };
}

/** Fetch + store the signed PDF as a new version, then flip the envelope to completed. */
async function completeEnvelope(
  env: repo.SignatureEnvelope,
  doc: repo.DocumentRow,
  correlationId: string,
  actorId: string,
): Promise<number | null> {
  const n = doc.currentVersion + 1;
  const claimed = await repo.setEnvelopeStatus(env.dealId, doc.docId, env.envId, {
    status: 'completed',
    signedVersion: n,
  });
  if (!claimed) return null; // another request already completed it

  const recipients = await repo.listRecipients(env.dealId, env.envId);
  const sourceVersion = await repo.getVersion(env.dealId, doc.docId, env.version);
  const filename = sourceVersion?.filename ?? `${doc.title}.pdf`;
  const signed = await getProvider().getSignedPdf({
    providerEnvelopeId: env.providerEnvelopeId,
    envId: env.envId,
    docId: doc.docId,
    filename,
    title: doc.title,
    signerUserIds: recipients.map((r) => r.userId),
  });

  const { s3Key, putObject } = await s3();
  const key = s3Key(env.dealId, doc.docId, n, signed.filename);
  await putObject(key, signed.bytes, signed.contentType);
  await repo.addVersion({
    dealId: env.dealId,
    docId: doc.docId,
    n,
    s3Key: key,
    filename: signed.filename,
    contentType: signed.contentType,
    uploadedBy: actorId,
    uploadedAt: new Date().toISOString(),
    note: `Signed via ${env.provider} envelope ${env.envId}`,
  });
  await emit(env.dealId, correlationId, actorId, [
    { type: 'document.versioned', detail: { dealId: env.dealId, docId: doc.docId, n, scope: doc.scope } },
    {
      type: 'signature.completed',
      detail: { dealId: env.dealId, docId: doc.docId, envId: env.envId, signedVersion: n, scope: doc.scope },
    },
  ]);
  return n;
}

/** Real-mode reconciliation: ask the provider, no webhook. No-op for the fake provider. */
async function reconcile(
  env: repo.SignatureEnvelope,
  doc: repo.DocumentRow,
  correlationId: string,
  actorId: string,
): Promise<void> {
  if (env.status !== 'sent') return;
  const remote = await getProvider().getStatus(env.providerEnvelopeId);
  if (!remote) return;
  if (remote.status === 'completed') {
    await completeEnvelope(env, doc, correlationId, actorId);
  } else if (remote.status === 'declined' || remote.status === 'voided') {
    const ok = await repo.setEnvelopeStatus(env.dealId, doc.docId, env.envId, { status: remote.status });
    if (ok) {
      await emit(env.dealId, correlationId, actorId, [
        remote.status === 'declined'
          ? {
              type: 'signature.declined',
              detail: {
                dealId: env.dealId,
                docId: doc.docId,
                envId: env.envId,
                scope: doc.scope,
                createdBy: env.createdBy,
              },
            }
          : {
              type: 'signature.voided',
              detail: { dealId: env.dealId, docId: doc.docId, envId: env.envId, scope: doc.scope },
            },
      ]);
    }
  }
}

export const signatureRoutes: Record<string, RouteHandler> = {
  'POST /v1/deals/{dealId}/documents/{docId}/signature': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const docId = param(ctx, 'docId');
    const { viewer, doc } = await loadVisibleDoc(dealId, docId, ctx.userId);
    if (!can('sendForSignature', authzCtx(viewer))) {
      throw new HttpError(403, 'this role cannot send documents for signature');
    }
    const input = parseBody(createSchema, ctx.body ?? {});
    const signerIds = [...new Set(input.signerUserIds)];

    // every signer must be an active member who can see this document
    for (const uid of signerIds) {
      const mv = await getMemberView(repo.tableName(), dealId, uid);
      if (!mv || mv.status !== 'active') {
        throw new HttpError(400, `signer ${uid} is not an active member of this deal`);
      }
      if (!canSeeDocument({ role: mv.role as Role, side: mv.side as Side, status: 'active' }, doc.scope, doc.category)) {
        throw new HttpError(400, `signer ${uid} cannot see this document`);
      }
    }

    const provider = getProvider();
    const envId = crypto.randomUUID();
    const now = new Date().toISOString();
    const subject = input.subject ?? `Signature requested: ${doc.title}`;
    const version = await repo.getVersion(dealId, docId, doc.currentVersion);
    const filename = version?.filename ?? `${doc.title}.pdf`;

    const recipients: repo.SignatureRecipient[] = signerIds.map((uid, i) => ({
      dealId,
      envId,
      userId: uid,
      email: input.contacts?.[uid]?.email,
      name: input.contacts?.[uid]?.name,
      routingOrder: input.routing === 'sequential' ? i + 1 : 1,
      status: 'sent',
    }));
    const providerRecipients: ProviderRecipient[] = recipients.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      routingOrder: r.routingOrder,
    }));

    let documentBytes: Uint8Array | undefined;
    if (provider.name === 'docusign' && version) {
      const { getObjectBytes } = await s3();
      documentBytes = await getObjectBytes(version.s3Key);
    }

    const created = await provider.createEnvelope({
      envId,
      dealId,
      docId,
      subject,
      message: input.message,
      filename,
      title: doc.title,
      documentBytes,
      recipients: providerRecipients,
    });

    const env: repo.SignatureEnvelope = {
      dealId,
      docId,
      envId,
      version: doc.currentVersion,
      scope: doc.scope,
      provider: provider.name,
      providerEnvelopeId: created.providerEnvelopeId,
      subject,
      message: input.message,
      status: 'sent',
      createdBy: ctx.userId,
      createdAt: now,
    };
    await repo.createEnvelope(env, recipients);
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'signature.requested',
        detail: {
          dealId,
          docId,
          envId,
          version: doc.currentVersion,
          scope: doc.scope,
          provider: provider.name,
          recipientUserIds: signerIds,
          createdBy: ctx.userId,
        },
      },
    ]);
    return { status: 201, body: { ...env, recipients } };
  },

  'GET /v1/deals/{dealId}/documents/{docId}/signature': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const docId = param(ctx, 'docId');
    const { doc } = await loadVisibleDoc(dealId, docId, ctx.userId);
    const envs = await repo.listEnvelopesForDoc(dealId, docId);
    for (const env of envs) {
      await reconcile(env, doc, ctx.correlationId, ctx.userId).catch(() => undefined);
    }
    const fresh = await repo.listEnvelopesForDoc(dealId, docId);
    const withRecipients = await Promise.all(
      fresh.map(async (env) => ({ ...env, recipients: await repo.listRecipients(dealId, env.envId) })),
    );
    return { body: { envelopes: withRecipients } };
  },

  'POST /v1/deals/{dealId}/documents/{docId}/signature/{envId}/sign': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const docId = param(ctx, 'docId');
    const envId = param(ctx, 'envId');
    if (getProvider().name !== 'fake') {
      throw new HttpError(409, 'in docusign mode, signing happens on the DocuSign platform');
    }
    const { doc } = await loadVisibleDoc(dealId, docId, ctx.userId);
    const env = await repo.getEnvelope(dealId, docId, envId);
    if (!env) throw new HttpError(404, 'signature request not found');
    if (env.status !== 'sent') throw new HttpError(409, `this signature request is already ${env.status}`);
    const mine = (await repo.listRecipients(dealId, envId)).find((r) => r.userId === ctx.userId);
    if (!mine) throw new HttpError(403, 'you are not a signer on this request');
    if (mine.status !== 'sent') throw new HttpError(409, `you have already ${mine.status} this request`);

    const input = parseBody(signSchema, ctx.body ?? {});

    if (input.decline) {
      await repo.setRecipientOutcome(dealId, envId, ctx.userId, 'declined', input.reason);
      await repo.setEnvelopeStatus(dealId, docId, envId, { status: 'declined', declineReason: input.reason });
      await emit(dealId, ctx.correlationId, ctx.userId, [
        {
          type: 'signature.declined',
          detail: {
            dealId,
            docId,
            envId,
            userId: ctx.userId,
            reason: input.reason,
            scope: doc.scope,
            createdBy: env.createdBy,
          },
        },
      ]);
      return { body: { status: 'declined' } };
    }

    const ok = await repo.setRecipientOutcome(dealId, envId, ctx.userId, 'completed');
    if (!ok) throw new HttpError(409, 'you have already signed this request');
    await emit(dealId, ctx.correlationId, ctx.userId, [
      {
        type: 'signature.recipient_completed',
        detail: { dealId, docId, envId, userId: ctx.userId, scope: doc.scope },
      },
    ]);

    const remaining = (await repo.listRecipients(dealId, envId)).filter((r) => r.status === 'sent');
    if (remaining.length === 0) {
      const n = await completeEnvelope(env, doc, ctx.correlationId, ctx.userId);
      return { body: { status: 'completed', signedVersion: n } };
    }
    return { body: { status: 'recipient_completed', remaining: remaining.length } };
  },

  'POST /v1/deals/{dealId}/documents/{docId}/signature/{envId}/void': async (ctx) => {
    const dealId = param(ctx, 'dealId');
    const docId = param(ctx, 'docId');
    const envId = param(ctx, 'envId');
    const { viewer, doc } = await loadVisibleDoc(dealId, docId, ctx.userId);
    const env = await repo.getEnvelope(dealId, docId, envId);
    if (!env) throw new HttpError(404, 'signature request not found');
    if (env.status !== 'sent') throw new HttpError(409, `this signature request is already ${env.status}`);
    if (env.createdBy !== ctx.userId && !can('deleteDocument', authzCtx(viewer))) {
      throw new HttpError(403, 'only the requester or a deal lead may void this signature request');
    }
    const { reason } = parseBody(voidSchema, ctx.body ?? {});
    await getProvider().void(env.providerEnvelopeId, reason ?? '');
    const ok = await repo.setEnvelopeStatus(dealId, docId, envId, { status: 'voided', voidReason: reason });
    if (!ok) throw new HttpError(409, 'this signature request is no longer open');
    await emit(dealId, ctx.correlationId, ctx.userId, [
      { type: 'signature.voided', detail: { dealId, docId, envId, reason, scope: doc.scope } },
    ]);
    return { body: { status: 'voided' } };
  },
};
