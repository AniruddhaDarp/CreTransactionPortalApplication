/** Presentation helpers — pure, no React. */

/** Apply the viewer's stored light/dark preference (called once before render). */
export function applyStoredTheme(): void {
  try {
    const t = localStorage.getItem('cre-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch {
    /* private mode / disabled storage — fall back to the OS preference */
  }
}

/** Toggle light/dark, persist, and return the new value. */
export function toggleTheme(): 'light' | 'dark' {
  const root = document.documentElement;
  const current =
    root.getAttribute('data-theme') ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('cre-theme', next);
  } catch {
    /* ignore */
  }
  return next;
}

/** A short label + tint class for a thread / document / audit visibility scope. */
export function scopeTag(scope: string): { label: string; cls: string } {
  switch (scope) {
    case 'deal_wide':
      return { label: 'deal-wide', cls: 'tag tag--dealwide' };
    case 'side_private:buy':
      return { label: 'buy-side', cls: 'tag tag--buy' };
    case 'side_private:sell':
      return { label: 'sell-side', cls: 'tag tag--sell' };
    case 'channel:agent':
      return { label: 'agent channel', cls: 'tag tag--chan' };
    case 'channel:attorney':
      return { label: 'attorney channel', cls: 'tag tag--chan' };
    default:
      return { label: scope, cls: 'tag' };
  }
}

/** Pill modifier for a deal lifecycle status. */
export function statusPill(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'pill pill--info';
    case 'CLOSED':
      return 'pill pill--ok';
    case 'CANCELLED':
      return 'pill pill--danger';
    default:
      return 'pill';
  }
}
