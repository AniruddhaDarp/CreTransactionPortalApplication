import { describe, expect, it, vi } from 'vitest';
import { log } from './index.js';

describe('@cre/platform log', () => {
  it('emits a single JSON line with the message and fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('hello', { correlationId: 'cid-1', dealId: 'd-1' });
    expect(spy).toHaveBeenCalledOnce();
    const payload = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({ level: 'info', message: 'hello', correlationId: 'cid-1' });
    spy.mockRestore();
  });

  it('routes errors to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('boom');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
