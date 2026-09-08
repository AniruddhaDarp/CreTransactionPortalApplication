/**
 * The Chat / Documents / Audit services each keep their own membership
 * projection, fed asynchronously off `member.joined`. For a few seconds after
 * someone joins a deal (or creates one), those endpoints return a 403
 * "membership may not be synced yet". It is transient and self-heals — the
 * panels detect it, show a soft "setting up" note instead of an error banner,
 * and retry quickly until it clears.
 */
export function isMembershipSyncing(err: unknown): boolean {
  return /may not be synced yet/i.test(String(err));
}

export const SYNCING_NOTE = 'Setting up your access to this deal — one moment…';
