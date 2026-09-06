import type { AppConfig } from './config.js';

/** Fetch JSON from the edge API with the caller's bearer token attached. */
export async function apiFetch<T>(
  cfg: AppConfig,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(cfg.apiBaseUrl + path, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-correlation-id': crypto.randomUUID(),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
