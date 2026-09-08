/**
 * @-mention helpers for the chat composer. The Chat service takes an explicit
 * `mentions: string[]` of member userIds on `POST …/messages` (it does not parse
 * the body), so the composer tracks the picked userId alongside the literal
 * token text it inserted, and sends the ones whose token still survives in the
 * message.
 */

/** A member as offered in the picker. */
export interface Mentionable {
  userId: string;
  role: string;
  name?: string;
}

import { roleLabel } from '../roles.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The visible label for a member — `Name (Role)`, or just the role when they have no profile name. */
export function mentionLabel(m: Mentionable): string {
  const n = m.name?.trim();
  return n ? `${n} (${roleLabel(m.role)})` : roleLabel(m.role);
}

/** The literal text inserted into the composer for a picked member. */
export const mentionToken = (m: Mentionable): string => `@${mentionLabel(m)}`;

/**
 * If the caret sits at the end of an `@query` fragment (start of input or after
 * whitespace), return `{ query, start }` where `start` is the index of the `@`.
 * Otherwise `null` — the picker is closed.
 */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\w-]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { query, start: caret - query.length - 1 };
}

/** Members matching `query` against name, role, or the short id (case-insensitive). */
export function filterMentionables(members: Mentionable[], query: string): Mentionable[] {
  const q = query.toLowerCase();
  if (!q) return members;
  return members.filter(
    (m) =>
      (m.name?.toLowerCase().includes(q) ?? false) ||
      m.role.toLowerCase().includes(q) ||
      m.userId.slice(0, 6).toLowerCase().startsWith(q),
  );
}

/** Replace the `@query` fragment at `[start, caret)` with `token`, adding a
 *  trailing space only when the text doesn't already have one. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  token: string,
): { text: string; caret: number } {
  const rest = text.slice(caret);
  const t = token + (rest.startsWith(' ') ? '' : ' ');
  const next = text.slice(0, start) + t + rest;
  return { text: next, caret: start + t.length };
}

/** The userIds among `picked` (userId -> inserted token) whose token still appears in the text. */
export function collectMentions(text: string, picked: Record<string, string>): string[] {
  return Object.entries(picked)
    .filter(([, token]) => text.includes(token))
    .map(([userId]) => userId);
}

/**
 * Split `body` into plain strings and `{ mention: true }` markers so a message
 * can highlight its `@Name` / `@ROLE·id` tokens. `labels` is the set of known
 * mention labels (member names, mainly); anything else falls back to `@word`.
 */
export function splitMentions(body: string, labels: string[]): Array<{ text: string; mention: boolean }> {
  const named = [...new Set(labels.filter(Boolean))]
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length);
  const alt = named.length ? `${named.join('|')}|[\\w-]{2,}(?:·[\\w-]+)?` : `[\\w-]{2,}(?:·[\\w-]+)?`;
  const re = new RegExp(`(@(?:${alt}))`, 'g');
  return body
    .split(re)
    .filter((s) => s !== '')
    .map((s) => ({ text: s, mention: /^@/.test(s) }));
}
