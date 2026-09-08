/**
 * Turn a raw thrown API error into a sentence a member can act on.
 *
 * Our fetch helper throws `Error: <status> : {"error":"<message>"}`; this unwraps
 * that envelope, maps the messages we raise deliberately to friendlier wording,
 * and otherwise returns the bare message with a capital first letter. Never
 * surfaces a status code or JSON to the user.
 */
export function humanizeError(raw: string): string {
  let msg = /\{"error":"([^"]+)"/.exec(raw)?.[1] ?? raw;
  if (msg === raw) {
    msg = raw
      .replace(/^Error:\s*/i, '')
      .replace(/^\d{3}\s*:\s*/, '')
      .trim();
  }

  const rules: Array<[RegExp, string]> = [
    [
      /can only post in its own side-private threads/i,
      "As a third-party contributor you can only post in your own side's private threads — not deal-wide or the other side's.",
    ],
    [
      /(not an active member of this deal|membership (may )?not (be )?synced)/i,
      'Your access to this deal is still syncing. Give it a few seconds and try again.',
    ],
    [
      /cannot see this document|outside your access/i,
      "That document is outside your access — it's in a scope or category your role can't open.",
    ],
    [
      /signer .* cannot see this document/i,
      "One of the chosen signers can't access this document, so they can't be added.",
    ],
    [/only the requester can cancel/i, 'Only the person who created this request can cancel it.'],
    [/addressed to someone else/i, "This request is addressed to someone else, so you can't act on it."],
    [/handshake .* already pending/i, 'There is already a pending request for this — approve or reject that one first.'],
    [
      /forward only|cannot move .* backwards|regress/i,
      'Milestones only move forward, one stage at a time.',
    ],
    [/deal is (closed|cancelled)/i, 'This deal is closed — it is read-only now.'],
    [/not authori[sz]ed|forbidden|permission/i, "You don't have permission to do that."],
  ];
  for (const [re, friendly] of rules) if (re.test(msg)) return friendly;

  return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : 'Something went wrong. Please try again.';
}
