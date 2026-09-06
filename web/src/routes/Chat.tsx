import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatThread, DealsApi, FeedItem } from '../deals-api.js';

const SCOPES = [
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
];

export function Chat({ api, dealId, myUserId }: { api: DealsApi; dealId: string; myUserId: string }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const draft = useRef<HTMLInputElement>(null);

  const loadThreads = useCallback(() => {
    api
      .threads(dealId)
      .then((r) => setThreads(r.threads))
      .catch((e: unknown) => setErr(String(e)));
    api
      .activity(dealId)
      .then((r) => setFeed(r.activity))
      .catch(() => {});
  }, [api, dealId]);

  useEffect(loadThreads, [loadThreads]);
  useEffect(() => {
    const t = setInterval(loadThreads, 15_000);
    return () => clearInterval(t);
  }, [loadThreads]);

  // fast-poll the open thread
  useEffect(() => {
    if (!openId) return;
    let live = true;
    const pull = () =>
      api
        .messages(dealId, openId)
        .then((r) => live && setMessages(r.messages))
        .catch(() => {});
    pull();
    void api.markThreadRead(dealId, openId).catch(() => {});
    const t = setInterval(pull, 4_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, dealId, openId]);

  return (
    <section>
      <h3>Communication</h3>
      {err && <p style={{ color: '#b00' }}>{err}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          void api
            .createThread(dealId, {
              subject: String(d.get('subject') ?? ''),
              scope: String(d.get('scope') ?? 'deal_wide'),
            })
            .then(loadThreads)
            .catch((x: unknown) => setErr(String(x)));
          e.currentTarget.reset();
        }}
      >
        <input name="subject" placeholder="New thread subject" required />{' '}
        <select name="scope">
          {SCOPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>{' '}
        <button type="submit">Start thread</button>
      </form>

      <div style={{ display: 'flex', gap: '1.5rem', marginTop: '1rem' }}>
        <ul style={{ listStyle: 'none', paddingLeft: 0, minWidth: 180 }}>
          {threads.map((t) => (
            <li key={t.threadId}>
              <button
                onClick={() => setOpenId(t.threadId)}
                style={{ fontWeight: t.threadId === openId ? 700 : 400 }}
              >
                {t.subject}
              </button>
              <br />
              <small>{t.scope}</small>
            </li>
          ))}
        </ul>

        <div style={{ flex: 1 }}>
          {openId ? (
            <>
              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #ccc', padding: 8 }}>
                {messages.map((m) => (
                  <p key={m.msgId} style={{ margin: '4px 0', fontStyle: m.system ? 'italic' : undefined }}>
                    <strong>{m.authorId === myUserId ? 'you' : m.authorId.slice(0, 6)}:</strong>{' '}
                    {m.body}
                    {m.editedAt ? ' (edited)' : ''}
                  </p>
                ))}
                {messages.length === 0 && <p>No messages yet.</p>}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = draft.current?.value.trim();
                  if (!body) return;
                  void api
                    .postMessage(dealId, openId, body)
                    .then(() => {
                      if (draft.current) draft.current.value = '';
                    })
                    .catch((x: unknown) => setErr(String(x)));
                }}
              >
                <input ref={draft} placeholder="Message…" style={{ width: '80%' }} />{' '}
                <button type="submit">Send</button>
              </form>
            </>
          ) : (
            <p>Select a thread.</p>
          )}
        </div>
      </div>

      <h4>Activity</h4>
      <ul>
        {feed.map((f, i) => (
          <li key={i}>
            <small>{f.createdAt.slice(0, 16).replace('T', ' ')}</small> — {f.summary}
          </li>
        ))}
        {feed.length === 0 && <li>Nothing yet.</li>}
      </ul>
    </section>
  );
}
