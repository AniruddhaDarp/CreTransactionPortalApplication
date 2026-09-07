import { z } from 'zod';

/** `detail` payload schemas for events published by the Deals service. */

export const roleSchema = z.enum([
  'SELLER_AGENT',
  'SELLER',
  'SELLER_ATTORNEY',
  'BUYER',
  'BUYER_AGENT',
  'BUYER_ATTORNEY',
  'LENDER',
  'TITLE_AGENT',
  'OTHER',
]);
export const sideSchema = z.enum(['buy', 'sell', 'neutral']);
export const dealStatusSchema = z.enum(['ACTIVE', 'CLOSED', 'CANCELLED']);

export const dealCreatedSchema = z.object({
  dealId: z.string(),
  createdBy: z.string(),
  address: z.string(),
  propertyType: z.string(),
});

export const dealUpdatedSchema = z.object({
  dealId: z.string(),
  changed: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});

export const dealStatusChangedSchema = z.object({
  dealId: z.string(),
  status: dealStatusSchema,
  reason: z.string().optional(),
});

export const memberInvitedSchema = z.object({
  dealId: z.string(),
  email: z.string(),
  role: roleSchema,
  side: sideSchema,
  invitedBy: z.string(),
  token: z.string(),
});

export const memberJoinedSchema = z.object({
  dealId: z.string(),
  userId: z.string(),
  role: roleSchema,
  side: sideSchema,
});

export const memberRoleChangedSchema = z.object({
  dealId: z.string(),
  userId: z.string(),
  from: roleSchema,
  to: roleSchema,
});

export const memberRemovedSchema = z.object({
  dealId: z.string(),
  userId: z.string(),
  removedBy: z.string(),
});

// --- milestones + handshakes (Module 5) ---------------------------------

const changeMap = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));

export const stageAdvancedSchema = z.object({
  dealId: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  firmNow: z.boolean(),
});

export const stageUpdatedSchema = z.object({
  dealId: z.string(),
  n: z.number().int(),
  changed: changeMap,
});

export const handshakeRequestedSchema = z.object({
  dealId: z.string(),
  hsId: z.string(),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  initiatedBy: z.string(),
  initiatedSide: sideSchema,
  approverIds: z.array(z.string()),
});

export const handshakeApprovedSchema = z.object({
  dealId: z.string(),
  hsId: z.string(),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  initiatedBy: z.string(),
  initiatedSide: sideSchema,
});

export const handshakeRejectedSchema = z.object({
  dealId: z.string(),
  hsId: z.string(),
  reason: z.string().optional(),
  initiatedBy: z.string(),
  initiatedSide: sideSchema,
});

export const checklistItemAddedSchema = z.object({
  dealId: z.string(),
  n: z.number().int(),
  itemId: z.string(),
  title: z.string(),
});

export const checklistItemToggledSchema = z.object({
  dealId: z.string(),
  n: z.number().int(),
  itemId: z.string(),
  done: z.boolean(),
});

export const checklistItemRemovedSchema = z.object({
  dealId: z.string(),
  n: z.number().int(),
  itemId: z.string(),
});

// --- payments (Module 11, stretch) ------------------------------------

export const paymentRecordedSchema = z.object({
  dealId: z.string(),
  payId: z.string(),
  kind: z.string(),
  amount: z.number(),
  method: z.string(),
  payer: z.string(),
  payee: z.string(),
  recordedBy: z.string(),
  scope: z.string(),
});

export const paymentConfirmedSchema = z.object({
  dealId: z.string(),
  payId: z.string(),
  kind: z.string(),
  amount: z.number(),
  confirmedBy: z.string(),
});

export const paymentVoidedSchema = z.object({
  dealId: z.string(),
  payId: z.string(),
  reason: z.string().optional(),
});

/** Registry: `detail-type` -> schema, for producer/consumer contract tests. */
export const dealEventSchemas = {
  'deal.created': dealCreatedSchema,
  'deal.updated': dealUpdatedSchema,
  'deal.status_changed': dealStatusChangedSchema,
  'member.invited': memberInvitedSchema,
  'member.joined': memberJoinedSchema,
  'member.role_changed': memberRoleChangedSchema,
  'member.removed': memberRemovedSchema,
  'stage.advanced': stageAdvancedSchema,
  'stage.updated': stageUpdatedSchema,
  'handshake.requested': handshakeRequestedSchema,
  'handshake.approved': handshakeApprovedSchema,
  'handshake.rejected': handshakeRejectedSchema,
  'checklist.item_added': checklistItemAddedSchema,
  'checklist.item_toggled': checklistItemToggledSchema,
  'checklist.item_removed': checklistItemRemovedSchema,
  'payment.recorded': paymentRecordedSchema,
  'payment.confirmed': paymentConfirmedSchema,
  'payment.voided': paymentVoidedSchema,
} as const;

export type DealEventType = keyof typeof dealEventSchemas;
