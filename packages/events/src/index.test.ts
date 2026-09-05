import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, eventSource } from './index.js';

describe('@cre/events', () => {
  it('accepts a well-formed envelope', () => {
    const parsed = eventEnvelopeSchema.parse({
      eventId: '00000000-0000-4000-8000-000000000000',
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'abc-123',
    });
    expect(parsed.correlationId).toBe('abc-123');
  });

  it('rejects a missing correlationId', () => {
    expect(() =>
      eventEnvelopeSchema.parse({
        eventId: '00000000-0000-4000-8000-000000000000',
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('builds a namespaced event source', () => {
    expect(eventSource('deals')).toBe('cre.deals');
  });
});
