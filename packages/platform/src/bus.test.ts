import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publish, setBusClient } from './bus.js';

const eb = mockClient(EventBridgeClient);

beforeEach(() => {
  eb.reset();
  setBusClient(eb as unknown as EventBridgeClient);
});
afterEach(() => setBusClient(undefined));

describe('publish', () => {
  it('is a no-op for an empty list', async () => {
    await publish('cre-portal-bus', []);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it('envelopes each event with source, detail-type and metadata', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    await publish('cre-portal-bus', [
      {
        service: 'accounts',
        type: 'account.created',
        correlationId: 'cid-1',
        actorId: 'u-1',
        detail: { userId: 'u-1', email: 'a@example.com' },
      },
    ]);
    const call = eb.commandCalls(PutEventsCommand)[0]!;
    const entry = call.args[0].input.Entries![0]!;
    expect(entry.EventBusName).toBe('cre-portal-bus');
    expect(entry.Source).toBe('cre.accounts');
    expect(entry.DetailType).toBe('account.created');
    const detail = JSON.parse(entry.Detail!);
    expect(detail).toMatchObject({ correlationId: 'cid-1', actorId: 'u-1', detail: { userId: 'u-1' } });
    expect(detail.eventId).toMatch(/[0-9a-f-]{36}/);
    expect(detail.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('batches more than 10 entries into multiple PutEvents calls', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    const events = Array.from({ length: 23 }, (_, i) => ({
      service: 'deals',
      type: 'member.joined',
      correlationId: `cid-${i}`,
      detail: { i },
    }));
    await publish('cre-portal-bus', events);
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(3); // 10 + 10 + 3
  });

  it('throws when EventBridge reports failed entries', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1 });
    await expect(
      publish('cre-portal-bus', [
        { service: 'accounts', type: 'account.created', correlationId: 'x', detail: {} },
      ]),
    ).rejects.toThrow(/failed/);
  });
});
