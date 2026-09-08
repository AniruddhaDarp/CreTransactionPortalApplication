import { useEffect, useMemo, useState } from 'react';
import type { DealsApi, Member } from '../deals-api.js';
import { roleLabel } from '../roles.js';

/**
 * Resolve a deal's member userIds to human labels — `Name (ROLE)`, or just the
 * role when a member hasn't set a profile name. Never surfaces a raw id.
 * Names come from the Accounts `/v1/profiles` batch lookup (best-effort).
 */
export function useMemberNames(api: DealsApi, dealId: string) {
  const [members, setMembers] = useState<Member[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    api
      .members(dealId)
      .then(async (r) => {
        if (!live) return;
        setMembers(r.members);
        try {
          const p = await api.profiles(r.members.map((m) => m.userId));
          if (live) setNames(Object.fromEntries(p.profiles.map((x) => [x.userId, x.name])));
        } catch {
          /* names are best-effort */
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, dealId]);

  const roles = useMemo(
    () => Object.fromEntries(members.map((m) => [m.userId, m.role])),
    [members],
  );

  /** `Name (Role)` · `Role` · `Member` — pass `{ role: false }` for the bare name. */
  const label = (userId: string, opts?: { role?: boolean }): string => {
    const nm = names[userId];
    const role = roles[userId];
    if (nm) return opts?.role === false || !role ? nm : `${nm} (${roleLabel(role)})`;
    return roleLabel(role) || 'Member';
  };

  return { label, members, names, roles };
}
