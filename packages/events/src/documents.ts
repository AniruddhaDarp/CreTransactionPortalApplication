import { z } from 'zod';

const scopeSchema = z.enum([
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
]);
const categorySchema = z.enum([
  'Purchase Agreement',
  'Disclosure',
  'Inspection',
  'Title',
  'Financing',
  'Appraisal',
  'Closing',
  'Other',
]);

export const documentUploadedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  category: categorySchema,
  scope: scopeSchema,
  uploadedBy: z.string(),
});

export const documentVersionedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  n: z.number().int(),
  scope: scopeSchema,
});

export const documentPromotedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  scope: scopeSchema,
});

export const documentArchivedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  hsId: z.string(),
  scope: scopeSchema,
});

export const documentAccessedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  n: z.number().int(),
  mode: z.enum(['opened', 'downloaded']),
  by: z.string(),
  scope: scopeSchema,
});

export const documentDeleteRequestedSchema = z.object({
  dealId: z.string(),
  docId: z.string(),
  requestedBy: z.string(),
  requesterRole: z.string(),
  requesterSide: z.string(),
});

export const docrequestCreatedSchema = z.object({
  dealId: z.string(),
  reqId: z.string(),
  category: categorySchema,
  scope: scopeSchema,
  targetUserId: z.string().optional(),
  targetRole: z.string().optional(),
  createdBy: z.string(),
});

export const docrequestFulfilledSchema = z.object({
  dealId: z.string(),
  reqId: z.string(),
  fulfilledDocId: z.string(),
  scope: scopeSchema,
});

export const docrequestDeclinedSchema = z.object({
  dealId: z.string(),
  reqId: z.string(),
  reason: z.string().optional(),
  scope: scopeSchema,
});

export const docrequestCancelledSchema = z.object({
  dealId: z.string(),
  reqId: z.string(),
  scope: scopeSchema,
});

export const documentEventSchemas = {
  'document.uploaded': documentUploadedSchema,
  'document.versioned': documentVersionedSchema,
  'document.promoted': documentPromotedSchema,
  'document.archived': documentArchivedSchema,
  'document.accessed': documentAccessedSchema,
  'document.delete_requested': documentDeleteRequestedSchema,
  'docrequest.created': docrequestCreatedSchema,
  'docrequest.fulfilled': docrequestFulfilledSchema,
  'docrequest.declined': docrequestDeclinedSchema,
  'docrequest.cancelled': docrequestCancelledSchema,
} as const;

export type DocumentEventType = keyof typeof documentEventSchemas;
