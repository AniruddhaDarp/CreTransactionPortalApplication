import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

afterEach(() => vi.restoreAllMocks());

describe('createLogger', () => {
  it('emits one JSON line with level, message and merged fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger({ correlationId: 'cid-1' }).info('hello', { dealId: 'd-1' });
    expect(spy).toHaveBeenCalledOnce();
    const payload = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({
      level: 'info',
      message: 'hello',
      correlationId: 'cid-1',
      dealId: 'd-1',
    });
  });

  it('child() merges additional bound fields', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger({ correlationId: 'cid-1' }).child({ userId: 'u-9' }).warn('careful');
    const payload = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({ correlationId: 'cid-1', userId: 'u-9', level: 'warn' });
  });

  it('routes errors to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger().error('boom');
    expect(spy).toHaveBeenCalledOnce();
  });
});
