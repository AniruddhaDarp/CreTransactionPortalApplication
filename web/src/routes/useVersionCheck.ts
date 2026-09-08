import { useEffect, useState } from 'react';

/** The /assets/* URLs the running document booted with. */
function currentAssets(): Set<string> {
  const urls = new Set<string>();
  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((s) => {
    const u = s.getAttribute('src');
    if (u && u.includes('/assets/')) urls.add(u);
  });
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((l) => {
    const u = l.getAttribute('href');
    if (u && u.includes('/assets/')) urls.add(u);
  });
  return urls;
}

/** Pull the /assets/* URLs out of a freshly fetched index.html. */
function assetsFromHtml(html: string): Set<string> {
  const urls = new Set<string>();
  const re = /(?:src|href)="([^"]*\/assets\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (u) urls.add(u);
  }
  return urls;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && Array.from(a).every((x) => b.has(x));

/**
 * Polls index.html and returns true once the deployed bundle differs from the
 * one this tab is running — i.e. a new SPA build has been deployed. No-ops in
 * dev (Vite serves unhashed module scripts, so `currentAssets()` is empty).
 */
export function useVersionCheck(intervalMs = 5 * 60_000): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const booted = currentAssets();
    if (booted.size === 0) return;
    let alive = true;

    const check = async () => {
      if (!alive) return;
      try {
        const res = await fetch(`/index.html?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const latest = assetsFromHtml(await res.text());
        if (alive && latest.size > 0 && !sameSet(booted, latest)) setStale(true);
      } catch {
        /* offline / transient — retry on the next tick */
      }
    };

    const id = window.setInterval(check, intervalMs);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [intervalMs]);

  return stale;
}
