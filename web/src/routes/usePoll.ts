import { useEffect } from 'react';

/**
 * Poll `fn`: once immediately, then every `ms`, plus an instant re-run whenever
 * the tab regains focus / becomes visible. Interval ticks are skipped while the
 * tab is hidden so a backgrounded window isn't hammering the API.
 *
 * `deps` behaves like a `useEffect` dependency array — pass the memoised `fn`.
 */
export function usePoll(fn: () => void, ms: number, deps: readonly unknown[]): void {
  useEffect(() => {
    fn();
    const tick = () => {
      if (!document.hidden) fn();
    };
    const now = () => fn();
    const id = window.setInterval(tick, ms);
    window.addEventListener('focus', now);
    document.addEventListener('visibilitychange', now);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', now);
      document.removeEventListener('visibilitychange', now);
    };
  }, deps);
}
