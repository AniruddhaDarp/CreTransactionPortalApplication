import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('./repo.js');
vi.mock('./handshake.js');
vi.mock('./shared.js', () => ({ emit: vi.fn() }));

import * as handshake from './handshake.js';
import * as repo from './repo.js';
import { emit } from './shared.js';
import { handler } from './consumer.js';
import type { DealMeta } from './repo.js';

const deal = (over: Partial<DealMeta> = {}): DealMeta => ({
  dealId: 'd1',
  address: '1 Market St',
  propertyType: 'office',
  price: 1_000_000,
  status: 'ACTIVE',
  currentStage: 3,
  firm: true,
  createdBy: 'admin',
  createdAt: 't',
  updatedAt: 't',
  ...over,
});

function sqs(records: Array<{ type: string; env: Record<string, unknown> }>) {
  return {
    Records: records.map((r, i) => ({
      messageId: `msg-${i}`,
      body: JSON.stringify({ 'detail-type': r.type, detail: r.env }),
    })),
  } as never;
}
const env = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: 'c1',
  dealId: 'd1',
  actorId: 'buyer1',
  detail: {},
  ...over,
});
const invoke = (e: never) => handler(e, {} as never, () => {});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deals delete-saga consumer', () => {
  it('document.delete_requested opens a handshake and publishes the requested event', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.listHandshakes).mockResolvedValue([]);
    vi.mocked(handshake.initiate).mockResolvedValue({
      hs: { hsId: 'hs1' } as never,
      event: { type: 'handshake.requested', detail: { hsId: 'hs1' } },
    });

    await invoke(
      sqs([
        {
          type: 'document.delete_requested',
          env: env({
            detail: {
              docId: 'doc1',
              requestedBy: 'buyer1',
              requesterRole: 'BUYER',
              requesterSide: 'buy',
            },
          }),
        },
      ]) as never,
    );

    expect(handshake.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete_document', payload: { docId: 'doc1' }, actorId: 'buyer1' }),
    );
    expect(emit).toHaveBeenCalledWith('d1', 'c1', 'buyer1', [
      { type: 'handshake.requested', detail: { hsId: 'hs1' } },
    ]);
  });

  it('is idempotent: a redelivered delete request with an open handshake is a no-op', async () => {
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.listHandshakes).mockResolvedValue([
      { action: 'delete_document', status: 'pending', payload: { docId: 'doc1' } } as never,
    ]);

    await invoke(
      sqs([
        {
          type: 'document.delete_requested',
          env: env({
            detail: {
              docId: 'doc1',
              requestedBy: 'buyer1',
              requesterRole: 'BUYER',
              requesterSide: 'buy',
            },
          }),
        },
      ]) as never,
    );

    expect(handshake.initiate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('document.archived closes the saga on the handshake', async () => {
    vi.mocked(repo.completeHandshakeSaga).mockResolvedValue();
    await invoke(
      sqs([{ type: 'document.archived', env: env({ detail: { docId: 'doc1', hsId: 'hs1' } }) }]) as never,
    );
    expect(repo.completeHandshakeSaga).toHaveBeenCalledWith('d1', 'hs1');
  });

  it('drops (does not retry) a permanent HttpError from handshake.initiate', async () => {
    const { HttpError } = await vi.importActual<typeof import('@cre/platform')>('@cre/platform');
    vi.mocked(repo.getDeal).mockResolvedValue(deal());
    vi.mocked(repo.listHandshakes).mockResolvedValue([]);
    vi.mocked(handshake.initiate).mockRejectedValue(new HttpError(403, 'not allowed'));

    const res = (await invoke(
      sqs([
        {
          type: 'document.delete_requested',
          env: env({
            detail: {
              docId: 'doc1',
              requestedBy: 'nobody',
              requesterRole: 'LENDER',
              requesterSide: 'buy',
            },
          }),
        },
      ]) as never,
    )) as { batchItemFailures: unknown[] };
    expect(res.batchItemFailures).toHaveLength(0);
  });

  it('retries an unexpected (non-HttpError) failure', async () => {
    vi.mocked(repo.getDeal).mockRejectedValue(new Error('ddb down'));
    const res = (await invoke(
      sqs([
        {
          type: 'document.delete_requested',
          env: env({
            detail: {
              docId: 'doc1',
              requestedBy: 'buyer1',
              requesterRole: 'BUYER',
              requesterSide: 'buy',
            },
          }),
        },
      ]) as never,
    )) as { batchItemFailures: Array<{ itemIdentifier: string }> };
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['msg-0']);
  });
});
