import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, ChatThread, DealsApi } from '../deals-api.js';
import { memberInScope, roleLabel } from '../roles.js';
import { scopeTag } from '../theme.js';
import { useAsk } from './dialog.js';
import { isMembershipSyncing, SYNCING_NOTE } from './sync.js';
import { useMemberNames } from './useMemberNames.js';
import { humanizeError } from './errors.js';
import { usePoll } from './usePoll.js';
import {
  applyMention,
  collectMentions,
  filterMentionables,
  mentionLabel,
  mentionQueryAt,
  mentionToken,
  splitMentions,
  type Mentionable,
} from './mentions.js';

const SCOPES = [
  'deal_wide',
  'side_private:buy',
  'side_private:sell',
  'channel:agent',
  'channel:attorney',
];

type Receipts = Record<
  string,
  { rollup: 'sent' | 'received' | 'read'; recipients: { userId: string; deliveredAt?: string; readAt?: string }[] }
>;

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

const RCPT_GLYPH: Record<string, string> = { sent: '✓', received: '✓✓', read: '✓✓' };

/** Highlight `@Name` / `@ROLE·id` mention tokens in a posted message. */
function renderBody(body: string, labels: string[]): ReactNode[] {
  return splitMentions(body, labels).map((seg, i) =>
    seg.mention ? (
      <span key={i} className="msg__mention">
        {seg.text}
      </span>
    ) : (
      seg.text
    ),
  );
}

export function Chat({
  api,
  dealId,
  myUserId,
  dealActive,
}: {
  api: DealsApi;
  dealId: string;
  myUserId: string;
  dealActive: boolean;
}) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { label, members, names, roles } = useMemberNames(api, dealId);
  const ask = useAsk();
  const [receipts, setReceipts] = useState<Receipts>({});
  const [openRcpt, setOpenRcpt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({}); // userId -> inserted token
  const [picker, setPicker] = useState<{ query: string; start: number; sel: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadThreads = useCallback(() => {
    api
      .threads(dealId)
      .then((r) => {
        setThreads(r.threads);
        setErr(null);
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  }, [api, dealId]);

  usePoll(loadThreads, 8_000, [loadThreads]);
  useEffect(() => {
    if (!err || !isMembershipSyncing(err)) return;
    const t = setTimeout(loadThreads, 2500);
    return () => clearTimeout(t);
  }, [err, loadThreads]);

  const openThread = threads.find((t) => t.threadId === openId);

  // Only members who can actually see the open thread's scope are mentionable.
  const mentionables: Mentionable[] = members
    .filter(
      (m) =>
        m.status === 'active' && (!openThread || memberInScope(m.side, m.role, openThread.scope)),
    )
    .map((m) => ({ userId: m.userId, role: m.role, name: names[m.userId] }));
  const authorLabel = (id: string): string =>
    id === myUserId ? `You${roles[id] ? ` (${roleLabel(roles[id])})` : ''}` : label(id);

  const myRole = roles[myUserId] ?? '';
  // Either agent manages channel:agent; either attorney manages channel:attorney.
  const canManageChannel =
    dealActive &&
    !!openThread &&
    ((openThread.scope === 'channel:agent' && myRole.endsWith('_AGENT')) ||
      (openThread.scope === 'channel:attorney' && myRole.endsWith('_ATTORNEY')));

  const makeDealWide = async () => {
    if (!openThread) return;
    const ok = await ask({
      title: 'Open this channel to the whole deal?',
      body: 'Every member gains access to this thread and its history. This can’t be undone.',
      danger: true,
      confirmLabel: 'Make deal-wide',
    });
    if (ok == null) return;
    void api
      .convertThread(dealId, openThread.threadId)
      .then(() => {
        loadThreads();
        refreshMessages();
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  };

  const deleteChannel = async () => {
    if (!openThread) return;
    const ok = await ask({
      title: 'Request deletion of this channel?',
      body: 'A deal lead must approve. On approval the thread is removed for everyone (history is kept in the audit log).',
      danger: true,
      confirmLabel: 'Request delete',
    });
    if (ok == null) return;
    void api
      .deleteThread(dealId, openThread.threadId)
      .then(() => {
        setErr('Deletion requested — a deal lead must approve the handshake.');
        loadThreads();
      })
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  };

  // per-recipient receipts for the caller's own messages (author-only endpoint)
  useEffect(() => {
    if (!openId) return;
    let live = true;
    const mine = messages.filter((m) => m.authorId === myUserId && !m.system && !m.deletedAt);
    if (mine.length === 0) return;
    void Promise.all(
      mine.map((m) =>
        api
          .messageReceipts(dealId, openId, m.msgId)
          .then((r) => [m.msgId, r] as const)
          .catch(() => null),
      ),
    ).then((rows) => {
      if (!live) return;
      const add: Receipts = {};
      for (const row of rows) if (row) add[row[0]] = row[1];
      if (Object.keys(add).length) setReceipts((prev) => ({ ...prev, ...add }));
    });
    return () => {
      live = false;
    };
  }, [messages, openId, api, dealId, myUserId]);

  const refreshMessages = useCallback(() => {
    if (!openId) return;
    api
      .messages(dealId, openId)
      .then((r) => setMessages(r.messages))
      .catch(() => {});
  }, [api, dealId, openId]);

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

  const editMsg = async (m: ChatMessage) => {
    const next = await ask({
      title: 'Edit message',
      input: true,
      multiline: true,
      defaultValue: m.body,
      requireValue: true,
      confirmLabel: 'Save',
    });
    if (next == null) return;
    const t = next.trim();
    if (!t || t === m.body) return;
    void api
      .editMessage(dealId, m.threadId, m.msgId, t)
      .then(refreshMessages)
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  };
  const deleteMsg = async (m: ChatMessage) => {
    const ok = await ask({
      title: 'Delete message?',
      body: 'It will show as "message removed". The original text is kept in the audit log.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (ok == null) return;
    void api
      .deleteMessage(dealId, m.threadId, m.msgId)
      .then(refreshMessages)
      .catch((e: unknown) => setErr(humanizeError(String(e))));
  };

  const suggestions = picker
    ? filterMentionables(mentionables, picker.query)
        .filter((m) => m.userId !== myUserId)
        .slice(0, 20)
    : [];
  const anchor =
    picker && inputRef.current ? inputRef.current.getBoundingClientRect() : null;

  const onComposerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart ?? v.length;
    const q = mentionQueryAt(v, caret);
    setPicker(q ? { ...q, sel: 0 } : null);
  };

  const choose = (m: Mentionable) => {
    const el = inputRef.current;
    if (!picker || !el) return;
    const caret = el.selectionStart ?? text.length;
    const token = mentionToken(m);
    const { text: nt, caret: nc } = applyMention(text, picker.start, caret, token);
    setText(nt);
    setPicked((p) => ({ ...p, [m.userId]: token }));
    setPicker(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nc, nc);
    });
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!picker || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPicker((p) => p && { ...p, sel: (p.sel + 1) % suggestions.length });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPicker((p) => p && { ...p, sel: (p.sel - 1 + suggestions.length) % suggestions.length });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const pick = suggestions[picker.sel] ?? suggestions[0];
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPicker(null);
    }
  };

  const send = () => {
    const b = text.trim();
    if (!b || !openId) return;
    void api
      .postMessage(dealId, openId, b, collectMentions(text, picked))
      .then(() => {
        setText('');
        setPicked({});
        setPicker(null);
      })
      .catch((x: unknown) => setErr(humanizeError(String(x))));
  };

  return (
    <>
      {err &&
        (isMembershipSyncing(err) ? (
          <p className="muted">{SYNCING_NOTE}</p>
        ) : (
          <p className="error">{err}</p>
        ))}

      {!dealActive && (
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
          The deal is closed — communication is a read-only record. Threads and messages stay
          visible; nothing new can be posted or changed.
        </p>
      )}

      {dealActive && (
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
            .catch((x: unknown) => setErr(humanizeError(String(x))));
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
      )}

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
              {openThread && (
                <div className="thread-head">
                  <span className="thread-head__subject">{openThread.subject}</span>
                  <span className={scopeTag(openThread.scope).cls}>
                    {scopeTag(openThread.scope).label}
                  </span>
                  {canManageChannel && (
                    <span className="btn-row" style={{ marginLeft: 'auto' }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => void makeDealWide()}>
                        Make deal-wide
                      </button>
                      <button className="btn btn--danger btn--sm" onClick={() => void deleteChannel()}>
                        Delete channel
                      </button>
                    </span>
                  )}
                </div>
              )}
              <div className="msg-list">
                {messages.map((m) => {
                  const mine = m.authorId === myUserId;
                  const rc = receipts[m.msgId];
                  const rollup = rc?.rollup ?? 'sent';
                  return (
                    <div
                      key={m.msgId}
                      className={`msg${m.system ? ' msg--system' : mine ? ' msg--me' : ''}`}
                    >
                      {!m.system && <span className="msg__author">{authorLabel(m.authorId)}</span>}
                      {m.deletedAt ? (
                        <em className="muted">message removed</em>
                      ) : (
                        renderBody(m.body, mentionables.map(mentionLabel))
                      )}
                      {m.editedAt && !m.deletedAt && <span className="msg__edited"> (edited)</span>}

                      {!m.system && (
                        <div className="msg__foot">
                          <time className="msg__time">{fmtTs(m.createdAt)}</time>
                          {mine && !m.deletedAt && (
                            <>
                              <button
                                type="button"
                                className={`msg__rcpt is-${rollup}`}
                                onClick={() => setOpenRcpt((o) => (o === m.msgId ? null : m.msgId))}
                                title="Per-recipient delivery — click for detail"
                              >
                                {RCPT_GLYPH[rollup]} {rollup}
                              </button>
                              {dealActive && (
                                <span className="msg__actions">
                                  <button
                                    type="button"
                                    className="linkbtn"
                                    onClick={() => editMsg(m)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="linkbtn"
                                    onClick={() => deleteMsg(m)}
                                  >
                                    Delete
                                  </button>
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {mine && openRcpt === m.msgId && (
                        <ul className="rcpt-detail">
                          {(rc?.recipients ?? []).map((r) => (
                            <li key={r.userId}>
                              <span>{authorLabel(r.userId)}</span>
                              <span className="muted">
                                {r.readAt
                                  ? `read ${fmtTs(r.readAt)}`
                                  : r.deliveredAt
                                    ? `received ${fmtTs(r.deliveredAt)}`
                                    : 'sent — not yet fetched'}
                              </span>
                            </li>
                          ))}
                          {(rc?.recipients?.length ?? 0) === 0 && (
                            <li>
                              <span className="empty">No recipients at send time.</span>
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
                {messages.length === 0 && <span className="empty">No messages yet.</span>}
              </div>
              {!dealActive ? (
                <p className="muted composer" style={{ margin: 0 }}>
                  This thread is part of a closed deal — read-only.
                </p>
              ) : (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                {picker && suggestions.length > 0 && anchor && (
                  <div
                    className="mention-picker"
                    role="listbox"
                    style={{
                      left: anchor.left,
                      bottom: window.innerHeight - anchor.top + 4,
                      minWidth: anchor.width,
                    }}
                  >
                    {suggestions.map((m, i) => (
                      <button
                        key={m.userId}
                        type="button"
                        className={i === picker.sel ? 'is-sel' : ''}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          choose(m);
                        }}
                      >
                        <span>
                          {m.name ? (
                            <>
                              {m.name} <span className="mp-role">({roleLabel(m.role)})</span>
                            </>
                          ) : (
                            roleLabel(m.role)
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <input
                  ref={inputRef}
                  className="input"
                  placeholder="Write a message…  (@ to mention)"
                  value={text}
                  onChange={onComposerChange}
                  onKeyDown={onComposerKeyDown}
                  onBlur={() => setTimeout(() => setPicker(null), 120)}
                />
                <button className="btn btn--primary" type="submit">
                  Send
                </button>
              </form>
              )}
            </>
          ) : (
            <div style={{ padding: 24 }}>
              <span className="empty">Select a thread to read it.</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
