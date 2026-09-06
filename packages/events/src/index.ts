import { z } from 'zod';

/**
 * @cre/events — the cross-service contract.
 *
 * Every domain event published to the `cre-portal-bus` EventBridge bus is wrapped
 * in this envelope. Per-service event `detail` schemas are added alongside each
 * service as it is built (Modules 4–9).
 */

export const EVENT_SOURCE_PREFIX = 'cre';

/** Fields present on every event, regardless of type. */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1),
  dealId: z.string().optional(),
  actorId: z.string().optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** `source` field for events emitted by a given service. */
export function eventSource(service: string): string {
  return `${EVENT_SOURCE_PREFIX}.${service}`;
}

export * from './deals.js';
export * from './chat.js';
