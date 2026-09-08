import { useCallback, useState } from 'react';
import type { DealsApi, FeedItem } from '../deals-api.js';
import { humanizeError } from './errors.js';
import { useMemberNames } from './useMemberNames.js';
import { usePoll } from './usePoll.js';

const fmtTs = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** The deal's activity feed — member joins, stage advances, handshake outcomes,
 *  uploads, status changes — scoped server-side to what the caller may see. */
export function Activity({ api, dealId }: { api: DealsApi; dealId: string }) {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { label } = useMemberNames(api, dealId);

  const load = useCallback(() => {
    api
      .activity(dealId)
      .then((r) => {
        setFeed(r.activity);
        setErr(null);
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  }, [api, dealId]);

  usePoll(load, 12_000, [load]);

  return (
    <>
      {err && <p className="error">{err}</p>}
      <ul className="feed">
        {feed.map((f, i) => (
          <li key={i}>
            <time>{fmtTs(f.createdAt)}</time>
            <span>{f.summary}</span>
            {f.actorId && (
              <span className="muted" style={{ fontSize: 12 }}>
                — {label(f.actorId)}
              </span>
            )}
          </li>
        ))}
        {feed.length === 0 && (
          <li>
            <span className="empty">Nothing yet.</span>
          </li>
        )}
      </ul>
    </>
  );
}
