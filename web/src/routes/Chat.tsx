import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatThread, DealsApi, FeedItem } from '../deals-api.js';
import { scopeTag } from '../theme.js';

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
    <>
      {err && <p className="error">{err}</p>}

      <form
        className="form-inline"
        style={{ marginBottom: 14 }}
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
        <label className="field" style={{ flex: 1, minWidth: 180 }}>
          <span>New thread</span>
          <input className="input" name="subject" placeholder="Subject" required />
        </label>
        <label className="field">
          <span>Visibility</span>
          <select className="select" name="scope">
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {scopeTag(s).label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit">
          Start thread
        </button>
      </form>

      <div className="chat">
        <div className="thread-rail">
          {threads.length === 0 && (
            <div style={{ padding: 12 }}>
              <span className="empty">No threads yet.</span>
            </div>
          )}
          {threads.map((t) => {
            const s = scopeTag(t.scope);
            return (
              <button
                key={t.threadId}
                className={`thread${t.threadId === openId ? ' is-active' : ''}`}
                onClick={() => setOpenId(t.threadId)}
              >
                <span className="thread__subject">{t.subject}</span>
                <span className={s.cls}>{s.label}</span>
              </button>
            );
          })}
        </div>

        <div className="chat__main">
          {openId ? (
            <>
              <div className="msg-list">
                {messages.map((m) => (
                  <div
                    key={m.msgId}
                    className={`msg${m.system ? ' msg--system' : m.authorId === myUserId ? ' msg--me' : ''}`}
                  >
                    {!m.system && (
                      <span className="msg__author">
                        {m.authorId === myUserId ? 'You' : m.authorId.slice(0, 6)}
                      </span>
                    )}
                    {m.deletedAt ? <em className="muted">message removed</em> : m.body}
                    {m.editedAt && !m.deletedAt && <span className="msg__edited"> (edited)</span>}
                  </div>
                ))}
                {messages.length === 0 && <span className="empty">No messages yet.</span>}
              </div>
              <form
                className="composer"
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
                <input ref={draft} className="input" placeholder="Write a message…" />
                <button className="btn btn--primary" type="submit">
                  Send
                </button>
              </form>
            </>
          ) : (
            <div style={{ padding: 24 }}>
              <span className="empty">Select a thread to read it.</span>
            </div>
          )}
        </div>
      </div>

      <h4>Activity</h4>
      <ul className="feed">
        {feed.map((f, i) => (
          <li key={i}>
            <time>{f.createdAt.slice(0, 16).replace('T', ' ')}</time>
            <span>{f.summary}</span>
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
