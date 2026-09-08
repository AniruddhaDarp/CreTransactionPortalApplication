import { z } from 'zod';

const scopeSchema = z.enum([
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
]);

export const threadCreatedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  scope: scopeSchema,
  subject: z.string(),
});

export const threadConvertedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  toScope: scopeSchema,
  by: z.string().optional(),
  droppedUserId: z.string().optional(),
});

export const threadDeleteRequestedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  subject: z.string(),
  scope: scopeSchema,
  requestedBy: z.string(),
  requesterRole: z.string(),
  requesterSide: z.string(),
});

export const threadDeletedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  subject: z.string().optional(),
  hsId: z.string().optional(),
});

export const messagePostedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  msgId: z.string(),
  authorId: z.string(),
  scope: scopeSchema,
  mentions: z.array(z.string()),
});

export const messageEditedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  msgId: z.string(),
  scope: scopeSchema,
});

export const messageDeletedSchema = z.object({
  dealId: z.string(),
  threadId: z.string(),
  msgId: z.string(),
  scope: scopeSchema,
});

export const chatEventSchemas = {
  'thread.created': threadCreatedSchema,
  'thread.converted': threadConvertedSchema,
  'thread.delete_requested': threadDeleteRequestedSchema,
  'thread.deleted': threadDeletedSchema,
  'message.posted': messagePostedSchema,
  'message.edited': messageEditedSchema,
  'message.deleted': messageDeletedSchema,
} as const;

export type ChatEventType = keyof typeof chatEventSchemas;
