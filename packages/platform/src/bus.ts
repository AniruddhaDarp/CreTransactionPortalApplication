import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from '@aws-sdk/client-eventbridge';
import { eventSource } from '@cre/events';

/** A domain event to publish, before enveloping. */
export interface DomainEvent<T = Record<string, unknown>> {
  /** Owning service, e.g. `accounts` — becomes `source: "cre.accounts"`. */
  service: string;
  /** Event name, e.g. `account.created` — becomes `detail-type`. */
  type: string;
  correlationId: string;
  dealId?: string;
  actorId?: string;
  detail: T;
}

let cached: EventBridgeClient | undefined;

function client(): EventBridgeClient {
  if (!cached) cached = new EventBridgeClient({});
  return cached;
}

/** Test seam. */
export function setBusClient(c: EventBridgeClient | undefined): void {
  cached = c;
}

const MAX_ENTRIES_PER_CALL = 10;

/** Publish one or more domain events, each wrapped in the @cre/events envelope. */
export async function publish(busName: string, events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;

  const entries: PutEventsRequestEntry[] = events.map((e) => ({
    EventBusName: busName,
    Source: eventSource(e.service),
    DetailType: e.type,
    Detail: JSON.stringify({
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: e.correlationId,
      dealId: e.dealId,
      actorId: e.actorId,
      detail: e.detail,
    }),
  }));

  for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_CALL) {
    const batch = entries.slice(i, i + MAX_ENTRIES_PER_CALL);
    const res = await client().send(new PutEventsCommand({ Entries: batch }));
    if (res.FailedEntryCount && res.FailedEntryCount > 0) {
      throw new Error(`EventBridge PutEvents: ${res.FailedEntryCount}/${batch.length} entries failed`);
    }
  }
}
